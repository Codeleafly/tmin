import type { IncomingMessage } from "node:http";
import { sha256Hex } from "./secrets";
import type { Store, UserRow } from "../db/store";

export interface AuthContext {
  user: UserRow | null;
  via: "session" | "token" | null;
  tokenId: string | null;
}

const SESSION_COOKIE = "tmin_sid";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export function buildSessionCookie(secret: string, sessionSecret: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(secret)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function sessionExpiry(now = Date.now()): number {
  return now + SESSION_TTL_MS;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Resolve browser session OR `Authorization: Bearer <token>`. Never trusts body params. */
export function resolveAuth(store: Store, req: IncomingMessage, now = Date.now()): AuthContext {
  const empty: AuthContext = { user: null, via: null, tokenId: null };
  const authz = req.headers.authorization;
  if (typeof authz === "string" && authz.startsWith("Bearer ")) {
    const secret = authz.slice(7).trim();
    if (!secret) return empty;
    const hash = sha256Hex(secret);
    const tok = store.db.tokens.find((t) => t.tokenHash === hash);
    if (!tok || tok.revokedAt !== null) return empty;
    if (tok.expiresAt !== null && tok.expiresAt <= now) return empty;
    const user = store.db.users.find((u) => u.id === tok.userId);
    if (!user || user.status !== "active") return empty;
    tok.lastUsedAt = now;
    store.markDirty();
    return { user, via: "token", tokenId: tok.id };
  }
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return empty;
  const hash = sha256Hex(sid);
  const sess = store.db.sessions.find((s) => s.tokenHash === hash);
  if (!sess || sess.revokedAt !== null || sess.expiresAt <= now) return empty;
  const user = store.db.users.find((u) => u.id === sess.userId);
  if (!user || user.status !== "active") return empty;
  return { user, via: "session", tokenId: null };
}

export function requireUser(ctx: AuthContext): UserRow {
  if (!ctx.user) {
    throw Object.assign(new Error("Authentication required."), { code: "NOT_AUTHENTICATED" });
  }
  return ctx.user;
}

export function requireAdmin(ctx: AuthContext): UserRow {
  const u = requireUser(ctx);
  if (u.role !== "admin") {
    throw Object.assign(new Error("Administrator access required."), { code: "FORBIDDEN" });
  }
  return u;
}
