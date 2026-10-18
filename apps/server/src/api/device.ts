/**
 * OAuth-style device authorization flow (RFC 8628-inspired) for CLI login.
 * The CLI polls with a secret device_code; the user approves a short user_code in the browser.
 * Only hashes of device codes are stored; user codes are one-time and short-lived.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { isRecord, newId, type AppConfig } from "../../../../packages/shared/src/index";
import type { Store } from "../db/store";
import { sendJson, sendError, readJsonBody, clientIp } from "../http";
import { resolveAuth } from "../auth/context";
import { newBearerToken, sha256Hex } from "../auth/secrets";
import { audit } from "../auth/audit";

const DEVICE_TTL_MS = 600_000; // 10 minutes
const POLL_INTERVAL_SECONDS = 5;
// Crockford-style alphabet: no I, L, O, U, 0, 1 (avoids transcription mistakes).
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

function generateUserCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  return out;
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function handleDevice(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  cfg: AppConfig,
  path: string,
  requestId: string,
): Promise<boolean> {
  if (!path.startsWith("/api/v1/auth/device")) return false;
  const method = (req.method || "GET").toUpperCase();
  const ip = clientIp(req, cfg.trustProxy);
  const base = cfg.publicBaseUrl.replace(/\/$/, "");

  // POST /api/v1/auth/device/authorize — start a device login (public, rate-limited).
  if (method === "POST" && path === "/api/v1/auth/device/authorize") {
    const body = (await readJsonBody(req, 4096)) as Record<string, unknown>;
    const clientName =
      isRecord(body) && typeof body.clientName === "string" && body.clientName.trim()
        ? body.clientName.trim().slice(0, 64)
        : "tmin CLI";
    const deviceCode = randomBytes(32).toString("base64url");
    const now = Date.now();
    let userCode = generateUserCode();
    await store.tx(() => {
      for (let i = 0; i < 5; i++) {
        const clash = store.db.deviceAuths.some((d) => d.userCode === userCode && d.status === "pending" && d.expiresAt > now);
        if (!clash) break;
        userCode = generateUserCode();
      }
      store.db.deviceAuths.push({
        id: newId("dev"),
        deviceCodeHash: sha256Hex(deviceCode),
        userCode,
        clientName,
        createdAt: now,
        expiresAt: now + DEVICE_TTL_MS,
        intervalSeconds: POLL_INTERVAL_SECONDS,
        lastPollAt: null,
        status: "pending",
        userId: null,
        approvedAt: null,
      });
    });
    audit(store, { actor: "anonymous", action: "device.authorize", target: clientName, result: "ok", ip });
    sendJson(res, 201, {
      device_code: deviceCode,
      user_code: formatUserCode(userCode),
      verification_uri: `${base}/device`,
      verification_uri_complete: `${base}/device?code=${encodeURIComponent(formatUserCode(userCode))}`,
      expires_in: Math.floor(DEVICE_TTL_MS / 1000),
      interval: POLL_INTERVAL_SECONDS,
    }, requestId);
    return true;
  }

  // POST /api/v1/auth/device/token — CLI polls; returns the bearer token once approved.
  if (method === "POST" && path === "/api/v1/auth/device/token") {
    const body = (await readJsonBody(req, 4096)) as Record<string, unknown>;
    const deviceCode = isRecord(body) && typeof body.device_code === "string" ? body.device_code : "";
    if (!deviceCode) {
      sendError(res, "BAD_REQUEST", "device_code is required.", undefined, requestId);
      return true;
    }
    const row = store.db.deviceAuths.find((d) => d.deviceCodeHash === sha256Hex(deviceCode));
    if (!row || row.status === "consumed") {
      sendError(res, "INVALID_DEVICE_CODE", "Unknown device code.", undefined, requestId);
      return true;
    }
    const now = Date.now();
    if (row.expiresAt <= now && row.status !== "approved") {
      sendError(res, "DEVICE_CODE_EXPIRED", "This device code has expired. Run `tmin login` again.", undefined, requestId);
      return true;
    }
    if (row.status === "denied") {
      sendError(res, "ACCESS_DENIED", "The request was denied in the browser.", undefined, requestId);
      return true;
    }
    if (row.status === "pending") {
      if (row.lastPollAt !== null && now - row.lastPollAt < row.intervalSeconds * 1000) {
        sendError(res, "SLOW_DOWN", "Polling too fast; wait for the interval.", undefined, requestId);
        return true;
      }
      row.lastPollAt = now;
      store.markDirty();
      sendError(res, "AUTHORIZATION_PENDING", "The user has not approved this request yet.", undefined, requestId);
      return true;
    }
    // Approved: mint the bearer token exactly once.
    if (row.expiresAt <= now) {
      sendError(res, "DEVICE_CODE_EXPIRED", "This device code has expired. Run `tmin login` again.", undefined, requestId);
      return true;
    }
    const user = store.db.users.find((u) => u.id === row.userId);
    if (!user || user.status !== "active") {
      sendError(res, "ACCESS_DENIED", "The approving account is not active.", undefined, requestId);
      return true;
    }
    const { secret, prefix, hash } = newBearerToken();
    const tokenRow = {
      id: newId("tok"),
      userId: user.id,
      name: row.clientName || "cli-device",
      prefix,
      tokenHash: hash,
      scopes: ["tunnel", "api"],
      createdAt: now,
      expiresAt: null as number | null,
      lastUsedAt: null as number | null,
      revokedAt: null as number | null,
    };
    await store.tx(() => {
      store.db.tokens.push(tokenRow);
      row.status = "consumed";
    });
    audit(store, { actorId: user.id, actor: user.usernameLower, action: "device.token", target: tokenRow.id, result: "ok", ip });
    sendJson(res, 200, {
      access_token: secret,
      token_type: "Bearer",
      prefix,
      token: { id: tokenRow.id, name: tokenRow.name },
      user: { id: user.id, username: user.username },
      warning: "Store this secret now. It cannot be retrieved again.",
    }, requestId);
    return true;
  }

  // POST /api/v1/auth/device/verify — browser approves/denies a user_code (login required).
  if (method === "POST" && path === "/api/v1/auth/device/verify") {
    const ctx = resolveAuth(store, req);
    if (!ctx.user) {
      sendError(res, "NOT_AUTHENTICATED", "Log in first, then approve the device.", undefined, requestId);
      return true;
    }
    const body = (await readJsonBody(req, 4096)) as Record<string, unknown>;
    const action = isRecord(body) && (body.action === "approve" || body.action === "deny" || body.action === "check") ? body.action : null;
    const code = isRecord(body) && typeof body.user_code === "string" ? normalizeUserCode(body.user_code) : "";
    if (!action || code.length !== 8) {
      sendError(res, "BAD_REQUEST", "user_code (8 chars) and action (check|approve|deny) are required.", undefined, requestId);
      return true;
    }
    const row = store.db.deviceAuths.find((d) => d.userCode === code);
    if (!row) {
      sendError(res, "INVALID_DEVICE_CODE", "Unknown code. Check the characters and try again.", undefined, requestId);
      return true;
    }
    if (row.expiresAt <= Date.now()) {
      sendError(res, "DEVICE_CODE_EXPIRED", "This code has expired. Run `tmin login` again.", undefined, requestId);
      return true;
    }
    if (row.status !== "pending") {
      sendError(res, "CONFLICT", "This request has already been processed.", undefined, requestId);
      return true;
    }
    if (action === "check") {
      sendJson(res, 200, {
        ok: true,
        status: row.status,
        clientName: row.clientName,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }, requestId);
      return true;
    }
    await store.tx(() => {
      if (action === "approve") {
        row.status = "approved";
        row.userId = ctx.user!.id;
      } else {
        row.status = "denied";
      }
      row.approvedAt = Date.now();
    });
    audit(store, {
      actorId: ctx.user.id,
      actor: ctx.user.usernameLower,
      action: action === "approve" ? "device.approve" : "device.deny",
      target: `${row.id}:${row.clientName}`,
      result: "ok",
      ip,
    });
    sendJson(res, 200, { ok: true, status: row.status, clientName: row.clientName }, requestId);
    return true;
  }

  return false;
}
