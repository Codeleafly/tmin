/** Tiny runtime validators (no zod: keeps install ~200 KB instead of MBs). */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown, max = 4096): v is string {
  return typeof v === "string" && v.length <= max;
}

export function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function int(v: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): v is number {
  return num(v) && Number.isInteger(v) && v >= min && v <= max;
}

export function port(v: unknown): v is number {
  return int(v, 1, 65535);
}

export function email(v: unknown): boolean {
  return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
