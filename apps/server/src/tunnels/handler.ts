/**
 * Tunnel control plane: WebSocket endpoint at /tunnel.
 * Outbound-only design: CLI dials out; public traffic rides this socket.
 * Server NEVER dials into the developer's network.
 */
import type WebSocket from "ws";
import { PROTOCOL_VERSION, validateClientFrame, asClientFrame, encodeChunk } from "../../../../packages/protocol/src/index";
import { parsePublicPath, newId, newRequestId, type AppConfig } from "../../../../packages/shared/src/index";
import type { Store } from "../db/store";
import { logger } from "../logger";
import { sha256Hex, anonPathToken, ipHash, newBearerToken } from "../auth/secrets";
import { audit } from "../auth/audit";
import {
  registerLive,
  unregisterLive,
  liveById,
  liveForUser,
  touchHeartbeat,
  type LiveTunnel,
  type PendingRequest,
  type TunnelResponse,
} from "./registry";
import { allocateRoute } from "./routes";
import { addUsage, snapshotFor, quotaBlockReason } from "../usage";

export interface TunnelDeps {
  store: Store;
  cfg: AppConfig;
}

interface HelloState {
  authed: boolean;
  userId: string | null;
  anonSessionId: string | null;
  anonResumeHash: string | null;
  tunnel: LiveTunnel | null;
  helloTimer: NodeJS.Timeout;
}

const anonResumeSecrets = new Map<string, string>(); // hash -> sessionId (single process; documented)

export function handleTunnelSocket(ws: WebSocket, deps: TunnelDeps, ip: string): void {
  const { store, cfg } = deps;
  const log = logger.child({ comp: "tunnel", ip });
  const state: HelloState = {
    authed: false,
    userId: null,
    anonSessionId: null,
    anonResumeHash: null,
    tunnel: null,
    helloTimer: setTimeout(() => {
      if (!state.authed) {
        send(ws, { type: "error", code: "PROTOCOL_ERROR", message: "Expected hello first.", fatal: true });
        ws.close(4401, "hello-timeout");
      }
    }, 10_000),
  };
  state.helloTimer.unref?.();

  const hb = setInterval(() => {
    if (ws.readyState !== 1) return;
    send(ws, { type: "heartbeat", at: Date.now() });
    const t = state.tunnel;
    if (t && Date.now() - t.lastHeartbeat > cfg.heartbeatTimeoutMs) {
      log.warn("tunnel heartbeat timeout", { tunnelId: t.id });
      send(ws, { type: "shutdown", reason: "Heartbeat timeout.", reconnectMs: 2000 });
      ws.close(4408, "heartbeat-timeout");
    }
  }, cfg.heartbeatIntervalMs);
  hb.unref?.();

  ws.on("message", (raw) => {
    void onMessage(String(raw)).catch((e) => {
      log.warn("tunnel message failed", { err: String(e) });
    });
  });

  ws.on("close", () => {
    clearTimeout(state.helloTimer);
    clearInterval(hb);
    if (state.tunnel) {
      const t = state.tunnel;
      unregisterLive(t.id);
      void store.tx(() => {
        const meta = store.db.tunnels.find((m) => m.id === t.id);
        if (meta && meta.status === "connected") {
          meta.status = "closed";
          meta.closedAt = Date.now();
          meta.upBytes = t.upBytes;
          meta.downBytes = t.downBytes;
        }
      }).catch(() => undefined);
      log.info("tunnel closed", { tunnelId: t.id, route: t.routePath });
    }
  });

  ws.on("error", () => undefined);

  async function onMessage(text: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      send(ws, { type: "error", code: "PROTOCOL_ERROR", message: "Frame must be JSON.", fatal: false });
      return;
    }
    const invalid = validateClientFrame(parsed);
    if (invalid) {
      send(ws, { type: "error", code: "PROTOCOL_ERROR", message: invalid, fatal: false });
      return;
    }
    const frame = asClientFrame(parsed);
    if (!state.authed) {
      if (frame.type !== "hello") {
        send(ws, { type: "error", code: "PROTOCOL_ERROR", message: "First frame must be hello.", fatal: true });
        ws.close(4401, "hello-required");
        return;
      }
      await handleHello(frame, ip);
      return;
    }
    switch (frame.type) {
      case "register":
        await handleRegister(frame.slot, frame.localPort, frame.target);
        return;
      case "heartbeat":
        if (state.tunnel) touchHeartbeat(state.tunnel);
        send(ws, { type: "heartbeat_ack", at: Date.now() });
        return;
      case "response_head":
      case "response_chunk":
      case "response_end":
      case "response_error":
        handleTunnelReply(frame);
        return;
      case "ws_opened":
      case "ws_frame":
      case "ws_closed":
        handleWsReply(frame);
        return;
      case "bye":
        ws.close(1000, "bye");
        return;
      case "hello":
        send(ws, { type: "error", code: "PROTOCOL_ERROR", message: "Already authenticated.", fatal: false });
        return;
    }
  }

  async function handleHello(frame: Extract<import("../../../../packages/protocol/src/index").ClientFrame, { type: "hello" }>, ipAddr: string): Promise<void> {
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      send(ws, {
        type: "error",
        code: "PROTOCOL_VERSION_MISMATCH",
        message: `Server speaks protocol ${PROTOCOL_VERSION}.`,
        fatal: true,
      });
      ws.close(4406, "version-mismatch");
      return;
    }
    if (frame.auth.mode === "token") {
      const hash = sha256Hex(frame.auth.token);
      const tok = store.db.tokens.find((t) => t.tokenHash === hash);
      if (!tok || tok.revokedAt !== null || (tok.expiresAt !== null && tok.expiresAt <= Date.now())) {
        send(ws, { type: "error", code: "TOKEN_REVOKED", message: "Token invalid, expired or revoked.", fatal: true });
        ws.close(4401, "bad-token");
        return;
      }
      const user = store.db.users.find((u) => u.id === tok.userId);
      if (!user || user.status !== "active") {
        send(ws, { type: "error", code: "ACCOUNT_SUSPENDED", message: "Account unavailable.", fatal: true });
        ws.close(4403, "account");
        return;
      }
      tok.lastUsedAt = Date.now();
      store.markDirty();
      state.authed = true;
      state.userId = user.id;
      clearTimeout(state.helloTimer);
      send(ws, {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        tunnelId: "pending",
        routePath: "",
        publicUrl: "",
        anonymous: false,
        expiresAt: null,
      });
      log.info("tunnel hello (token)", { user: user.usernameLower });
    } else {
      // Anonymous: abuse controls first.
      const active = store.db.anonSessions.filter((s) => s.status === "active" && s.expiresAt > Date.now());
      const perIp = active.filter((s) => s.ipHash === ipHash(ipAddr, cfg.sessionSecret)).length;
      if (perIp >= cfg.anonymousMaxPerIp) {
        send(ws, { type: "error", code: "ANON_LIMIT_REACHED", message: "Too many anonymous sessions from this address.", fatal: true });
        ws.close(4429, "anon-limit");
        return;
      }
      // Resume path: same session, ORIGINAL expiry preserved (never extended).
      const resume = (frame.auth as { resumeToken?: string }).resumeToken;
      if (typeof resume === "string" && resume.length > 0) {
        const sid = anonResumeSecrets.get(sha256Hex(resume));
        const sess = sid ? store.db.anonSessions.find((s) => s.id === sid) : undefined;
        if (sess && sess.status === "active" && sess.expiresAt > Date.now()) {
          state.authed = true;
          state.anonSessionId = sess.id;
          clearTimeout(state.helloTimer);
          send(ws, {
            type: "welcome",
            protocolVersion: PROTOCOL_VERSION,
            tunnelId: "pending",
            routePath: `/${sess.pathToken}`,
            publicUrl: `${cfg.publicBaseUrl.replace(/\/$/, "")}/${sess.pathToken}`,
            anonymous: true,
            expiresAt: sess.expiresAt,
          });
          log.info("anon tunnel resumed", { session: sess.id });
          return;
        }
      }
      const now = Date.now();
      const sess = {
        id: newId("anon"),
        pathToken: anonPathToken(),
        tunnelId: null as string | null,
        ipHash: ipHash(ipAddr, cfg.sessionSecret),
        createdAt: now,
        expiresAt: now + cfg.anonymousTtlSeconds * 1000,
        status: "active" as const,
      };
      await store.tx(() => {
        store.db.anonSessions.push(sess);
      });
      const resumeSecret = newBearerToken().secret;
      anonResumeSecrets.set(sha256Hex(resumeSecret), sess.id);
      state.authed = true;
      state.anonSessionId = sess.id;
      state.anonResumeHash = sha256Hex(resumeSecret);
      clearTimeout(state.helloTimer);
      send(ws, {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        tunnelId: "pending",
        routePath: `/${sess.pathToken}`,
        publicUrl: `${cfg.publicBaseUrl.replace(/\/$/, "")}/${sess.pathToken}`,
        anonymous: true,
        expiresAt: sess.expiresAt,
      });
      // Stash resume secret on the socket for the register reply.
      (ws as unknown as { __anonResume?: string }).__anonResume = resumeSecret;
      log.info("anon tunnel hello", { session: sess.id, expiresAt: sess.expiresAt });
    }
  }

  async function handleRegister(slot: number, localPort: number, target: string | undefined): Promise<void> {
    if (state.tunnel) {
      send(ws, { type: "error", code: "PROTOCOL_ERROR", message: "Already registered. Open a new connection for another tunnel.", fatal: false });
      return;
    }
    const now = Date.now();
    const base = cfg.publicBaseUrl.replace(/\/$/, "");
    if (state.userId) {
      const user = store.db.users.find((u) => u.id === state.userId);
      if (!user || user.status !== "active") {
        send(ws, { type: "error", code: "ACCOUNT_SUSPENDED", message: "Account unavailable.", fatal: true });
        ws.close(4403, "account");
        return;
      }
      const limit = user.maxTunnels === 0 ? cfg.freeMaxConcurrentTunnels : user.maxTunnels;
      const liveN = liveForUser(user.id).length;
      if (limit > 0 && liveN >= limit) {
        send(ws, {
          type: "error",
          code: "TUNNEL_LIMIT_REACHED",
          message: `Free accounts can run a maximum of ${limit} active tunnels.`,
          fatal: false,
        });
        audit(store, { actorId: user.id, actor: user.usernameLower, action: "tunnel.create", target: `slot:${slot}`, result: "denied:limit", ip });
        return;
      }
      const snap = snapshotFor(store, user, cfg, now);
      const blocked = quotaBlockReason(snap);
      if (blocked) {
        send(ws, {
          type: "error",
          code: blocked === "upload" ? "QUOTA_EXCEEDED_UPLOAD" : "QUOTA_EXCEEDED_DOWNLOAD",
          message: "Daily bandwidth quota exhausted. Try again after reset.",
          fatal: false,
        });
        return;
      }
      const route = await allocateRoute(store, user.id, user.usernameLower, slot);
      const routePath = slot === 1 ? `/${user.usernameLower}` : `/${user.usernameLower}/${slot}`;
      const tunnelId = newId("tun");
      const t: LiveTunnel = {
        id: tunnelId,
        ws,
        userId: user.id,
        usernameLower: user.usernameLower,
        anonSessionId: null,
        anonPathToken: null,
        routeId: route.id,
        routePath,
        slot,
        label: target || `localhost:${localPort}`,
        connectedAt: now,
        lastHeartbeat: now,
        expiresAt: null,
        pending: new Map(),
        inFlight: 0,
        upBytes: 0,
        downBytes: 0,
      };
      registerLive(t);
      state.tunnel = t;
      await store.tx(() => {
        store.db.tunnels.push({
          id: tunnelId,
          userId: user.id,
          routeId: route.id,
          routePath,
          slot,
          label: t.label,
          status: "connected",
          anon: false,
          anonSessionId: null,
          connectedAt: now,
          lastSeenAt: now,
          closedAt: null,
          upBytes: 0,
          downBytes: 0,
        });
      });
      audit(store, { actorId: user.id, actor: user.usernameLower, action: "tunnel.create", target: tunnelId, result: "ok", ip });
      send(ws, {
        type: "registered",
        tunnelId,
        routePath,
        publicUrl: base + routePath,
        slot,
        anonymous: false,
        expiresAt: null,
      });
      log.info("tunnel registered", { tunnelId, route: routePath });
    } else if (state.anonSessionId) {
      if (slot !== 1) {
        send(ws, { type: "error", code: "BAD_REQUEST", message: "Anonymous tunnels only support slot 1.", fatal: false });
        return;
      }
      const sess = store.db.anonSessions.find((s) => s.id === state.anonSessionId);
      if (!sess || sess.status !== "active" || sess.expiresAt <= Date.now()) {
        send(ws, { type: "error", code: "ANON_EXPIRED", message: "Anonymous session expired.", fatal: true });
        ws.close(4410, "anon-expired");
        return;
      }
      const routePath = `/${sess.pathToken}`;
      const tunnelId = newId("tun");
      const t: LiveTunnel = {
        id: tunnelId,
        ws,
        userId: null,
        usernameLower: null,
        anonSessionId: sess.id,
        anonPathToken: sess.pathToken,
        routeId: null,
        routePath,
        slot: 1,
        label: target || `localhost:${localPort}`,
        connectedAt: now,
        lastHeartbeat: now,
        expiresAt: sess.expiresAt,
        pending: new Map(),
        inFlight: 0,
        upBytes: 0,
        downBytes: 0,
      };
      registerLive(t);
      state.tunnel = t;
      await store.tx(() => {
        sess.tunnelId = tunnelId;
        store.db.tunnels.push({
          id: tunnelId,
          userId: null,
          routeId: null,
          routePath,
          slot: 1,
          label: t.label,
          status: "connected",
          anon: true,
          anonSessionId: sess.id,
          connectedAt: now,
          lastSeenAt: now,
          closedAt: null,
          upBytes: 0,
          downBytes: 0,
        });
      });
      const resume = (ws as unknown as { __anonResume?: string }).__anonResume;
      send(ws, {
        type: "registered",
        tunnelId,
        routePath,
        publicUrl: base + routePath,
        slot: 1,
        anonymous: true,
        expiresAt: sess.expiresAt,
        ...(resume ? { resumeToken: resume } : {}),
      });
      log.info("anon tunnel registered", { tunnelId, route: routePath });
    } else {
      send(ws, { type: "error", code: "PROTOCOL_ERROR", message: "Authenticate first.", fatal: true });
      ws.close(4401, "no-auth");
    }
  }

  function handleTunnelReply(frame: Extract<import("../../../../packages/protocol/src/index").ClientFrame, { type: "response_head" | "response_chunk" | "response_end" | "response_error" }>): void {
    const t = state.tunnel;
    if (!t) return;
    const p = t.pending.get(frame.requestId);
    if (!p) return;
    touchHeartbeat(t);
    if (frame.type === "response_head") {
      const chunks = p.resolve as unknown as { __head?: { status: number; headers: Record<string, string> } };
      chunks.__head = { status: frame.status, headers: frame.headers };
      return;
    }
    if (frame.type === "response_chunk") {
      try {
        const buf = Buffer.from(frame.data, "base64");
        if (buf.length > 64 * 1024) throw new Error("chunk too large");
        const resp = (p as unknown as { __resp?: TunnelResponse }).__resp ?? { status: 200, headers: {}, chunks: [] };
        const head = (p.resolve as unknown as { __head?: { status: number; headers: Record<string, string> } }).__head;
        if (head) {
          resp.status = head.status;
          resp.headers = head.headers;
        }
        resp.chunks.push(buf);
        (p as unknown as { __resp?: TunnelResponse }).__resp = resp;
        t.downBytes += buf.length;
      } catch {
        failPending(t, p, "PROTOCOL_ERROR");
      }
      return;
    }
    if (frame.type === "response_end") {
      const stored = (p as unknown as { __resp?: TunnelResponse }).__resp;
      const head = (p.resolve as unknown as { __head?: { status: number; headers: Record<string, string> } }).__head;
      clearTimeout(p.timer);
      t.pending.delete(p.requestId);
      t.inFlight = Math.max(0, t.inFlight - 1);
      if (stored) p.resolve(stored);
      else if (head) p.resolve({ status: head.status, headers: head.headers, chunks: [] });
      else p.resolve({ status: 502, headers: {}, chunks: [Buffer.from("Bad gateway: empty response")] });
      return;
    }
    failPending(t, p, "UPSTREAM_UNAVAILABLE");
  }

  function handleWsReply(frame: { type: string; requestId: string; data?: string; code?: number; binary?: boolean }): void {
    const t = state.tunnel;
    if (!t) return;
    const p = t.pending.get(frame.requestId);
    if (!p || !p.wsSocket) return;
    const sock = p.wsSocket as WebSocket;
    if (sock.readyState !== 1) return;
    if (frame.type === "ws_frame" && typeof frame.data === "string") {
      const buf = Buffer.from(frame.data, "base64");
      if (buf.length > 64 * 1024) {
        return;
      }
      t.downBytes += buf.length;
      if (p.userId) addUsage(store, p.userId, 0, buf.length);
      const count = (p as unknown as { __countDown?: (n: number) => void }).__countDown;
      count?.(buf.length);
      sock.send(buf, { binary: !!frame.binary });
    } else if (frame.type === "ws_closed") {
      try {
        sock.close(typeof frame.code === "number" ? frame.code : 1000);
      } catch {
        undefined;
      }
    } else if (frame.type === "ws_opened") {
      // Local side accepted the upgrade; nothing to do (socket already open).
    }
  }

  void parsePublicPath;
  void liveById;
  void addUsage;
}

function failPending(t: LiveTunnel, p: PendingRequest, code: string): void {
  clearTimeout(p.timer);
  t.pending.delete(p.requestId);
  t.inFlight = Math.max(0, t.inFlight - 1);
  p.reject(Object.assign(new Error("Upstream error"), { code }));
}

function send(ws: WebSocket, frame: unknown): void {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(frame));
  }
}

/**
 * Gateway -> tunnel dispatch with timeout, concurrency bound and chunked body.
 * Returns the full response (bounded by maxBodyBytes).
 */
export async function dispatchToTunnel(
  t: LiveTunnel,
  head: { requestId: string; method: string; path: string; headers: Record<string, string>; wsUpgrade: boolean },
  body: Buffer,
  deps: { cfg: AppConfig },
  meta: { userId: string | null; anonSessionId: string | null; routeId: string },
): Promise<TunnelResponse> {
  const { cfg } = deps;
  if (t.ws.readyState !== 1) throw Object.assign(new Error("Tunnel unavailable"), { code: "UPSTREAM_UNAVAILABLE" });
  // Authoritative anon expiry checked at admission AND enforced by sweeper mid-stream.
  if (t.expiresAt !== null && t.expiresAt <= Date.now()) {
    throw Object.assign(new Error("Anonymous session expired."), { code: "ANON_EXPIRED" });
  }
  if (t.inFlight >= cfg.maxConcurrentPerTunnel) {
    throw Object.assign(new Error("Tunnel busy, try again."), { code: "RATE_LIMITED" });
  }
  if (body.length > cfg.maxBodyBytes) throw Object.assign(new Error("Body too large."), { code: "PAYLOAD_TOO_LARGE" });

  return new Promise<TunnelResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      t.pending.delete(head.requestId);
      t.inFlight = Math.max(0, t.inFlight - 1);
      reject(Object.assign(new Error("Upstream timed out."), { code: "GATEWAY_TIMEOUT" }));
    }, cfg.requestTimeoutMs);
    timer.unref?.();
    const pending: PendingRequest = {
      requestId: head.requestId,
      method: head.method,
      path: head.path,
      headers: head.headers,
      body: [],
      bodyBytes: body.length,
      resolve,
      reject,
      timer,
      wsUpgrade: head.wsUpgrade,
      startedAt: Date.now(),
      userId: meta.userId,
      anonSessionId: meta.anonSessionId,
      routeId: meta.routeId,
    };
    t.pending.set(head.requestId, pending);
    t.inFlight += 1;
    t.upBytes += body.length;
    try {
      t.ws.send(JSON.stringify({
        type: "request_head",
        requestId: head.requestId,
        method: head.method,
        path: head.path,
        headers: head.headers,
        wsUpgrade: head.wsUpgrade,
      }));
      // Stream body in bounded chunks.
      const CH = 48 * 1024;
      for (let off = 0; off < body.length; off += CH) {
        const slice = body.subarray(off, Math.min(off + CH, body.length));
        t.ws.send(JSON.stringify({
          type: "request_chunk",
          requestId: head.requestId,
          data: slice.toString("base64"),
          last: off + CH >= body.length,
        }));
      }
      if (body.length === 0) {
        t.ws.send(JSON.stringify({ type: "request_chunk", requestId: head.requestId, data: "", last: true }));
      }
    } catch (e) {
      clearTimeout(timer);
      t.pending.delete(head.requestId);
      t.inFlight = Math.max(0, t.inFlight - 1);
      reject(e);
    }
  });
}

export function dispatchWsOpen(t: LiveTunnel, requestId: string, method: string, path: string, headers: Record<string, string>): void {
  t.ws.send(JSON.stringify({ type: "request_head", requestId, method, path, headers, wsUpgrade: true }));
  void encodeChunk;
  void newRequestId;
}
