import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord, validateUsername, hashPassword, type AppConfig } from "../../../../packages/shared/src/index";
import type { Store } from "../db/store";
import { sendJson, sendError, readJsonBody, clientIp } from "../http";
import { resolveAuth, requireAdmin } from "../auth/context";
import { publicUser } from "../auth/users";
import { audit } from "../auth/audit";
import { allLive, liveById, unregisterLive, liveCount } from "../tunnels/registry";
import { snapshotFor, readUsage } from "../usage";

function pageOf<T>(items: T[], query: URLSearchParams): { data: T[]; page: number; limit: number; total: number } {
  const page = Math.max(1, Number(query.get("page") || 1));
  const limit = Math.min(100, Math.max(1, Number(query.get("limit") || 20)));
  return { data: items.slice((page - 1) * limit, (page - 1) * limit + limit), page, limit, total: items.length };
}

export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  cfg: AppConfig,
  path: string,
  query: URLSearchParams,
  requestId: string,
): Promise<boolean> {
  if (!path.startsWith("/api/v1/admin")) return false;
  const method = (req.method || "GET").toUpperCase();
  const ip = clientIp(req, cfg.trustProxy);
  const ctx = resolveAuth(store, req);
  let admin: ReturnType<typeof requireAdmin>;
  try {
    admin = requireAdmin(ctx);
  } catch {
    if (!ctx.user) sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
    else sendError(res, "FORBIDDEN", "Administrator access required.", undefined, requestId);
    return true;
  }
  const base = cfg.publicBaseUrl.replace(/\/$/, "");

  // GET /api/v1/admin/users
  if (method === "GET" && path === "/api/v1/admin/users") {
    const q = (query.get("search") || "").toLowerCase();
    const status = query.get("status") || "";
    let users = [...store.db.users];
    if (q) users = users.filter((u) => u.usernameLower.includes(q) || u.email.includes(q));
    if (status) users = users.filter((u) => u.status === status);
    users.sort((a, b) => b.createdAt - a.createdAt);
    const pg = pageOf(users, query);
    sendJson(res, 200, { ...pg, data: pg.data.map((u) => publicUser(u, cfg)) }, requestId);
    return true;
  }

  const userMatch = path.match(/^\/api\/v1\/admin\/users\/([\w-]+)(\/[\w-]+)?$/);
  if (userMatch) {
    const id = userMatch[1];
    const sub = userMatch[2] || "";
    const target = store.db.users.find((u) => u.id === id);
    if (!target) {
      sendError(res, "NOT_FOUND", "User not found.", undefined, requestId);
      return true;
    }
    // GET detail
    if (method === "GET" && !sub) {
      const usage = readUsage(store, target.id);
      const routes = store.db.routes.filter((r) => r.userId === target.id);
      const tunnels = store.db.tunnels.filter((t) => t.userId === target.id).slice(-20);
      sendJson(res, 200, { user: publicUser(target, cfg), usage, routes, tunnels }, requestId);
      return true;
    }
    const body = (method === "PATCH" || method === "POST") ? ((await readJsonBody(req, 4096)) as Record<string, unknown>) : {};
    // PATCH status
    if (method === "PATCH" && sub === "/status") {
      const st = isRecord(body) ? body.status : undefined;
      if (st !== "active" && st !== "suspended") {
        sendError(res, "BAD_REQUEST", "status must be active or suspended.", undefined, requestId);
        return true;
      }
      await store.tx(() => {
        target.status = st;
        target.updatedAt = Date.now();
        if (st === "suspended") {
          // Suspended: kill live tunnels immediately.
          for (const t of allLive().filter((l) => l.userId === target.id)) {
            try {
              t.ws.send(JSON.stringify({ type: "shutdown", reason: "Account suspended.", reconnectMs: 0 }));
              t.ws.close(4403, "suspended");
            } catch {
              undefined;
            }
            unregisterLive(t.id);
          }
        }
      });
      audit(store, { actorId: admin.id, actor: admin.usernameLower, action: "admin.user.status", target: `${target.id}:${st}`, result: "ok", ip });
      sendJson(res, 200, { user: publicUser(target, cfg) }, requestId);
      return true;
    }
    // PATCH limits
    if (method === "PATCH" && sub === "/limits") {
      if (!isRecord(body)) {
        sendError(res, "BAD_REQUEST", "Invalid body.", undefined, requestId);
        return true;
      }
      const num = (v: unknown): number | undefined => (typeof v === "number" && v >= -1 && v <= 1e15 ? Math.floor(v) : undefined);
      const up = num(body.uploadLimit);
      const down = num(body.downloadLimit);
      const mt = num(body.maxTunnels);
      if (up === undefined && down === undefined && mt === undefined) {
        sendError(res, "BAD_REQUEST", "Provide uploadLimit, downloadLimit or maxTunnels (-1 = unlimited, 0 = default).", undefined, requestId);
        return true;
      }
      await store.tx(() => {
        if (up !== undefined) target.uploadLimit = up;
        if (down !== undefined) target.downloadLimit = down;
        if (mt !== undefined) target.maxTunnels = mt;
        target.updatedAt = Date.now();
      });
      audit(store, { actorId: admin.id, actor: admin.usernameLower, action: "admin.user.limits", target: target.id, result: "ok", ip });
      sendJson(res, 200, { user: publicUser(target, cfg) }, requestId);
      return true;
    }
    // PATCH role (cannot demote self / last admin)
    if (method === "PATCH" && sub === "/role") {
      const role = isRecord(body) ? body.role : undefined;
      if (role !== "admin" && role !== "user") {
        sendError(res, "BAD_REQUEST", "role must be admin or user.", undefined, requestId);
        return true;
      }
      if (target.id === admin.id && role !== "admin") {
        sendError(res, "FORBIDDEN", "You cannot demote your own account.", undefined, requestId);
        return true;
      }
      if (target.role === "admin" && role === "user") {
        const admins = store.db.users.filter((u) => u.role === "admin" && u.status === "active");
        if (admins.length <= 1) {
          sendError(res, "FORBIDDEN", "Cannot demote the last active administrator.", undefined, requestId);
          return true;
        }
      }
      await store.tx(() => {
        target.role = role;
        target.updatedAt = Date.now();
        if (role === "admin") {
          target.uploadLimit = -1;
          target.downloadLimit = -1;
          target.maxTunnels = -1;
        }
      });
      audit(store, { actorId: admin.id, actor: admin.usernameLower, action: "admin.user.role", target: `${target.id}:${role}`, result: "ok", ip });
      sendJson(res, 200, { user: publicUser(target, cfg) }, requestId);
      return true;
    }
    // PATCH username (rename; routes follow the owner)
    if (method === "PATCH" && sub === "/username") {
      const name = isRecord(body) && typeof body.username === "string" ? body.username : "";
      const v = validateUsername(name);
      if (!v.ok) {
        sendError(res, v.code, v.message, undefined, requestId);
        return true;
      }
      if (store.db.users.some((u) => u.usernameLower === v.value && u.id !== target.id)) {
        sendError(res, "USERNAME_TAKEN", "Username is already taken.", undefined, requestId);
        return true;
      }
      const live = allLive().filter((l) => l.userId === target.id);
      if (live.length > 0) {
        sendError(res, "ROUTE_CONFLICT", "User has live tunnels. Terminate them before renaming.", undefined, requestId);
        return true;
      }
      const old = target.usernameLower;
      await store.tx(() => {
        target.username = v.value;
        target.usernameLower = v.value;
        target.updatedAt = Date.now();
        for (const r of store.db.routes) {
          if (r.userId === target.id) r.usernameLower = v.value;
        }
        for (const m of store.db.tunnels) {
          if (m.userId === target.id && !m.anon) {
            m.routePath = m.slot === 1 ? `/${v.value}` : `/${v.value}/${m.slot}`;
          }
        }
      });
      audit(store, { actorId: admin.id, actor: admin.usernameLower, action: "admin.user.rename", target: `${old}->${v.value}`, result: "ok", ip });
      sendJson(res, 200, { user: publicUser(target, cfg) }, requestId);
      return true;
    }
    // POST revoke-sessions
    if (method === "POST" && sub === "/revoke-sessions") {
      const revokeTokens = !isRecord(body) || body.tokens !== false;
      await store.tx(() => {
        for (const s of store.db.sessions) {
          if (s.userId === target.id && s.revokedAt === null) s.revokedAt = Date.now();
        }
        if (revokeTokens) {
          for (const t of store.db.tokens) {
            if (t.userId === target.id && t.revokedAt === null) t.revokedAt = Date.now();
          }
        }
      });
      audit(store, { actorId: admin.id, actor: admin.usernameLower, action: "admin.user.revoke", target: target.id, result: "ok", ip });
      sendJson(res, 200, { ok: true }, requestId);
      return true;
    }
    // POST reset-password (admin-initiated)
    if (method === "POST" && sub === "/reset-password") {
      const pw = isRecord(body) && typeof body.newPassword === "string" ? body.newPassword : "";
      try {
        const hashed = await hashPassword(pw);
        await store.tx(() => {
          target.passwordHash = hashed;
          target.updatedAt = Date.now();
          for (const s of store.db.sessions) {
            if (s.userId === target.id && s.revokedAt === null) s.revokedAt = Date.now();
          }
        });
        audit(store, { actorId: admin.id, actor: admin.usernameLower, action: "admin.user.reset-password", target: target.id, result: "ok", ip });
        sendJson(res, 200, { ok: true }, requestId);
      } catch (e: unknown) {
        sendError(res, "BAD_REQUEST", (e as Error).message, undefined, requestId);
      }
      return true;
    }
    sendError(res, "NOT_FOUND", "Unknown admin user action.", undefined, requestId);
    return true;
  }

  // GET /api/v1/admin/tunnels
  if (method === "GET" && path === "/api/v1/admin/tunnels") {
    const live = allLive().map((t) => ({
      id: t.id,
      routePath: t.routePath,
      publicUrl: base + t.routePath,
      slot: t.slot,
      label: t.label,
      status: "online",
      anonymous: !!t.anonSessionId,
      owner: t.usernameLower ?? "anonymous",
      userId: t.userId,
      connectedAt: t.connectedAt,
      lastHeartbeat: t.lastHeartbeat,
      expiresAt: t.expiresAt,
      inFlight: t.inFlight,
      upBytes: t.upBytes,
      downBytes: t.downBytes,
    }));
    sendJson(res, 200, { live, liveCount: liveCount() }, requestId);
    return true;
  }
  const adminTun = path.match(/^\/api\/v1\/admin\/tunnels\/([\w-]+)$/);
  if (adminTun && method === "DELETE") {
    const live = liveById(adminTun[1]);
    const meta = store.db.tunnels.find((t) => t.id === adminTun[1]);
    if (!live && !meta) {
      sendError(res, "TUNNEL_NOT_FOUND", "Tunnel not found.", undefined, requestId);
      return true;
    }
    if (live) {
      try {
        live.ws.send(JSON.stringify({ type: "shutdown", reason: "Terminated by administrator.", reconnectMs: 0 }));
        live.ws.close(1000, "admin-terminate");
      } catch {
        undefined;
      }
      unregisterLive(live.id);
    }
    if (meta) {
      await store.tx(() => {
        meta.status = "closed";
        meta.closedAt = Date.now();
      });
    }
    audit(store, { actorId: admin.id, actor: admin.usernameLower, action: "admin.tunnel.terminate", target: adminTun[1], result: "ok", ip });
    sendJson(res, 200, { ok: true }, requestId);
    return true;
  }

  // GET /api/v1/admin/anon
  if (method === "GET" && path === "/api/v1/admin/anon") {
    const now = Date.now();
    const list = [...store.db.anonSessions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map((s) => ({
      id: s.id,
      path: `/${s.pathToken}`,
      publicUrl: `${base}/${s.pathToken}`,
      status: s.status,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      secondsLeft: Math.max(0, Math.floor((s.expiresAt - now) / 1000)),
      tunnelId: s.tunnelId,
      live: s.tunnelId ? liveById(s.tunnelId) !== undefined : false,
    }));
    sendJson(res, 200, { sessions: list }, requestId);
    return true;
  }

  // GET /api/v1/admin/metrics
  if (method === "GET" && path === "/api/v1/admin/metrics") {
    const logs = store.db.requestLogs.slice(-500);
    const avgMs = logs.length ? Math.round(logs.reduce((n, l) => n + l.ms, 0) / logs.length) : 0;
    const errRate = logs.length ? logs.filter((l) => l.status >= 500).length / logs.length : 0;
    let up = 0;
    let down = 0;
    for (const t of allLive()) {
      up += t.upBytes;
      down += t.downBytes;
    }
    sendJson(res, 200, {
      metrics: {
        liveTunnels: liveCount(),
        users: store.db.users.length,
        activeAnon: store.db.anonSessions.filter((s) => s.status === "active").length,
        avgLatencyMs: avgMs,
        errorRate: Number(errRate.toFixed(4)),
        liveUpBytes: up,
        liveDownBytes: down,
        uptimeSeconds: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
      },
    }, requestId);
    return true;
  }

  // GET /api/v1/admin/audit-logs
  if (method === "GET" && path === "/api/v1/admin/audit-logs") {
    const q = (query.get("search") || "").toLowerCase();
    let rows = [...store.db.audit].sort((a, b) => b.at - a.at);
    if (q) rows = rows.filter((a) => `${a.action} ${a.actor} ${a.target} ${a.result}`.toLowerCase().includes(q));
    const pg = pageOf(rows, query);
    sendJson(res, 200, { ...pg }, requestId);
    return true;
  }

  // GET/PATCH /api/v1/admin/config/quotas
  if (path === "/api/v1/admin/config/quotas") {
    if (method === "GET") {
      sendJson(res, 200, {
        quotas: {
          freeMaxConcurrentTunnels: cfg.freeMaxConcurrentTunnels,
          freeUploadLimitBytes: cfg.freeUploadLimitBytes,
          freeDownloadLimitBytes: cfg.freeDownloadLimitBytes,
          anonymousTtlSeconds: cfg.anonymousTtlSeconds,
          usageWarnPercent: cfg.usageWarnPercent,
        },
      }, requestId);
      return true;
    }
    if (method === "PATCH") {
      const body = (await readJsonBody(req, 4096)) as Record<string, unknown>;
      if (!isRecord(body)) {
        sendError(res, "BAD_REQUEST", "Invalid body.", undefined, requestId);
        return true;
      }
      const apply = (k: "freeMaxConcurrentTunnels" | "freeUploadLimitBytes" | "freeDownloadLimitBytes" | "anonymousTtlSeconds" | "usageWarnPercent", min: number, max: number) => {
        const v = (body as Record<string, unknown>)[k];
        if (v === undefined) return;
        if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
          throw Object.assign(new Error(`${k} must be an integer ${min}..${max}.`), { code: "BAD_REQUEST" });
        }
        (cfg as unknown as Record<string, number>)[k] = v;
      };
      try {
        apply("freeMaxConcurrentTunnels", 1, 10);
        apply("freeUploadLimitBytes", 0, 1e15);
        apply("freeDownloadLimitBytes", 0, 1e15);
        apply("anonymousTtlSeconds", 60, 7200);
        apply("usageWarnPercent", 1, 99);
      } catch (e: unknown) {
        sendError(res, "BAD_REQUEST", (e as Error).message, undefined, requestId);
        return true;
      }
      audit(store, { actorId: admin.id, actor: admin.usernameLower, action: "admin.config.quotas", target: "global", result: "ok", ip });
      sendJson(res, 200, {
        quotas: {
          freeMaxConcurrentTunnels: cfg.freeMaxConcurrentTunnels,
          freeUploadLimitBytes: cfg.freeUploadLimitBytes,
          freeDownloadLimitBytes: cfg.freeDownloadLimitBytes,
          anonymousTtlSeconds: cfg.anonymousTtlSeconds,
          usageWarnPercent: cfg.usageWarnPercent,
        },
      }, requestId);
      return true;
    }
  }

  // POST /api/v1/admin/maintenance
  if (method === "POST" && path === "/api/v1/admin/maintenance") {
    const body = (await readJsonBody(req, 4096)) as Record<string, unknown>;
    const enabled = isRecord(body) ? !!body.enabled : false;
    await store.tx(() => {
      store.db.settings.maintenanceMode = enabled;
    });
    audit(store, { actorId: admin.id, actor: admin.usernameLower, action: "admin.maintenance", target: enabled ? "on" : "off", result: "ok", ip });
    sendJson(res, 200, { maintenanceMode: enabled }, requestId);
    return true;
  }

  // GET /api/v1/admin/health
  if (method === "GET" && path === "/api/v1/admin/health") {
    sendJson(res, 200, {
      health: {
        ok: true,
        uptimeSeconds: Math.floor(process.uptime()),
        liveTunnels: liveCount(),
        db: { users: store.db.users.length, routes: store.db.routes.length, usageRows: store.db.usage.length },
        maintenanceMode: store.db.settings.maintenanceMode,
      },
    }, requestId);
    return true;
  }

  void snapshotFor;
  void readUsage;
  return false;
}
