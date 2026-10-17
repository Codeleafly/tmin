import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
