/** Background sweeper: anon expiry, stale tunnels, retention, usage flush, restart recovery. */
import type { AppConfig } from "../../../packages/shared/src/index";
import type { Store } from "./db/store";
import { allLive, unregisterLive, staleTunnels } from "./tunnels/registry";
import { flushUsage } from "./usage";
import { audit } from "./auth/audit";
import { logger } from "./logger";

export function recoverAfterRestart(store: Store): void {
  const now = Date.now();
  let closed = 0;
  for (const m of store.db.tunnels) {
    if (m.status === "connected") {
      m.status = "closed";
      m.closedAt = now;
      closed++;
    }
  }
  let expired = 0;
  for (const s of store.db.anonSessions) {
    if (s.status === "active" && s.expiresAt <= now) {
      s.status = "expired";
      expired++;
    }
  }
  if (closed || expired) {
    logger.info("restart recovery", { tunnelsClosed: closed, anonExpired: expired });
    store.markDirty();
  }
}

export function startSweeper(store: Store, cfg: AppConfig): NodeJS.Timeout {
  const tick = () => {
    try {
      sweepOnce(store, cfg);
    } catch (e) {
      logger.warn("sweeper tick failed", { err: String(e) });
    }
  };
  const t = setInterval(tick, Math.min(cfg.anonCleanupIntervalMs, 30_000));
  t.unref?.();
  // Usage flush on its own cadence.
  const f = setInterval(() => {
    try {
      flushUsage(store);
    } catch {
      undefined;
    }
  }, 5000);
  f.unref?.();
  return t;
}

export function sweepOnce(store: Store, cfg: AppConfig, now = Date.now()): { expiredAnon: number; staleClosed: number } {
  let expiredAnon = 0;
  let staleClosed = 0;
  // 1. Authoritative anonymous expiry (fallback to per-connection timers).
  for (const s of store.db.anonSessions) {
    if (s.status === "active" && s.expiresAt <= now) {
      s.status = "expired";
      expiredAnon++;
      if (s.tunnelId) {
        const live = allLive().find((l) => l.id === s.tunnelId);
        if (live) {
          try {
            live.ws.send(JSON.stringify({ type: "shutdown", reason: `Anonymous session expired after ${Math.round(cfg.anonymousTtlSeconds)}s.`, reconnectMs: 0 }));
            live.ws.close(4410, "anon-expired");
          } catch {
            undefined;
          }
          unregisterLive(live.id);
          staleClosed++;
        }
        const meta = store.db.tunnels.find((m) => m.id === s.tunnelId);
        if (meta && meta.status === "connected") {
          meta.status = "closed";
          meta.closedAt = now;
        }
      }
      audit(store, { actor: "system", action: "anon.expire", target: s.id, result: "ok", ip: "-" });
    }
  }
  // 2. Dead-connection detection.
  for (const t of staleTunnels(cfg, now)) {
    try {
      t.ws.send(JSON.stringify({ type: "shutdown", reason: "Heartbeat timeout.", reconnectMs: 2000 }));
      t.ws.close(4408, "heartbeat-timeout");
    } catch {
      undefined;
    }
    unregisterLive(t.id);
    const meta = store.db.tunnels.find((m) => m.id === t.id);
    if (meta && meta.status === "connected") {
      meta.status = "closed";
      meta.closedAt = now;
      meta.upBytes = t.upBytes;
      meta.downBytes = t.downBytes;
    }
    staleClosed++;
  }
  // 3. Retention pruning.
  const reqCut = now - cfg.requestLogRetentionDays * 86400_000;
  if (store.db.requestLogs.length > 0) {
    store.db.requestLogs = store.db.requestLogs.filter((r) => r.at >= reqCut).slice(-2000);
  }
  const audCut = now - cfg.auditRetentionDays * 86400_000;
  if (store.db.audit.length > 0) {
    store.db.audit = store.db.audit.filter((a) => a.at >= audCut).slice(-5000);
  }
  // Device auth requests: keep for an hour after expiry (so polling gets DEVICE_CODE_EXPIRED).
  if (store.db.deviceAuths.length > 0) {
    const devCut = now - 3600_000;
    store.db.deviceAuths = store.db.deviceAuths.filter((d) => d.expiresAt > devCut);
  }
  if (expiredAnon || staleClosed) {
    logger.info("sweeper", { expiredAnon, staleClosed });
    store.markDirty();
  }
  return { expiredAnon, staleClosed };
}
