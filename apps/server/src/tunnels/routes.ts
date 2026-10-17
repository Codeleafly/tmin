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

export function routesForUser(store: Store, userId: string): RouteRow[] {
  return store.db.routes.filter((r) => r.userId === userId).sort((a, b) => a.slot - b.slot);
}
