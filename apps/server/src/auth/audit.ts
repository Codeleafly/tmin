import type { Store, AuditRow } from "../db/store";
import { newId } from "../../../../packages/shared/src/index";

export function audit(
  store: Store,
  entry: { actorId?: string | null; actor: string; action: string; target: string; result: string; ip: string },
): void {
  const row: AuditRow = {
    id: newId("aud"),
    at: Date.now(),
    actorId: entry.actorId ?? null,
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    result: entry.result,
    ip: entry.ip,
  };
  store.db.audit.push(row);
  // Retention cap: keep last 5000 (detailed pruning by age happens in sweeper).
  if (store.db.audit.length > 5000) {
    store.db.audit.splice(0, store.db.audit.length - 5000);
  }
  store.markDirty();
}
