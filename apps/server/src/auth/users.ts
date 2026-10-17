import { validateUsername, hashPassword, newId } from "../../../../packages/shared/src/index";
import type { AppConfig } from "../../../../packages/shared/src/index";
import type { Store, UserRow } from "../db/store";
import { logger } from "../logger";

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
}

export async function registerUser(store: Store, input: RegisterInput): Promise<UserRow> {
  const v = validateUsername(input.username);
  if (!v.ok) {
    const err = new Error(v.message) as Error & { code: string };
    err.code = v.code;
    throw err;
  }
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    const err = new Error("Invalid email address.") as Error & { code: string };
    err.code = "BAD_REQUEST";
    throw err;
  }
  return store.tx(async () => {
    const lower = v.value;
    if (store.db.users.some((u) => u.usernameLower === lower)) {
      const err = new Error(`Username "${lower}" is already taken.`) as Error & { code: string };
      err.code = "USERNAME_TAKEN";
      throw err;
    }
    if (store.db.users.some((u) => u.email === email)) {
      const err = new Error("An account with this email already exists.") as Error & { code: string };
      err.code = "CONFLICT";
      throw err;
    }
    const passwordHash = await hashPassword(input.password);
    const now = Date.now();
    const row: UserRow = {
      id: newId("usr"),
      username: lower,
      usernameLower: lower,
      email,
      passwordHash,
      role: "user",
      status: "active",
      uploadLimit: 0,
      downloadLimit: 0,
      maxTunnels: 0,
      createdAt: now,
      updatedAt: now,
    };
    store.db.users.push(row);
    return row;
  });
}

/**
 * Initial admin bootstrap: creates admin ONLY on fresh DB.
 * Never overwrites an existing password on restart (see SECURITY.md).
 */
export async function bootstrapAdmin(store: Store, cfg: AppConfig): Promise<{ created: boolean; rotated: boolean }> {
  const existing = store.db.users.find((u) => u.usernameLower === cfg.adminUsername.toLowerCase() && u.role === "admin");
  if (existing) return { created: false, rotated: false };
  if (!cfg.adminPassword) {
    logger.warn("admin bootstrap skipped: ADMIN_PASSWORD is empty", {});
    return { created: false, rotated: false };
  }
  await store.tx(async () => {
    const now = Date.now();
    store.db.users.push({
      id: newId("usr"),
      username: cfg.adminUsername.toLowerCase(),
      usernameLower: cfg.adminUsername.toLowerCase(),
      email: cfg.adminEmail.toLowerCase(),
      passwordHash: await hashPassword(cfg.adminPassword),
      role: "admin",
      status: "active",
      uploadLimit: -1,
      downloadLimit: -1,
      maxTunnels: -1,
      createdAt: now,
      updatedAt: now,
    });
  });
  logger.info("admin bootstrapped", { username: cfg.adminUsername.toLowerCase() });
  return { created: true, rotated: false };
}

export function findUserByLogin(store: Store, login: string): UserRow | undefined {
  const l = login.trim().toLowerCase();
  return store.db.users.find((u) => u.usernameLower === l || u.email === l);
}

export function publicUser(u: UserRow, cfg: AppConfig): Record<string, unknown> {
  const base = cfg.publicBaseUrl.replace(/\/$/, "");
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    status: u.status,
    baseUrl: `${base}/${u.usernameLower}`,
    uploadLimit: u.uploadLimit === 0 ? cfg.freeUploadLimitBytes : u.uploadLimit,
    downloadLimit: u.downloadLimit === 0 ? cfg.freeDownloadLimitBytes : u.downloadLimit,
    maxTunnels: u.maxTunnels === 0 ? cfg.freeMaxConcurrentTunnels : u.maxTunnels,
    createdAt: u.createdAt,
  };
}
