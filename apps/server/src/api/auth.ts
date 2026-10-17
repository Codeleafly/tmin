import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyPassword, hashPassword, isRecord, str, type AppConfig } from "../../../../packages/shared/src/index";
import type { Store } from "../db/store";
import { sendJson, sendError, readJsonBody, clientIp } from "../http";
import { registerUser, findUserByLogin, publicUser } from "../auth/users";
import { newSessionToken, newBearerToken, sha256Hex } from "../auth/secrets";
import { sessionCookieName, sessionExpiry, buildSessionCookie, clearSessionCookie, resolveAuth } from "../auth/context";
import { audit } from "../auth/audit";
import { newId } from "../../../../packages/shared/src/index";

function errCode(e: unknown): string {
  return (e as { code?: string }).code ?? "BAD_REQUEST";
}

export async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  cfg: AppConfig,
  path: string,
  requestId: string,
): Promise<boolean> {
  const method = (req.method || "GET").toUpperCase();
  const ip = clientIp(req, cfg.trustProxy);
  const secure = cfg.publicBaseUrl.startsWith("https://");

  // POST /api/v1/auth/register
  if (method === "POST" && path === "/api/v1/auth/register") {
    const body = (await readJsonBody(req, 8192)) as Record<string, unknown>;
    if (!isRecord(body) || !str(body.username, 64) || !str(body.email, 254) || !str(body.password, 256)) {
      sendError(res, "BAD_REQUEST", "username, email and password are required.", undefined, requestId);
      return true;
    }
    try {
      const user = await registerUser(store, {
        username: body.username as string,
        email: body.email as string,
        password: body.password as string,
      });
      audit(store, { actor: user.usernameLower, action: "auth.register", target: user.id, result: "ok", ip });
      sendJson(res, 201, { user: publicUser(user, cfg) }, requestId);
    } catch (e: unknown) {
      const code = errCode(e) as Parameters<typeof sendError>[1];
      sendError(res, code, (e as Error).message, undefined, requestId);
    }
    return true;
  }

  // POST /api/v1/auth/login
  if (method === "POST" && path === "/api/v1/auth/login") {
    const body = (await readJsonBody(req, 8192)) as Record<string, unknown>;
    if (!isRecord(body) || !str(body.login, 254) || !str(body.password, 256)) {
      sendError(res, "BAD_REQUEST", "login and password are required.", undefined, requestId);
      return true;
    }
    const user = findUserByLogin(store, body.login as string);
    const ok = user && user.status === "active" && (await verifyPassword(body.password as string, user.passwordHash));
    if (!ok) {
      // Generic response: no account enumeration.
      audit(store, { actor: String(body.login).slice(0, 64), action: "auth.login", target: "-", result: "denied", ip });
      sendError(res, "INVALID_CREDENTIALS", "Invalid credentials.", undefined, requestId);
      return true;
    }
    const { secret, hash } = newSessionToken();
    const now = Date.now();
    await store.tx(() => {
      store.db.sessions.push({
        id: newId("ses"),
        userId: user.id,
        tokenHash: hash,
        createdAt: now,
        expiresAt: sessionExpiry(now),
        ip,
        ua: String(req.headers["user-agent"] || "").slice(0, 256),
        revokedAt: null,
      });
    });
    audit(store, { actorId: user.id, actor: user.usernameLower, action: "auth.login", target: user.id, result: "ok", ip });
    res.setHeader("set-cookie", buildSessionCookie(secret, secure));
    sendJson(res, 200, { user: publicUser(user, cfg) }, requestId);
    return true;
  }

  // POST /api/v1/auth/logout
  if (method === "POST" && path === "/api/v1/auth/logout") {
    const ctx = resolveAuth(store, req);
    const cookies = parseAuthCookie(req);
    if (cookies) {
      await store.tx(() => {
        const s = store.db.sessions.find((x) => x.tokenHash === sha256Hex(cookies));
        if (s) s.revokedAt = Date.now();
      });
    }
    if (ctx.user) audit(store, { actorId: ctx.user.id, actor: ctx.user.usernameLower, action: "auth.logout", target: ctx.user.id, result: "ok", ip });
    res.setHeader("set-cookie", clearSessionCookie(secure));
    sendJson(res, 200, { ok: true }, requestId);
    return true;
  }

  // POST /api/v1/auth/forgot-password (generic response; no enumeration)
  if (method === "POST" && path === "/api/v1/auth/forgot-password") {
    const body = (await readJsonBody(req, 8192)) as Record<string, unknown>;
    const email = isRecord(body) && typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const user = store.db.users.find((u) => u.email === email);
    let debugToken: string | undefined;
    if (user) {
      const { secret, hash } = newBearerToken();
      const now = Date.now();
      await store.tx(() => {
        store.db.resets.push({ id: newId("rst"), userId: user.id, tokenHash: hash, createdAt: now, expiresAt: now + 3600_000, usedAt: null });
      });
      audit(store, { actor: user.usernameLower, action: "auth.forgot", target: user.id, result: "ok", ip });
      // Non-production only: return token so self-hosters without email can complete reset.
      if (cfg.nodeEnv !== "production") debugToken = secret;
    }
    sendJson(res, 200, { ok: true, ...(debugToken ? { resetToken: debugToken } : {}) }, requestId);
    return true;
  }

  // POST /api/v1/auth/reset-password
  if (method === "POST" && path === "/api/v1/auth/reset-password") {
    const body = (await readJsonBody(req, 8192)) as Record<string, unknown>;
    if (!isRecord(body) || !str(body.token, 512) || !str(body.newPassword, 256)) {
      sendError(res, "BAD_REQUEST", "token and newPassword are required.", undefined, requestId);
      return true;
    }
    const hash = sha256Hex(body.token as string);
    const row = store.db.resets.find((r) => r.tokenHash === hash);
    if (!row || row.usedAt !== null || row.expiresAt <= Date.now()) {
      sendError(res, "BAD_REQUEST", "Reset token is invalid or expired.", undefined, requestId);
      return true;
    }
    try {
      const pw = await hashPassword(body.newPassword as string);
      await store.tx(() => {
        const u = store.db.users.find((x) => x.id === row.userId);
        if (u) {
          u.passwordHash = pw;
          u.updatedAt = Date.now();
        }
        row.usedAt = Date.now();
        for (const s of store.db.sessions) {
          if (s.userId === row.userId && s.revokedAt === null) s.revokedAt = Date.now();
        }
        for (const t of store.db.tokens) {
          if (t.userId === row.userId && t.revokedAt === null) t.revokedAt = Date.now();
        }
      });
      audit(store, { actor: row.userId, action: "auth.reset", target: row.userId, result: "ok", ip });
      sendJson(res, 200, { ok: true }, requestId);
    } catch (e: unknown) {
      sendError(res, "BAD_REQUEST", (e as Error).message, undefined, requestId);
    }
    return true;
  }

  // POST /api/v1/auth/change-password
  if (method === "POST" && path === "/api/v1/auth/change-password") {
    const ctx = resolveAuth(store, req);
    if (!ctx.user) {
      sendError(res, "NOT_AUTHENTICATED", "Authentication required.", undefined, requestId);
      return true;
    }
    const body = (await readJsonBody(req, 8192)) as Record<string, unknown>;
    if (!isRecord(body) || !str(body.currentPassword, 256) || !str(body.newPassword, 256)) {
      sendError(res, "BAD_REQUEST", "currentPassword and newPassword are required.", undefined, requestId);
      return true;
    }
    const ok = await verifyPassword(body.currentPassword as string, ctx.user.passwordHash);
    if (!ok) {
      sendError(res, "INVALID_CREDENTIALS", "Current password is incorrect.", undefined, requestId);
      return true;
    }
    try {
      const pw = await hashPassword(body.newPassword as string);
      await store.tx(() => {
        ctx.user!.passwordHash = pw;
        ctx.user!.updatedAt = Date.now();
        for (const s of store.db.sessions) {
          if (s.userId === ctx.user!.id && s.revokedAt === null) {
            // Keep the current session, revoke others.
            const cur = parseAuthCookie(req);
            if (!cur || s.tokenHash !== sha256Hex(cur)) s.revokedAt = Date.now();
          }
        }
      });
      audit(store, { actorId: ctx.user.id, actor: ctx.user.usernameLower, action: "auth.change-password", target: ctx.user.id, result: "ok", ip });
      sendJson(res, 200, { ok: true }, requestId);
    } catch (e: unknown) {
      sendError(res, "BAD_REQUEST", (e as Error).message, undefined, requestId);
    }
    return true;
  }

  return false;
}

function parseAuthCookie(req: IncomingMessage): string | null {
  const h = req.headers.cookie;
  if (!h) return null;
  const name = sessionCookieName() + "=";
  for (const part of h.split(";")) {
    const t = part.trim();
    if (t.startsWith(name)) return decodeURIComponent(t.slice(name.length));
  }
  return null;
}
