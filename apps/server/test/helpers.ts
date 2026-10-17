/** Integration harness: boots a real server on an ephemeral port with an isolated store. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import WebSocket from "ws";

const SRC = "../src/index.js";

export interface TestServer {
  port: number;
  base: string;
  close: () => Promise<void>;
  store: import("../src/db/store").Store;
  /** Flush hot usage counters (uses the server's own module instance). */
  flush: () => void;
}

const savedEnv = { ...process.env };

export async function boot(overrides: Record<string, string> = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "tmin-test-"));
  Object.assign(process.env, {
    NODE_ENV: "test",
    PORT: "0",
    DATA_DIR: dir,
    DATA_FILE: "t.json",
    SESSION_SECRET: "test-secret-0123456789-abcdef-test",
    PUBLIC_DOMAIN: "127.0.0.1",
    PUBLIC_BASE_URL: "http://127.0.0.1:9",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "Adminpass1!",
    ADMIN_EMAIL: "admin@example.com",
    LOG_LEVEL: "error",
    ANON_CLEANUP_INTERVAL_MS: "300",
    ...overrides,
  });
  // Fresh module registry per boot (isolated live-tunnel registry + hot usage).
  for (const k of Object.keys(require.cache)) {
    if (k.includes("tmin-test-") || k.endsWith("dist/apps/server/src/index.js") || k.includes("apps/server/src") || k.includes("apps\\server\\src")) {
      delete require.cache[k];
    }
  }
  const mod = require(SRC) as typeof import("../src/index");
  const started = await mod.start();
  // Fix base URL to the real port for public-URL assertions.
  started.cfg.publicBaseUrl = `http://127.0.0.1:${started.port}`;
  const usageMod = require("../src/usage.js") as typeof import("../src/usage");
  return {
    port: started.port,
    base: `http://127.0.0.1:${started.port}`,
    store: started.store,
    flush: () => usageMod.flushUsage(started.store),
    close: async () => {
      await started.close();
      process.env = { ...savedEnv };
    },
  };
}

export async function http(
  base: string,
  method: string,
  path: string,
  opts: { body?: string | Buffer; headers?: Record<string, string>; cookie?: string; token?: string } = {},
): Promise<{ status: number; headers: Record<string, string>; body: Buffer; json: unknown }> {
  const u = new URL(path, base);
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-length"] = String(Buffer.byteLength(opts.body));
  const chunks: Buffer[] = [];
  const { status, headers: rh } = await new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
    const r = httpRequest(u, { method, headers }, (res) => {
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) h[k] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        resolve({ status: res.statusCode || 0, headers: h });
      });
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
  const body = Buffer.concat(chunks);
  let json: unknown = null;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    undefined;
  }
  return { status, headers: rh, body, json };
}

export const post = (base: string, path: string, body: unknown, opts: { cookie?: string; token?: string } = {}) =>
  http(base, "POST", path, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, ...opts });

/** Register+login, returns cookie + user. */
export async function mkUser(base: string, username: string, password = "Password1!"): Promise<{ cookie: string; user: { id: string; username: string } }> {
  const email = `${username}@example.com`;
  const reg = await post(base, "/api/v1/auth/register", { username, email, password });
  if (reg.status !== 201) throw new Error(`register ${username}: ${reg.status} ${reg.body.toString()}`);
  const loginRes = await new Promise<{ cookie: string }>((resolve, reject) => {
    const u = new URL("/api/v1/auth/login", base);
    const r = httpRequest(u, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0] }));
    });
    r.on("error", reject);
    r.write(JSON.stringify({ login: username, password }));
    r.end();
  });
  return { cookie: loginRes.cookie, user: (reg.json as { user: { id: string; username: string } }).user };
}

export async function mkToken(base: string, cookie: string, name = "t"): Promise<string> {
  const r = await post(base, "/api/v1/tokens", { name }, { cookie });
  if (r.status !== 201) throw new Error(`token: ${r.status}`);
  return (r.json as { secret: string }).secret;
}

/** Minimal tunnel client speaking the real protocol (mirrors CLI forwarding). */
export class TunnelClient {
  ws: WebSocket;
  registered: Promise<{ tunnelId: string; routePath: string; publicUrl: string; expiresAt: number | null; resumeToken?: string }>;
  private bodies = new Map<string, { method: string; path: string; headers: Record<string, string>; wsUpgrade: boolean; chunks: Buffer[] }>();
  private localWs = new Map<string, WebSocket>();
  private wsQueues = new Map<string, { frames: Array<{ data: Buffer; binary: boolean }>; bytes: number }>();
  lastError: { code: string; message: string } | null = null;

  constructor(
    private base: string,
    private targetPort: number,
    opts: { token?: string; anonymous?: boolean; resumeToken?: string; slot?: number },
  ) {
    const wsUrl = base.replace(/^http/, "ws") + "/tunnel";
    this.ws = new WebSocket(wsUrl);
    this.registered = new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const fail = (e: unknown) => done(() => reject(e instanceof Error ? e : new Error(String(e))));
      const REFUSALS = new Set([
        "TUNNEL_LIMIT_REACHED", "QUOTA_EXCEEDED_UPLOAD", "QUOTA_EXCEEDED_DOWNLOAD",
        "BAD_REQUEST", "ANON_EXPIRED", "ANON_LIMIT_REACHED",
      ]);
      this.ws.on("open", () => {
        this.ws.send(JSON.stringify({
          type: "hello",
          protocolVersion: 1,
          auth: opts.anonymous
            ? opts.resumeToken
              ? { mode: "anonymous", resumeToken: opts.resumeToken }
              : { mode: "anonymous" }
            : { mode: "token", token: opts.token },
          clientVersion: "test/0.1.0",
        }));
      });
      this.ws.on("message", (raw) => {
        let f: { type: string } & Record<string, unknown>;
        try {
          f = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (f.type === "welcome") {
          this.ws.send(JSON.stringify({ type: "register", slot: opts.slot ?? 1, localPort: this.targetPort }));
        } else if (f.type === "registered") {
          done(() => resolve(f as unknown as { tunnelId: string; routePath: string; publicUrl: string; expiresAt: number | null; resumeToken?: string }));
        } else if (f.type === "error") {
          this.lastError = { code: String(f.code), message: String(f.message) };
          if (f.fatal || REFUSALS.has(String(f.code))) fail(new Error(`${f.code}: ${f.message}`));
        } else if (f.type === "request_head") {
          const head = { method: String(f.method), path: String(f.path), headers: (f.headers || {}) as Record<string, string>, wsUpgrade: !!(f as { wsUpgrade?: boolean }).wsUpgrade };
          if (head.wsUpgrade) {
            void this.forward(String(f.requestId), { ...head, chunks: [] });
          } else {
            this.bodies.set(String(f.requestId), { ...head, chunks: [] });
          }
        } else if (f.type === "request_chunk") {
          const b = this.bodies.get(String(f.requestId));
          if (b) {
            b.chunks.push(Buffer.from(String(f.data), "base64"));
            if (f.last) {
              this.bodies.delete(String(f.requestId));
              void this.forward(String(f.requestId), b);
            }
          }
        } else if (f.type === "ws_frame") {
          const lw = this.localWs.get(String(f.requestId));
          if (!lw) return;
          const buf = Buffer.from(String(f.data), "base64");
          if (lw.readyState === 1) {
            lw.send(buf, { binary: !!f.binary });
          } else if (lw.readyState === 0) {
            const q = this.wsQueues.get(String(f.requestId)) ?? { frames: [], bytes: 0 };
            if (q.bytes + buf.length <= 1024 * 1024 && q.frames.length < 256) {
              q.frames.push({ data: buf, binary: !!f.binary });
              q.bytes += buf.length;
              this.wsQueues.set(String(f.requestId), q);
            }
          }
        } else if (f.type === "ws_close") {
          const lw = this.localWs.get(String(f.requestId));
          this.localWs.delete(String(f.requestId));
          this.wsQueues.delete(String(f.requestId));
          try {
            lw?.close(Number(f.code) || 1000);
          } catch {
            undefined;
          }
        } else if (f.type === "heartbeat") {
          this.ws.send(JSON.stringify({ type: "heartbeat", at: Date.now() }));
        }
      });
      this.ws.on("error", fail);
      setTimeout(() => fail(new Error("tunnel register timeout")), 8000).unref?.();
    });
  }

  private async forward(requestId: string, b: { method: string; path: string; headers: Record<string, string>; wsUpgrade: boolean; chunks: Buffer[] }): Promise<void> {
    const send = (o: unknown) => {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
    };
    if (b.wsUpgrade || (b.headers["upgrade"] || "").toLowerCase() === "websocket") {
      // WS upgrade: bridge to local ws server.
      const lw = new WebSocket(`ws://127.0.0.1:${this.targetPort}${b.path}`);
      this.localWs.set(requestId, lw);
      lw.on("open", () => {
        send({ type: "ws_opened", requestId });
        const q = this.wsQueues.get(requestId);
        if (q) {
          this.wsQueues.delete(requestId);
          for (const f of q.frames) {
            if (lw.readyState !== 1) break;
            lw.send(f.data, { binary: f.binary });
          }
        }
      });
      lw.on("message", (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        send({ type: "ws_frame", requestId, data: buf.toString("base64"), binary: !!isBinary });
      });
      lw.on("close", (code) => {
        this.localWs.delete(requestId);
        this.wsQueues.delete(requestId);
        send({ type: "ws_closed", requestId, code });
      });
      lw.on("error", () => {
        this.localWs.delete(requestId);
        this.wsQueues.delete(requestId);
        try {
          lw.close(1011);
        } catch {
          undefined;
        }
        send({ type: "ws_closed", requestId, code: 1011 });
      });
      return;
    }
    const headers = { ...b.headers };
    const body = Buffer.concat(b.chunks);
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    headers["content-length"] = String(body.length);
    await new Promise<void>((resolve) => {
      const r = httpRequest({ host: "127.0.0.1", port: this.targetPort, path: b.path, method: b.method, headers, timeout: 20_000 }, (res) => {
        const oh: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined || k.toLowerCase() === "transfer-encoding") continue;
          oh[k] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        send({ type: "response_head", requestId, status: res.statusCode || 200, headers: oh });
        res.on("data", (c: Buffer) => {
          for (let off = 0; off < c.length; off += 48 * 1024) {
            send({ type: "response_chunk", requestId, data: c.subarray(off, off + 48 * 1024).toString("base64") });
          }
        });
        res.on("end", () => {
          send({ type: "response_end", requestId });
          resolve();
        });
      });
      r.on("timeout", () => {
        r.destroy();
        send({ type: "response_error", requestId, code: "GATEWAY_TIMEOUT", message: "local timeout" });
        resolve();
      });
      r.on("error", () => {
        send({ type: "response_error", requestId, code: "UPSTREAM_UNAVAILABLE", message: "local unavailable" });
        resolve();
      });
      if (body.length) r.write(body);
      r.end();
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      undefined;
    }
  }
}

/** Local test application: echo, status codes, streams, slow endpoint, WS echo. */
export async function startTarget(): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocket.Server({ noServer: true });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url || "/", "http://x");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (u.pathname === "/echo") {
        res.writeHead(200, { "content-type": "application/json", "x-echo": "1", "set-cookie": "sid=abc; Path=/" });
        res.end(JSON.stringify({
          method: req.method,
          path: u.pathname + u.search,
          body: body.toString("utf8"),
          xTest: req.headers["x-test"] || null,
          xfProto: req.headers["x-forwarded-proto"] || null,
          xff: req.headers["x-forwarded-for"] || null,
        }));
      } else if (u.pathname.startsWith("/status/")) {
        const code = Number(u.pathname.split("/")[2]) || 200;
        res.writeHead(code, { "content-type": "text/plain" });
        res.end(`status ${code}`);
      } else if (u.pathname === "/stream") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(64 * 1024, "s");
        for (let i = 0; i < 32; i++) res.write(chunk); // 2 MB streamed
        res.end();
      } else if (u.pathname === "/upload") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: body.length }));
      } else if (u.pathname === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("slow");
        }, 3000).unref?.();
      } else if (u.pathname === "/redirect") {
        res.writeHead(302, { location: "/echo?from=redirect" });
        res.end();
      } else {
        res.writeHead(404);
        res.end("nope");
      }
    });
  });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (m) => ws.send(m));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Access internal singletons of the most recently booted server (same module cache). */
export function internals(): {
  registry: typeof import("../src/tunnels/registry");
  usage: typeof import("../src/usage");
  sweeper: typeof import("../src/sweeper");
} {
  return {
    registry: require("../src/tunnels/registry.js") as typeof import("../src/tunnels/registry"),
    usage: require("../src/usage.js") as typeof import("../src/usage"),
    sweeper: require("../src/sweeper.js") as typeof import("../src/sweeper"),
  };
}
