/** Daily usage aggregates: in-memory hot counters flushed to the store. */
import type { AppConfig } from "../../../packages/shared/src/index";
import type { Store } from "./db/store";

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface UsageSnapshot {
  uploadUsed: number;
  downloadUsed: number;
  uploadLimit: number;
  downloadLimit: number;
  periodStart: string;
  periodEnd: string;
}

const hot = new Map<string, { up: number; down: number }>();

function key(userId: string, day: string): string {
  return `${userId}:${day}`;
}

export function addUsage(store: Store, userId: string, upBytes: number, downBytes: number, now = Date.now()): void {
  const day = dayKey(now);
  const k = key(userId, day);
  const cur = hot.get(k) ?? { up: 0, down: 0 };
  cur.up += upBytes;
  cur.down += downBytes;
  hot.set(k, cur);
}

/** Flush hot counters into durable rows (called every few seconds). */
export function flushUsage(store: Store, now = Date.now()): void {
  if (hot.size === 0) return;
  for (const [k, v] of hot) {
    const idx = k.lastIndexOf(":");
    const userId = k.slice(0, idx);
    const day = k.slice(idx + 1);
    let row = store.db.usage.find((r) => r.userId === userId && r.day === day);
    if (!row) {
      row = { userId, day, up: 0, down: 0, updatedAt: now };
      store.db.usage.push(row);
    }
    row.up += v.up;
    row.down += v.down;
    row.updatedAt = now;
  }
  hot.clear();
  store.markDirty();
}

export function readUsage(store: Store, userId: string, now = Date.now()): { up: number; down: number } {
  const day = dayKey(now);
  const row = store.db.usage.find((r) => r.userId === userId && r.day === day);
  const h = hot.get(key(userId, day));
  return { up: (row?.up ?? 0) + (h?.up ?? 0), down: (row?.down ?? 0) + (h?.down ?? 0) };
}

export function snapshotFor(
  store: Store,
  user: { id: string; role: string; uploadLimit: number; downloadLimit: number },
  cfg: AppConfig,
  now = Date.now(),
): UsageSnapshot {
  const { up, down } = readUsage(store, user.id, now);
  const d = new Date(now);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)).toISOString();
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999)).toISOString();
  if (user.role === "admin") {
    return { uploadUsed: up, downloadUsed: down, uploadLimit: -1, downloadLimit: -1, periodStart: start, periodEnd: end };
  }
  return {
    uploadUsed: up,
    downloadUsed: down,
    uploadLimit: user.uploadLimit === 0 ? cfg.freeUploadLimitBytes : user.uploadLimit,
    downloadLimit: user.downloadLimit === 0 ? cfg.freeDownloadLimitBytes : user.downloadLimit,
    periodStart: start,
    periodEnd: end,
  };
}

/** Fail-closed quota gate: returns blocking reason or null. */
export function quotaBlockReason(snap: UsageSnapshot): "upload" | "download" | null {
  if (snap.uploadLimit < 0 && snap.downloadLimit < 0) return null;
  if (snap.uploadLimit > 0 && snap.uploadUsed >= snap.uploadLimit) return "upload";
  if (snap.downloadLimit > 0 && snap.downloadUsed >= snap.downloadLimit) return "download";
  return null;
}
