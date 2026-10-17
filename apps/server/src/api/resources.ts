import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord, str, newRequestId, type AppConfig } from "../../../../packages/shared/src/index";
import type { Store } from "../db/store";
import { sendJson, sendError, readJsonBody, clientIp } from "../http";
import { resolveAuth, requireUser } from "../auth/context";
import { publicUser } from "../auth/users";
import { newBearerToken, sha256Hex } from "../auth/secrets";
import { audit } from "../auth/audit";
import { snapshotFor, readUsage } from "../usage";
import { liveForUser, liveById, unregisterLive } from "../tunnels/registry";
import { allocateRoute, routesForUser } from "../tunnels/routes";
import { routePathFor, publicUrlFor, formatBytes } from "../../../../packages/shared/src/index";
import { newId } from "../../../../packages/shared/src/index";

function pageOf<T>(items: T[], query: URLSearchParams): { data: T[]; page: number; limit: number; total: number } {
  const page = Math.max(1, Number(query.get("page") || 1));
  const limit = Math.min(100, Math.max(1, Number(query.get("limit") || 20)));
  const start = (page - 1) * limit;
  return { data: items.slice(start, start + limit), page, limit, total: items.length };
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  cfg: AppConfig,
  path: string,
  query: URLSearchParams,
  requestId: string,
): Promise<boolean> {
  const method = (req.method || "GET").toUpperCase();
  const ip = clientIp(req, cfg.trustProxy);
  const ctx = resolveAuth(store, req);
  const base = cfg.publicBaseUrl.replace(/\/$/, "");

  // ---- current account ----
  if (method === "GET" && path === "/api/v1/me") {
    try {
      const u = requireUser(ctx);
      sendJson(res, 200, { user: publicUser(u, cfg) }, requestId);
    } catch {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    }
    return true;
  }
  if (method === "GET" && path === "/api/v1/me/usage") {
    try {
      const u = requireUser(ctx);
      const snap = snapshotFor(store, u, cfg);
      sendJson(res, 200, { usage: snap, warnPercent: cfg.usageWarnPercent }, requestId);
    } catch {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    }
    return true;
  }
  if (method === "GET" && path === "/api/v1/me/limits") {
    try {
      const u = requireUser(ctx);
      sendJson(res, 200, {
        limits: {
          maxTunnels: u.maxTunnels === 0 ? cfg.freeMaxConcurrentTunnels : u.maxTunnels,
          uploadLimit: u.uploadLimit === 0 ? cfg.freeUploadLimitBytes : u.uploadLimit,
          downloadLimit: u.downloadLimit === 0 ? cfg.freeDownloadLimitBytes : u.downloadLimit,
          uploadLimitHuman: formatBytes(u.uploadLimit === 0 ? cfg.freeUploadLimitBytes : Math.max(0, u.uploadLimit)),
          anonymousTtlSeconds: cfg.anonymousTtlSeconds,
        },
      }, requestId);
    } catch {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    }
    return true;
  }
  if (method === "GET" && path === "/api/v1/me/tunnels") {
    try {
      const u = requireUser(ctx);
      sendJson(res, 200, { tunnels: tunnelListFor(store, u.id, base) }, requestId);
    } catch {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    }
    return true;
  }
  if (method === "GET" && path === "/api/v1/me/routes") {
    try {
      const u = requireUser(ctx);
      const routes = routesForUser(store, u.id).map((r) => ({
        id: r.id,
        slot: r.slot,
        path: routePathFor(u.usernameLower, r.slot),
        publicUrl: publicUrlFor(base, u.usernameLower, r.slot),
        online: liveForUser(u.id).some((t) => t.slot === r.slot),
        createdAt: r.createdAt,
      }));
      sendJson(res, 200, { routes, availableSlots: [1, 2, 3].filter((s) => !routes.some((r) => r.slot === s)) }, requestId);
    } catch {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    }
    return true;
  }

  // ---- tokens ----
  if (path === "/api/v1/tokens" && (method === "GET" || method === "POST")) {
    try {
      const u = requireUser(ctx);
      if (method === "GET") {
        const tokens = store.db.tokens
          .filter((t) => t.userId === u.id && t.revokedAt === null)
          .map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, scopes: t.scopes, createdAt: t.createdAt, expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt }));
        sendJson(res, 200, { tokens }, requestId);
        return true;
      }
      const body = (await readJsonBody(req, 4096)) as Record<string, unknown>;
      const name = isRecord(body) && typeof body.name === "string" ? body.name.slice(0, 64) : "cli";
      const days = isRecord(body) && typeof body.expiresInDays === "number" ? body.expiresInDays : null;
      if (days !== null && (days < 1 || days > 365)) {
        sendError(res, "BAD_REQUEST", "expiresInDays must be 1..365.", undefined, requestId);
        return true;
      }
      const { secret, prefix, hash } = newBearerToken();
      const now = Date.now();
      const row = {
        id: newId("tok"),
        userId: u.id,
        name: name || "cli",
        prefix,
        tokenHash: hash,
        scopes: ["tunnel", "api"],
        createdAt: now,
        expiresAt: days ? now + days * 86400_000 : null,
        lastUsedAt: null as number | null,
        revokedAt: null as number | null,
      };
      await store.tx(() => {
        store.db.tokens.push(row);
      });
      audit(store, { actorId: u.id, actor: u.usernameLower, action: "token.create", target: row.id, result: "ok", ip });
      // One-time secret display.
      sendJson(res, 201, {
        token: { id: row.id, name: row.name, prefix: row.prefix, expiresAt: row.expiresAt },
        secret,
        warning: "Store this secret now. It cannot be retrieved again.",
      }, requestId);
      return true;
    } catch {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    }
    return true;
  }
  {
    const m = path.match(/^\/api\/v1\/tokens\/([\w-]+)$/);
    if (m && method === "DELETE") {
      try {
        const u = requireUser(ctx);
        const tok = store.db.tokens.find((t) => t.id === m[1] && t.userId === u.id);
        if (!tok || tok.revokedAt !== null) {
          sendError(res, "NOT_FOUND", "Token not found.", undefined, requestId);
          return true;
        }
        await store.tx(() => {
          tok.revokedAt = Date.now();
        });
        audit(store, { actorId: u.id, actor: u.usernameLower, action: "token.revoke", target: tok.id, result: "ok", ip });
        sendJson(res, 200, { ok: true }, requestId);
      } catch {
        sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
      }
      return true;
    }
  }

  // ---- tunnels ----
  if (method === "GET" && path === "/api/v1/tunnels") {
    try {
      const u = requireUser(ctx);
      sendJson(res, 200, { tunnels: tunnelListFor(store, u.id, base) }, requestId);
    } catch {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    }
    return true;
  }
  if (method === "POST" && path === "/api/v1/tunnels") {
    try {
      const u = requireUser(ctx);
      const body = (await readJsonBody(req, 4096)) as Record<string, unknown>;
      const slot = isRecord(body) && typeof body.slot === "number" ? body.slot : 1;
      if (![1, 2, 3].includes(slot)) {
        sendError(res, "BAD_REQUEST", "slot must be 1, 2 or 3.", undefined, requestId);
        return true;
      }
      const route = await allocateRoute(store, u.id, u.usernameLower, slot);
      audit(store, { actorId: u.id, actor: u.usernameLower, action: "route.ensure", target: route.id, result: "ok", ip });
      sendJson(res, 201, {
        route: { id: route.id, slot, path: routePathFor(u.usernameLower, slot), publicUrl: publicUrlFor(base, u.usernameLower, slot) },
        hint: "Now run: tmin http <port> --slot " + slot,
      }, requestId);
    } catch {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    }
    return true;
  }
  {
    const m = path.match(/^\/api\/v1\/tunnels\/([\w-]+)(\/metrics)?$/);
    if (m) {
      const id = m[1];
      const wantMetrics = !!m[2];
      try {
        const u = requireUser(ctx);
        const meta = store.db.tunnels.find((t) => t.id === id && (u.role === "admin" || t.userId === u.id));
        if (!meta) {
          sendError(res, "TUNNEL_NOT_FOUND", "Tunnel not found.", undefined, requestId);
          return true;
        }
        const live = liveById(id);
        if (method === "GET") {
          const detail = {
            id: meta.id,
            routePath: meta.routePath,
            publicUrl: base + meta.routePath,
            slot: meta.slot,
            label: meta.label,
            status: live ? "online" : meta.status === "connected" ? "stale" : "offline",
            anonymous: meta.anon,
            connectedAt: meta.connectedAt,
            lastSeenAt: live ? live.lastHeartbeat : meta.lastSeenAt,
            uptimeSeconds: live ? Math.floor((Date.now() - live.connectedAt) / 1000) : null,
            upBytes: live ? live.upBytes : meta.upBytes,
            downBytes: live ? live.downBytes : meta.downBytes,
            inFlight: live ? live.inFlight : 0,
            expiresAt: live ? live.expiresAt : null,
          };
          if (wantMetrics) {
            const logs = store.db.requestLogs.filter((l) => l.tunnelId === id).slice(-50);
            sendJson(res, 200, { metrics: { ...detail, recentRequests: logs.map((l) => ({ at: l.at, method: l.method, path: l.path, status: l.status, ms: l.ms, upBytes: l.upBytes, downBytes: l.downBytes })) } }, requestId);
          } else {
            sendJson(res, 200, { tunnel: detail }, requestId);
          }
          return true;
        }
        if (method === "DELETE") {
          if (live) {
            try {
              live.ws.send(JSON.stringify({ type: "shutdown", reason: "Terminated by owner.", reconnectMs: 0 }));
              live.ws.close(1000, "terminated");
            } catch {
              undefined;
            }
            unregisterLive(live.id);
          }
          await store.tx(() => {
            meta.status = "closed";
            meta.closedAt = Date.now();
          });
          audit(store, { actorId: u.id, actor: u.usernameLower, action: "tunnel.terminate", target: id, result: "ok", ip });
          sendJson(res, 200, { ok: true }, requestId);
          return true;
        }
      } catch {
        sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
      }
      return true;
    }
  }

  // ---- routes ----
  if (method === "GET" && path === "/api/v1/routes") {
    try {
      const u = requireUser(ctx);
      const routes = routesForUser(store, u.id).map((r) => ({
        id: r.id,
        slot: r.slot,
        path: routePathFor(u.usernameLower, r.slot),
        publicUrl: publicUrlFor(base, u.usernameLower, r.slot),
        online: liveForUser(u.id).some((t) => t.slot === r.slot),
        createdAt: r.createdAt,
      }));
      sendJson(res, 200, { routes }, requestId);
      return true;
    } catch {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    }
    return true;
  }
  if (method === "POST" && path === "/api/v1/routes") {
    try {
      const u = requireUser(ctx);
      const body = (await readJsonBody(req, 4096)) as Record<string, unknown>;
      const slot = isRecord(body) && typeof body.slot === "number" ? body.slot : 1;
      if (![1, 2, 3].includes(slot)) {
        sendError(res, "BAD_REQUEST", "slot must be 1, 2 or 3.", undefined, requestId);
        return true;
      }
      const route = await allocateRoute(store, u.id, u.usernameLower, slot);
      sendJson(res, 201, { route: { id: route.id, slot, path: routePathFor(u.usernameLower, slot), publicUrl: publicUrlFor(base, u.usernameLower, slot) } }, requestId);
    } catch {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    }
    return true;
  }
  {
    const m = path.match(/^\/api\/v1\/routes\/([\w-]+)$/);
    if (m) {
      try {
        const u = requireUser(ctx);
        const route = store.db.routes.find((r) => r.id === m[1] && (u.role === "admin" || r.userId === u.id));
        if (!route) {
          sendError(res, "NOT_FOUND", "Route not found.", undefined, requestId);
          return true;
        }
        const owner = store.db.users.find((x) => x.id === route.userId);
        const ownerName = owner ? owner.usernameLower : "?";
        if (method === "GET") {
          sendJson(res, 200, {
            route: {
              id: route.id, slot: route.slot,
              path: routePathFor(ownerName, route.slot),
              publicUrl: publicUrlFor(base, ownerName, route.slot),
              owner: ownerName, createdAt: route.createdAt,
            },
          }, requestId);
          return true;
        }
        if (method === "DELETE") {
          const live = liveForUser(route.userId).find((t) => t.slot === route.slot);
          if (live) {
            sendError(res, "ROUTE_CONFLICT", "Route has a live tunnel. Stop the tunnel first, then release the route.", undefined, requestId);
            return true;
          }
          await store.tx(() => {
            const i = store.db.routes.findIndex((r) => r.id === route.id);
            if (i >= 0) store.db.routes.splice(i, 1);
          });
          audit(store, { actorId: u.id, actor: u.usernameLower, action: "route.release", target: route.id, result: "ok", ip });
          sendJson(res, 200, { ok: true }, requestId);
          return true;
        }
      } catch {
        sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
      }
      return true;
    }
  }

  // ---- sessions (account/security section) ----
  if (method === "GET" && path === "/api/v1/sessions") {
    try {
      const u = requireUser(ctx);
      const now = Date.now();
      const sessions = store.db.sessions
        .filter((s) => s.userId === u.id && s.revokedAt === null && s.expiresAt > now)
        .map((s) => ({ id: s.id, createdAt: s.createdAt, expiresAt: s.expiresAt, ip: s.ip, ua: s.ua }));
      sendJson(res, 200, { sessions }, requestId);
    } catch {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    }
    return true;
  }
  {
    const m = path.match(/^\/api\/v1\/sessions\/([\w-]+)$/);
    if (m && method === "DELETE") {
      try {
        const u = requireUser(ctx);
        const s = store.db.sessions.find((x) => x.id === m[1] && x.userId === u.id);
        if (!s) {
          sendError(res, "NOT_FOUND", "Session not found.", undefined, requestId);
          return true;
        }
        await store.tx(() => {
          s.revokedAt = Date.now();
        });
        audit(store, { actorId: u.id, actor: u.usernameLower, action: "session.revoke", target: s.id, result: "ok", ip });
        sendJson(res, 200, { ok: true }, requestId);
      } catch {
        sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
      }
      return true;
    }
  }

  void newRequestId;
  void str;
  return false;
}

export function tunnelListFor(store: Store, userId: string, base: string): unknown[] {
  const now = Date.now();
  const metas = store.db.tunnels.filter((t) => t.userId === userId).sort((a, b) => b.connectedAt - a.connectedAt).slice(0, 50);
  return metas.map((meta) => {
    const live = liveById(meta.id);
    return {
      id: meta.id,
      routePath: meta.routePath,
      publicUrl: base + meta.routePath,
      slot: meta.slot,
      label: meta.label,
      status: live ? "online" : meta.status === "connected" ? "stale" : "offline",
      anonymous: meta.anon,
      connectedAt: meta.connectedAt,
      lastSeenAt: live ? live.lastHeartbeat : meta.lastSeenAt,
      uptimeSeconds: live ? Math.floor((now - live.connectedAt) / 1000) : null,
      upBytes: live ? live.upBytes : meta.upBytes,
      downBytes: live ? live.downBytes : meta.downBytes,
      expiresAt: live ? live.expiresAt : null,
    };
  });
}
