/**
 * Durable JSON store with schema migrations and atomic writes.
 * Single-server mode: this file IS the database (documented in ARCHITECTURE.md).
 * Multi-instance mode: use Postgres (schema in docs/migrations-postgres.md, planned).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const SCHEMA_VERSION = 3;

export interface UserRow {
  id: string;
  username: string;
  usernameLower: string;
  email: string;
  passwordHash: string;
  role: "admin" | "user";
  status: "active" | "suspended";
  uploadLimit: number; // 0 = plan default; -1 = unlimited (admin)
  downloadLimit: number;
  maxTunnels: number; // 0 = plan default; -1 = unlimited (admin)
  createdAt: number;
  updatedAt: number;
}

export interface SessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
  ua: string;
  revokedAt: number | null;
}

export interface TokenRow {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  tokenHash: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface RouteRow {
  id: string;
  userId: string;
  usernameLower: string;
  slot: number;
  createdAt: number;
}

export interface AnonSessionRow {
  id: string;
  pathToken: string;
  tunnelId: string | null;
  ipHash: string;
  createdAt: number;
  expiresAt: number;
  status: "active" | "expired" | "closed";
}

export interface UsageRow {
  userId: string;
  day: string;
  up: number;
  down: number;
  updatedAt: number;
}

export interface ResetRow {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export interface AuditRow {
  id: string;
  at: number;
  actorId: string | null;
  actor: string;
  action: string;
  target: string;
  result: string;
  ip: string;
}

export interface RequestLogRow {
  id: string;
  at: number;
  requestId: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  upBytes: number;
  downBytes: number;
  tunnelId: string;
  routeId: string;
}

export interface TunnelMetaRow {
  id: string;
  userId: string | null;
  routeId: string | null;
  routePath: string;
  slot: number;
  label: string;
  status: "connected" | "closed";
  anon: boolean;
  anonSessionId: string | null;
  connectedAt: number;
  lastSeenAt: number;
  closedAt: number | null;
  upBytes: number;
  downBytes: number;
}

export interface DbShape {
  schemaVersion: number;
  users: UserRow[];
  sessions: SessionRow[];
  tokens: TokenRow[];
  routes: RouteRow[];
  anonSessions: AnonSessionRow[];
  usage: UsageRow[];
  resets: ResetRow[];
  audit: AuditRow[];
  requestLogs: RequestLogRow[];
  tunnels: TunnelMetaRow[];
  settings: { maintenanceMode: boolean };
}

export function emptyDb(): DbShape {
  return {
    schemaVersion: SCHEMA_VERSION,
    users: [],
    sessions: [],
    tokens: [],
    routes: [],
    anonSessions: [],
    usage: [],
    resets: [],
    audit: [],
    requestLogs: [],
    tunnels: [],
    settings: { maintenanceMode: false },
  };
}

/** Sequential migrations: v1 -> v2 -> v3. */
export function migrate(db: Record<string, unknown>): DbShape {
  const d = db as Partial<DbShape> & { version?: number };
  let v: number = typeof d.schemaVersion === "number" ? d.schemaVersion : (d.version ?? 0);
  const base: DbShape = {
    schemaVersion: 0,
    users: (d.users as DbShape["users"]) ?? [],
    sessions: (d.sessions as DbShape["sessions"]) ?? [],
    tokens: (d.tokens as DbShape["tokens"]) ?? [],
    routes: (d.routes as DbShape["routes"]) ?? [],
    anonSessions: (d.anonSessions as DbShape["anonSessions"]) ?? [],
    usage: (d.usage as DbShape["usage"]) ?? [],
    resets: (d.resets as DbShape["resets"]) ?? [],
    audit: (d.audit as DbShape["audit"]) ?? [],
    requestLogs: (d.requestLogs as DbShape["requestLogs"]) ?? [],
    tunnels: (d.tunnels as DbShape["tunnels"]) ?? [],
    settings: (d.settings as DbShape["settings"]) ?? { maintenanceMode: false },
  };
  if (v < 1) {
    // v1: normalize usernameLower, ensure role/status defaults
    for (const u of base.users) {
      u.usernameLower = (u.usernameLower || u.username || "").toLowerCase();
      if (u.role !== "admin") u.role = "user";
      if (u.status !== "suspended") u.status = "active";
    }
    v = 1;
  }
  if (v < 2) {
    // v2: per-user limit overrides + token prefixes for safe lookup
    for (const u of base.users) {
      if (typeof u.uploadLimit !== "number") u.uploadLimit = 0;
      if (typeof u.downloadLimit !== "number") u.downloadLimit = 0;
      if (typeof u.maxTunnels !== "number") u.maxTunnels = 0;
    }
    for (const t of base.tokens) {
      if (!t.prefix) t.prefix = `tm_${randomUUID().slice(0, 8)}`;
      if (!Array.isArray(t.scopes)) t.scopes = ["tunnel", "api"];
    }
    v = 2;
  }
  if (v < 3) {
    // v3: anon sessions + tunnel metadata tables
    if (!Array.isArray(base.anonSessions)) base.anonSessions = [];
    if (!Array.isArray(base.tunnels)) base.tunnels = [];
    v = 3;
  }
  base.schemaVersion = SCHEMA_VERSION;
  return base;
}

export class Store {
  db: DbShape;
  private file: string;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private saving = false;
  /** In-process mutex chain for transactional sections. */
  private chain: Promise<void> = Promise.resolve();

  constructor(db: DbShape, file: string) {
    this.db = db;
    this.file = file;
  }

  static async open(dir: string, file: string): Promise<Store> {
    await fs.mkdir(dir, { recursive: true });
    const full = path.join(dir, file);
    let db: DbShape;
    try {
      const raw = await fs.readFile(full, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      db = migrate(parsed);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        db = emptyDb();
        await fs.writeFile(full + ".tmp", JSON.stringify(db, null, 2));
        await fs.rename(full + ".tmp", full);
      } else {
        throw err;
      }
    }
    const store = new Store(db, full);
    store.timer = setInterval(() => {
      void store.flush().catch(() => undefined);
    }, 2000);
    store.timer.unref?.();
    return store;
  }

  markDirty(): void {
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty || this.saving) return;
    this.saving = true;
    try {
      const tmp = this.file + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(this.db));
      await fs.rename(tmp, this.file);
      this.dirty = false;
    } finally {
      this.saving = false;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  /** Run fn exclusively (serializes concurrent allocations). */
  async tx<T>(fn: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.chain;
    this.chain = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    try {
      const out = await fn();
      this.markDirty();
      return out;
    } finally {
      release();
    }
  }
}
