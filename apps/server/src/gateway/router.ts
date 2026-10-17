/** Public gateway: host/path router -> quota checks -> live tunnel -> local app. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import WebSocket from "ws";
import { parsePublicPath, newRequestId, type AppConfig } from "../../../../packages/shared/src/index";
import type { Store } from "../db/store";
import { sendError, clientIp } from "../http";
import { liveByRoute, type LiveTunnel } from "../tunnels/registry";
import { dispatchToTunnel } from "../tunnels/handler";
import { snapshotFor, quotaBlockReason, addUsage } from "../usage";
import { logger } from "../logger";
import { newId } from "../../../../packages/shared/src/index";

export const SYSTEM_PREFIXES = new Set([
  "api", "admin", "dashboard", "docs", "login", "logout", "assets",
  "health", "ready", "metrics", "tunnel", "tunnels", "favicon",
]);

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection",
]);

const SENSITIVE = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token"]);

export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = SENSITIVE.has(k.toLowerCase()) ? "[redacted]" : v;
  }
  return out;
}

function cleanHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (typeof v === "string") out[k] = v.slice(0, 8192);
    else if (Array.isArray(v)) out[k] = v.join(", ").slice(0, 8192);
  }
  return out;
}

export interface GatewayDeps {
  store: Store;
  cfg: AppConfig;
}

interface Admission {
  tunnel: LiveTunnel;
  userId: string | null;
  anonSessionId: string | null;
  routeId: string;
  routePath: string;
  ownerName: string;
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function offlinePage(routePath: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Route offline</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:8vh auto;padding:0 20px;color:#1a1a1a}code{background:#f1f1f1;padding:2px 6px;border-radius:4px}</style></head><body><h1>Route offline</h1><p><code>${routePath}</code> has no live tunnel connected.</p><p>Ask the owner to run <code>tmin</code> again, or check the dashboard for connection history.</p></body></html>`;
}

export async function handlePublicRequest(req: IncomingMessage, res: ServerResponse, deps: GatewayDeps): Promise<void> {
  const { store, cfg } = deps;
  const requestId = newRequestId();
  const started = Date.now();
  res.setHeader("x-request-id", requestId);
  const method = (req.method || "GET").toUpperCase();
  const rawUrl = req.url || "/";
  const pathname = rawUrl.split("?")[0];

  if (!ALLOWED_METHODS.has(method)) {
    sendError(res, "BAD_REQUEST", `Method ${method} not supported.`, undefined, requestId);
    return;
  }
  if (store.db.settings.maintenanceMode) {
    sendError(res, "MAINTENANCE_MODE", "Server is in maintenance mode. Try again shortly.", undefined, requestId);
    return;
  }

  let parsed: ReturnType<typeof parsePublicPath>;
  try {
    parsed = parsePublicPath(decodeURI(pathname));
  } catch {
    sendError(res, "BAD_REQUEST", "Undecodable request path.", undefined, requestId);
    return;
  }
  if (!parsed) {
    sendError(res, "NOT_FOUND", "No tunnel route at this path.", undefined, requestId);
    return;
  }

  // Anonymous path-token routes look like /a-xxxx (never collide with usernames:
  // usernames min length 3, tokens contain hyphen+base64url; matched exactly).
  let adm: Admission | null = null;
  if (parsed.username.startsWith("a-")) {
    // Anonymous routes: token namespace reserved at registration (usernames may not start with "a-").
    const found = admitAnon(store, parsed.username);
    if (found === "expired") {
      sendError(res, "ANON_EXPIRED", "Anonymous session expired.", undefined, requestId);
      return;
    }
    if (!found) {
      sendError(res, "NOT_FOUND", "Anonymous route not found.", undefined, requestId);
      return;
    }
    if (!found.tunnel) {
      res.writeHead(502, { "content-type": "text/html; charset=utf-8", "x-request-id": requestId });
      res.end(offlinePage(`/${parsed.username}`));
      logReq(store, requestId, method, pathname, 502, Date.now() - started, 0, 0, "none", "anon");
      return;
    }
    adm = found as Admission;
  } else {
    const route = store.db.routes.find((r) => r.usernameLower === parsed!.username && r.slot === parsed!.slot);
    if (!route) {
      sendError(res, "NOT_FOUND", "No tunnel route at this path.", undefined, requestId);
      return;
    }
    const owner = store.db.users.find((u) => u.id === route.userId);
    if (!owner) {
      sendError(res, "NOT_FOUND", "Route owner not found.", undefined, requestId);
      return;
    }
    if (owner.status !== "active") {
      sendError(res, "ACCOUNT_SUSPENDED", "Route owner account is suspended.", undefined, requestId);
      return;
    }
    const routePath = parsed.slot === 1 ? `/${parsed.username}` : `/${parsed.username}/${parsed.slot}`;
    const tunnel = liveByRoute(routePath) ?? undefined;
    if (!tunnel) {
      res.writeHead(502, { "content-type": "text/html; charset=utf-8", "x-request-id": requestId });
      res.end(offlinePage(routePath));
      logReq(store, requestId, method, pathname, 502, Date.now() - started, 0, 0, "none", route.id);
      return;
    }
    // Quota gate (fail closed, server authoritative).
    const snap = snapshotFor(store, owner, cfg);
    const blocked = quotaBlockReason(snap);
    if (blocked) {
      sendError(res, blocked === "upload" ? "QUOTA_EXCEEDED_UPLOAD" : "QUOTA_EXCEEDED_DOWNLOAD", "Owner bandwidth quota exhausted for today.", undefined, requestId);
      return;
    }
    adm = { tunnel, userId: owner.id, anonSessionId: null, routeId: route.id, routePath, ownerName: owner.usernameLower };
  }

  // Read body bounded, with client-disconnect cancellation.
  const maxBody = adm.anonSessionId ? Math.min(cfg.maxBodyBytes, cfg.anonymousMaxBodyBytes) : cfg.maxBodyBytes;
  let body: Buffer;
  try {
    body = await readBounded(req, maxBody);
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === "PAYLOAD_TOO_LARGE") {
      sendError(res, "PAYLOAD_TOO_LARGE", "Request body exceeds the maximum size.", undefined, requestId);
      return;
    }
    sendError(res, "BAD_REQUEST", "Failed to read request body.", undefined, requestId);
    return;
  }

  const fwdPath = (parsed.rest || "/") + (rawUrl.includes("?") ? "?" + rawUrl.split("?").slice(1).join("?") : "");
  const headers = cleanHeaders(req.headers);
  headers["x-request-id"] = requestId;
  headers["x-forwarded-for"] = clientIp(req, cfg.trustProxy);
  const inboundProto = req.headers["x-forwarded-proto"];
  headers["x-forwarded-proto"] = cfg.trustProxy && typeof inboundProto === "string" && inboundProto.length > 0
    ? inboundProto.split(",")[0].trim()
    : "http";

  const wsUpgrade = (req.headers.upgrade || "").toLowerCase() === "websocket";
  if (wsUpgrade) {
    // Plain-HTTP gateway cannot complete a WS handshake without tunnel accept;
    // route through upgrade path instead.
    sendError(res, "BAD_REQUEST", "WebSocket must connect with an Upgrade request.", undefined, requestId);
    return;
  }

  // Mid-stream anon expiry: dispatch re-checks at admission; sweeper kills stale.
  if (adm.tunnel.expiresAt !== null && adm.tunnel.expiresAt <= Date.now()) {
    sendError(res, "ANON_EXPIRED", "Anonymous session expired.", undefined, requestId);
    return;
  }

  try {
    const out = await dispatchToTunnel(
      adm.tunnel,
      { requestId, method, path: fwdPath, headers, wsUpgrade: false },
      body,
      { cfg },
      { userId: adm.userId, anonSessionId: adm.anonSessionId, routeId: adm.routeId },
    );
    const total = out.chunks.reduce((n, c) => n + c.length, 0);
    if (adm.userId) addUsage(store, adm.userId, body.length, total);
    adm.tunnel.downBytes += total;
    const safe: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(out.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      safe[k] = v;
    }
    const ms = Date.now() - started;
    logReq(store, requestId, method, pathname, out.status, ms, body.length, total, adm.tunnel.id, adm.routeId);
    if (method === "HEAD") {
      res.writeHead(out.status, { ...safe, "x-request-id": requestId });
      res.end();
      return;
    }
    res.writeHead(out.status, { ...safe, "x-request-id": requestId });
    for (const c of out.chunks) {
      if (!res.write(c)) {
        await new Promise<void>((r) => res.once("drain", r));
      }
    }
    res.end();
  } catch (e: unknown) {
    const code = ((e as { code?: string }).code ?? "UPSTREAM_UNAVAILABLE") as
      | "UPSTREAM_UNAVAILABLE" | "GATEWAY_TIMEOUT" | "ANON_EXPIRED" | "RATE_LIMITED" | "PAYLOAD_TOO_LARGE";
    if (code === "GATEWAY_TIMEOUT") sendError(res, "GATEWAY_TIMEOUT", "Local application did not respond in time.", undefined, requestId);
    else if (code === "ANON_EXPIRED") sendError(res, "ANON_EXPIRED", "Anonymous session expired.", undefined, requestId);
    else if (code === "RATE_LIMITED") sendError(res, "RATE_LIMITED", "Tunnel is busy. Retry shortly.", undefined, requestId);
    else if (code === "PAYLOAD_TOO_LARGE") sendError(res, "PAYLOAD_TOO_LARGE", "Body too large.", undefined, requestId);
    else {
      res.writeHead(502, { "content-type": "text/html; charset=utf-8", "x-request-id": requestId });
      res.end(offlinePage(adm.routePath));
    }
    logReq(store, requestId, method, pathname, code === "GATEWAY_TIMEOUT" ? 504 : 502, Date.now() - started, body.length, 0, adm.tunnel.id, adm.routeId);
  }
}

interface AnonAdmission {
  tunnel: LiveTunnel | null;
  userId: null;
  anonSessionId: string;
  routeId: string;
  routePath: string;
  ownerName: string;
}

/** Returns the admission, "expired" when the session row exists but is no longer active, or null. */
function admitAnon(store: Store, token: string): AnonAdmission | "expired" | null {
  const sess = store.db.anonSessions.find((s) => s.pathToken === token);
  if (!sess) return null;
  if (sess.status !== "active" || sess.expiresAt <= Date.now()) return "expired";
  const routePath = `/${sess.pathToken}`;
  const tunnel = liveByRoute(routePath) ?? null;
  return { tunnel, userId: null, anonSessionId: sess.id, routeId: sess.id, routePath, ownerName: "anonymous" };
}

function readBounded(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        reject(Object.assign(new Error("too large"), { code: "PAYLOAD_TOO_LARGE" }));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("close", () => {
      if (!done) {
        done = true;
        reject(Object.assign(new Error("client disconnect"), { code: "BAD_REQUEST" }));
      }
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

function logReq(
  store: Store,
  requestId: string,
  method: string,
  path: string,
  status: number,
  ms: number,
  upBytes: number,
  downBytes: number,
  tunnelId: string,
  routeId: string,
): void {
  store.db.requestLogs.push({
    id: newId("rlog"),
    at: Date.now(),
    requestId,
    method,
    path: path.slice(0, 512),
    status,
    ms,
    upBytes,
    downBytes,
    tunnelId,
    routeId,
  });
  if (store.db.requestLogs.length > 2000) {
    store.db.requestLogs.splice(0, store.db.requestLogs.length - 2000);
  }
  store.markDirty();
  logger.debug("gateway request", { requestId, method, status, ms });
}

/** Bridge a public WebSocket client to the tunnel holding the route. */
export function handlePublicUpgrade(req: IncomingMessage, socket: Socket, head: Buffer, deps: GatewayDeps, wss: WebSocket.Server): void {
  const { store, cfg } = deps;
  const rawUrl = req.url || "/";
  const pathname = rawUrl.split("?")[0];
  let parsed: ReturnType<typeof parsePublicPath> = null;
  try {
    parsed = parsePublicPath(decodeURI(pathname));
  } catch {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  if (store.db.settings.maintenanceMode) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!parsed) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  let routePath: string;
  let tunnel: LiveTunnel | undefined;
  let userId: string | null = null;
  if (parsed.username.startsWith("a-")) {
    const sess = store.db.anonSessions.find((s) => s.pathToken === parsed!.username);
    if (!sess) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (sess.status !== "active" || sess.expiresAt <= Date.now()) {
      socket.write("HTTP/1.1 410 Gone\r\n\r\n");
      socket.destroy();
      return;
    }
    routePath = `/${sess.pathToken}`;
    tunnel = liveByRoute(routePath);
  } else {
    const route = store.db.routes.find((r) => r.usernameLower === parsed!.username && r.slot === parsed!.slot);
    if (!route) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const owner = store.db.users.find((u) => u.id === route.userId);
    if (!owner || owner.status !== "active") {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const snap = snapshotFor(store, owner, cfg);
    if (quotaBlockReason(snap)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    routePath = parsed.slot === 1 ? `/${parsed.username}` : `/${parsed.username}/${parsed.slot}`;
    tunnel = liveByRoute(routePath);
    userId = owner.id;
  }
  if (!tunnel || tunnel.ws.readyState !== 1) {
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
    return;
  }
  if (tunnel.expiresAt !== null && tunnel.expiresAt <= Date.now()) {
    socket.write("HTTP/1.1 410 Gone\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (publicWs) => {
    bridgeWs(publicWs, tunnel!, parsed!, req, deps, userId);
  });
}

function bridgeWs(
  publicWs: WebSocket,
  tunnel: LiveTunnel,
  parsed: { username: string; slot: number; rest: string },
  req: IncomingMessage,
  deps: GatewayDeps,
  userId: string | null,
): void {
  const { cfg } = deps;
  const requestId = newRequestId();
  const started = Date.now();
  const fwdPath = (parsed.rest || "/") + ((req.url || "").includes("?") ? "?" + (req.url || "").split("?").slice(1).join("?") : "");
  const headers = cleanHeaders(req.headers);
  const inboundProto = req.headers["x-forwarded-proto"];
  headers["x-forwarded-for"] = clientIp(req, cfg.trustProxy);
  headers["x-forwarded-proto"] = cfg.trustProxy && typeof inboundProto === "string" && inboundProto.length > 0
    ? inboundProto.split(",")[0].trim()
    : "http";
  const deadline = started + cfg.wsMaxLifetimeSeconds * 1000;
  let closed = false;
  let upBytes = 0;
  let downBytes = 0;

  const pending: import("../tunnels/registry").PendingRequest = {
    requestId,
    method: "GET",
    path: fwdPath,
    headers,
    body: [],
    bodyBytes: 0,
    resolve: () => undefined,
    // A tunnel-side failure (response_error / disconnect) must never leave the
    // public socket open until the lifetime cap: close it immediately.
    reject: () => cleanup(1011, "tunnel error"),
    timer: setTimeout(() => cleanup(4408, "ws accept timeout"), cfg.requestTimeoutMs),
    wsUpgrade: true,
    wsSocket: publicWs,
    startedAt: started,
    userId,
    anonSessionId: tunnel.anonSessionId,
    routeId: tunnel.routeId ?? tunnel.anonSessionId ?? "unknown",
  };
  pending.timer.unref?.();
  tunnel.pending.set(requestId, pending);
  tunnel.inFlight += 1;
  tunnel.ws.send(JSON.stringify({ type: "request_head", requestId, method: "GET", path: fwdPath, headers, wsUpgrade: true }));

  const lifetime = setTimeout(() => cleanup(1000, "ws lifetime exceeded"), cfg.wsMaxLifetimeSeconds * 1000);
  lifetime.unref?.();

  publicWs.on("message", (data, isBinary) => {
    if (closed) return;
    if (Date.now() > deadline) {
      cleanup(1000, "lifetime");
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (buf.length > cfg.wsMaxFrameBytes) {
      cleanup(1009, "frame too large");
      return;
    }
    upBytes += buf.length;
    tunnel.upBytes += buf.length;
    tunnel.ws.send(JSON.stringify({ type: "ws_frame", requestId, data: buf.toString("base64"), binary: !!isBinary }));
  });
  publicWs.on("close", () => {
    cleanup(-1, "public closed");
  });
  publicWs.on("error", () => cleanup(-1, "public error"));

  function cleanup(code: number, _reason: string): void {
    if (closed) return;
    closed = true;
    clearTimeout(lifetime);
    clearTimeout(pending.timer);
    tunnel.pending.delete(requestId);
    tunnel.inFlight = Math.max(0, tunnel.inFlight - 1);
    if (userId) {
      addUsage(deps.store, userId, upBytes, 0);
      deps.store.markDirty();
    }
    // Count tunneled bytes toward the meter even for anonymous (visible in tunnel metrics).
    tunnel.downBytes += downBytes;
    try {
      if (tunnel.ws.readyState === 1) tunnel.ws.send(JSON.stringify({ type: "ws_close", requestId, code: code > 0 ? code : 1000 }));
    } catch {
      undefined;
    }
    try {
      if (code > 0 && publicWs.readyState === 1) publicWs.close(code);
    } catch {
      undefined;
    }
  }

  // Tunnel -> public direction arrives via handler's ws_frame path; patch counter hook:
  (pending as unknown as { __countDown?: (n: number) => void }).__countDown = (n: number) => {
    downBytes += n;
  };
}
