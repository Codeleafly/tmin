/** Transactional route-slot allocation (prevents double-booking under concurrency). */
import { newId } from "../../../../packages/shared/src/index";
import type { Store, RouteRow } from "../db/store";

export async function allocateRoute(store: Store, userId: string, usernameLower: string, slot: number): Promise<RouteRow> {
  if (![1, 2, 3].includes(slot)) {
    throw Object.assign(new Error("Slot must be 1, 2 or 3."), { code: "BAD_REQUEST" });
  }
  return store.tx(() => {
    const existing = store.db.routes.find((r) => r.userId === userId && r.slot === slot);
    if (existing) {
      // Keep stable identity across reconnects: re-assert current owner name.
      existing.usernameLower = usernameLower;
      return existing;
    }
    // Slot row is per-user, so no cross-user conflict by construction.
    const row: RouteRow = { id: newId("rte"), userId, usernameLower, slot, createdAt: Date.now() };
    store.db.routes.push(row);
    return row;
  });
}

export async function releaseRoute(store: Store, userId: string, slot: number, isAdmin: boolean): Promise<boolean> {
  return store.tx(() => {
    const i = store.db.routes.findIndex((r) => (isAdmin || r.userId === userId) && (isAdmin ? true : r.userId === userId) && r.slot === slot);
    // For admin, slot alone is ambiguous — admin API passes explicit route id instead.
    if (i < 0) return false;
    store.db.routes.splice(i, 1);
    return true;
  });
}

export function routesForUser(store: Store, userId: string): RouteRow[] {
  return store.db.routes.filter((r) => r.userId === userId).sort((a, b) => a.slot - b.slot);
}
