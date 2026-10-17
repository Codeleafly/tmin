/** Live tunnel registry: in-memory source of reachability; DB owns route ownership. */
import type WebSocket from "ws";
import type { AppConfig } from "../../../../packages/shared/src/index";

export interface PendingRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer[];
  bodyBytes: number;
  resolve: (v: TunnelResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  wsUpgrade: boolean;
  wsSocket?: unknown;
  startedAt: number;
  userId: string | null;
  anonSessionId: string | null;
  routeId: string;
}

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  chunks: Buffer[];
}

export interface LiveTunnel {
  id: string;
  ws: WebSocket;
  userId: string | null;
  usernameLower: string | null; // owner name for registered tunnels
  anonSessionId: string | null;
  anonPathToken: string | null;
  routeId: string | null;
  routePath: string;
  slot: number;
  label: string;
  connectedAt: number;
  lastHeartbeat: number;
  expiresAt: number | null; // anonymous authoritative expiry
  pending: Map<string, PendingRequest>;
  inFlight: number;
  upBytes: number;
  downBytes: number;
}

interface Indexes {
  byId: Map<string, LiveTunnel>;
  /** routePath ("/name" or "/name/2") -> tunnel */
  byRoute: Map<string, LiveTunnel>;
}

const idx: Indexes = { byId: new Map(), byRoute: new Map() };

export function registerLive(t: LiveTunnel): void {
  idx.byId.set(t.id, t);
  idx.byRoute.set(t.routePath, t);
}

export function unregisterLive(id: string): LiveTunnel | undefined {
  const t = idx.byId.get(id);
  if (!t) return undefined;
  idx.byId.delete(id);
  if (idx.byRoute.get(t.routePath) === t) idx.byRoute.delete(t.routePath);
  // Fail all pending requests so gateway never hangs.
  for (const p of t.pending.values()) {
    clearTimeout(p.timer);
    p.reject(Object.assign(new Error("Tunnel disconnected"), { code: "UPSTREAM_UNAVAILABLE" }));
  }
  t.pending.clear();
  return t;
}

export function liveById(id: string): LiveTunnel | undefined {
  return idx.byId.get(id);
}

export function liveByRoute(routePath: string): LiveTunnel | undefined {
  return idx.byRoute.get(routePath);
}

export function liveCount(): number {
  return idx.byId.size;
}

export function liveForUser(userId: string): LiveTunnel[] {
  return [...idx.byId.values()].filter((t) => t.userId === userId);
}

export function allLive(): LiveTunnel[] {
  return [...idx.byId.values()];
}

/** Reconcile: is a DB tunnel row actually live? */
export function isLive(tunnelId: string): boolean {
  return idx.byId.has(tunnelId);
}

export function touchHeartbeat(t: LiveTunnel, now = Date.now()): void {
  t.lastHeartbeat = now;
}

export function staleTunnels(cfg: AppConfig, now = Date.now()): LiveTunnel[] {
  return allLive().filter((t) => now - t.lastHeartbeat > cfg.heartbeatTimeoutMs);
}

/** For tests: reset registry. */
export function __resetRegistry(): void {
  for (const t of idx.byId.values()) {
    for (const p of t.pending.values()) {
      clearTimeout(p.timer);
    }
  }
  idx.byId.clear();
  idx.byRoute.clear();
}
