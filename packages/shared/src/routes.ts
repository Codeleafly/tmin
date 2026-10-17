/**
 * Segment-aware route parsing.
 * Route forms: /<username> | /<username>/2 | /<username>/3 [/rest...]
 * Never substring-match: "/myapp2" is NOT "/myapp" + slot.
 */

export interface ParsedRoute {
  username: string;
  slot: number; // 1..3
  rest: string; // forwarded sub-path, always starts with "/" 
}

const MAX_SLOTS = 3;

export function parsePublicPath(pathname: string): ParsedRoute | null {
  // pathname must already be decoded-safe split; we handle encoding defensively.
  if (!pathname.startsWith("/")) return null;
  const withoutQuery = pathname.split("?")[0];
  // Collapse duplicate slashes but keep trailing-slash info.
  const cleaned = withoutQuery.replace(/\/{2,}/g, "/");
  const segs = cleaned.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) return null;
  const username = segs[0].toLowerCase();
  if (!username) return null;
  let slot = 1;
  let restStart = 1;
  if (segs.length >= 2 && /^[23]$/.test(segs[1])) {
    slot = Number(segs[1]);
    restStart = 2;
  }
  if (slot < 1 || slot > MAX_SLOTS) return null;
  const rest = "/" + segs.slice(restStart).join("/");
  return { username, slot, rest: rest === "/" ? "/" : rest };
}

export function routePathFor(username: string, slot: number): string {
  const u = username.toLowerCase();
  return slot === 1 ? `/${u}` : `/${u}/${slot}`;
}

export function publicUrlFor(baseUrl: string, username: string, slot: number): string {
  return baseUrl.replace(/\/$/, "") + routePathFor(username, slot);
}

export function isSlot(n: unknown): n is 1 | 2 | 3 {
  return n === 1 || n === 2 || n === 3;
}
