import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { loadConfig, newRequestId } from "../../../packages/shared/src/index";
import { Store } from "./db/store";
import { logger } from "./logger";
import { bootstrapAdmin } from "./auth/users";
import { Store as _S } from "./db/store";
import { handleTunnelSocket } from "./tunnels/handler";
import { handlePublicRequest, handlePublicUpgrade, SYSTEM_PREFIXES } from "./gateway/router";
import { handleAuth } from "./api/auth";
import { handleApi } from "./api/resources";
import { handleAdmin } from "./api/admin";
import { buildOpenApi } from "./api/openapi";
import { sendJson, sendError, clientIp } from "./http";
import { landingPage, loginPage, registerPage, dashboardPage, adminPage } from "./web/pages";
import { docsPage } from "./web/docs";
import { recoverAfterRestart, startSweeper } from "./sweeper";
import { RateLimiter } from "./middleware/ratelimit";

void _S;

export interface Started {
  port: number;
  close: () => Promise<void>;
  store: Store;
  cfg: ReturnType<typeof loadConfig>;
}

export async function start(): Promise<Started> {
  const cfg = loadConfig();
  const store = await Store.open(cfg.dataDir, cfg.dataFile);
  recoverAfterRestart(store);
  await bootstrapAdmin(store, cfg);
  startSweeper(store, cfg);

  const authLimiter = new RateLimiter(cfg.rateAuthPerMin);
  const apiLimiter = new RateLimiter(cfg.rateApiPerMin);
  const publicLimiter = new RateLimiter(cfg.ratePublicPerMin);
  const tunnelConnLimiter = new RateLimiter(Math.max(cfg.rateAuthPerMin, 30));
  setInterval(() => {
    authLimiter.sweep();
    apiLimiter.sweep();
    publicLimiter.sweep();
    tunnelConnLimiter.sweep();
  }, 60_000).unref?.();

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      const code = ((e as { code?: string }).code ?? "INTERNAL_ERROR") as Parameters<typeof sendError>[1];
      if (!res.headersSent) {
        if (code === "INTERNAL_ERROR") logger.error("request failed", { err: String((e as Error).stack || e) });
        sendError(res, code, code === "INTERNAL_ERROR" && cfg.nodeEnv === "production" ? "Internal error." : (e as Error).message);
      } else {
        try {
          res.end();
        } catch {
          undefined;
        }
      }
    });
  });

  const tunnelWss = new WebSocketServer({ noServer: true });
  const publicWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "/";
    const pathname = url.split("?")[0];
    const ip = clientIp(req as IncomingMessage, cfg.trustProxy);
    if (pathname === "/tunnel") {
      // Connection-establishment rate limit per IP (abuse control for the control plane).
      const retry = tunnelConnLimiter.check(`conn:${ip}`);
      if (retry > 0) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        socket.destroy();
        return;
      }
      tunnelWss.handleUpgrade(req, socket, head, (ws) => {
        handleTunnelSocket(ws, { store, cfg }, ip);
      });
      return;
    }
    const { Socket } = require("node:net") as typeof import("node:net");
    handlePublicUpgrade(req as IncomingMessage, socket as InstanceType<typeof Socket>, head, { store, cfg }, publicWss);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = newRequestId();
    const method = (req.method || "GET").toUpperCase();
    const rawUrl = req.url || "/";
    const [pathnameRaw, queryRaw] = rawUrl.split("?");
    const query = new URLSearchParams(queryRaw || "");
    let pathname = pathnameRaw;
    try {
      pathname = decodeURI(pathnameRaw);
    } catch {
      sendError(res, "BAD_REQUEST", "Undecodable path.", undefined, requestId);
      return;
    }
    const first = pathname.split("/").filter(Boolean)[0]?.toLowerCase() || "";

    // 1. Observability (public, no secrets).
    if (method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "tmin", uptimeSeconds: Math.floor(process.uptime()) }, requestId);
      return;
    }
    if (method === "GET" && pathname === "/ready") {
      sendJson(res, 200, { ready: true, users: store.db.users.length, maintenance: store.db.settings.maintenanceMode }, requestId);
      return;
    }
    // 2. WebSocket control plane is upgrade-only.
    if (pathname === "/tunnel") {
      sendError(res, "BAD_REQUEST", "Use a WebSocket client at /tunnel.", undefined, requestId);
      return;
    }
    // 3. API.
    if (pathname.startsWith("/api/")) {
      const ip = clientIp(req, cfg.trustProxy);
      const isAuth = pathname.startsWith("/api/v1/auth/");
      const retry = isAuth ? authLimiter.check(`auth:${ip}`) : apiLimiter.check(`api:${ip}`);
      if (retry > 0) {
        res.setHeader("retry-after", String(retry));
        sendError(res, "RATE_LIMITED", "Too many requests. Slow down.", undefined, requestId);
        return;
      }
      if (await handleAuth(req, res, store, cfg, pathname, requestId)) return;
      if (await handleApi(req, res, store, cfg, pathname, query, requestId)) return;
      if (await handleAdmin(req, res, store, cfg, pathname, query, requestId)) return;
      if (method === "GET" && pathname === "/api/v1/openapi.json") {
        sendJson(res, 200, buildOpenApi(cfg.publicBaseUrl), requestId);
        return;
      }
      sendError(res, "NOT_FOUND", "Unknown API endpoint.", undefined, requestId);
      return;
    }
    if (method === "GET" && pathname === "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildOpenApi(cfg.publicBaseUrl), null, 2));
      return;
    }
    // 4. Web UI + docs.
    if (method === "GET" && pathname === "/") {
      return void res.end(landingPage(cfg.publicBaseUrl));
    }
    if (method === "GET" && pathname === "/login") return void res.end(loginPage());
    if (method === "GET" && pathname === "/register") return void res.end(registerPage());
    if (method === "GET" && pathname === "/dashboard") return void res.end(dashboardPage());
    if (method === "GET" && pathname === "/admin") return void res.end(adminPage());
    if (method === "GET" && (pathname === "/docs" || pathname.startsWith("/docs/"))) return void res.end(docsPage());
    // 5. Reserved/system paths never forward to tunnels.
    if (SYSTEM_PREFIXES.has(first)) {
      sendError(res, "NOT_FOUND", "Not found.", undefined, requestId);
      return;
    }
    // 6. Public gateway (tunnel traffic) with its own rate budget.
    const ip = clientIp(req, cfg.trustProxy);
    const retry = publicLimiter.check(`pub:${ip}`);
    if (retry > 0) {
      res.setHeader("retry-after", String(retry));
      sendError(res, "RATE_LIMITED", "Too many requests. Slow down.", undefined, requestId);
      return;
    }
    await handlePublicRequest(req, res, { store, cfg });
  }

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port;
  logger.info(`tmin listening on :${port}`, { base: cfg.publicBaseUrl });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const c of tunnelWss.clients) {
      try {
        c.terminate();
      } catch {
        undefined;
      }
    }
    for (const c of publicWss.clients) {
      try {
        c.terminate();
      } catch {
        undefined;
      }
    }
    const { allLive } = await import("./tunnels/registry");
    for (const t of allLive()) {
      try {
        t.ws.terminate();
      } catch {
        undefined;
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  };

  const shutdown = (sig: string) => {
    logger.info(`shutdown (${sig}): draining`, {});
    server.close(() => {
      void (async () => {
        // Ask tunnels to drain, then force-close after the drain window.
        const { allLive } = await import("./tunnels/registry");
        for (const t of allLive()) {
          try {
            t.ws.send(JSON.stringify({ type: "shutdown", reason: "Server restarting.", reconnectMs: 3000 }));
          } catch {
            undefined;
          }
        }
        setTimeout(() => {
          for (const t of allLive()) {
            try {
              t.ws.close(1001, "shutdown");
            } catch {
              undefined;
            }
          }
          void store.close().finally(() => process.exit(0));
        }, cfg.shutdownDrainMs).unref?.();
      })();
    });
    // If nothing open, close() callback may never fire — exit path:
    setTimeout(() => {
      void store.close().finally(() => process.exit(0));
    }, cfg.shutdownDrainMs + 2000).unref?.();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { port, close, store, cfg };
}

export async function main(): Promise<void> {
  await start();
}

// istanbul ignore if — normal binary entry:
if (require.main === module) {
  main().catch((e) => {
    logger.error("fatal", { err: String((e as Error).stack || e) });
    process.exit(1);
  });
}
