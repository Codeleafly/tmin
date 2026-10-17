/**
 * Byte-accounting convention (used everywhere: API, dashboard, CLI):
 *  - upload   = request-body bytes from public visitor delivered to local app
 *  - download = response-body bytes from local app returned to public visitor
 * Headers, TLS overhead and control frames are NOT counted.
 */

export interface QuotaState {
  uploadUsed: number;
  downloadUsed: number;
  uploadLimit: number; // bytes per period; 0 = unlimited (admin)
  downloadLimit: number;
  periodStart: string; // ISO
  periodEnd: string; // ISO
}

export function quotaRemaining(state: QuotaState): { uploadLeft: number; downloadLeft: number } {
  // Limits <= 0 mean unlimited (0 = plan default is resolved by the server; -1 = admin).
  return {
    uploadLeft: state.uploadLimit > 0 ? Math.max(0, state.uploadLimit - state.uploadUsed) : Number.MAX_SAFE_INTEGER,
    downloadLeft: state.downloadLimit > 0 ? Math.max(0, state.downloadLimit - state.downloadUsed) : Number.MAX_SAFE_INTEGER,
  };
}

export function quotaExhausted(state: QuotaState): "upload" | "download" | null {
  if (state.uploadLimit <= 0 && state.downloadLimit <= 0) return null;
  if (state.uploadLimit > 0 && state.uploadUsed >= state.uploadLimit) return "upload";
  if (state.downloadLimit > 0 && state.downloadUsed >= state.downloadLimit) return "download";
  return null;
}

export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function shouldWarn(used: number, limit: number, warnPercent: number): boolean {
  if (limit <= 0) return false;
  return used / limit >= warnPercent / 100;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}
