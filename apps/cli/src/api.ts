/** Minimal REST client for the CLI (redacts secrets, typed errors). */
import type { CliConfig } from "./config";

export interface ApiError extends Error {
  code: string;
  status: number;
}

function apiError(status: number, code: string, message: string): ApiError {
  const e = new Error(message) as ApiError;
  e.code = code;
  e.status = status;
  return e;
}

export async function api<T>(cfg: CliConfig, method: string, path: string, body?: unknown, cookie?: string): Promise<{ data: T; cookieOut?: string }> {
  const url = cfg.server.replace(/\/$/, "") + path;
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "tmin-cli" };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  if (cookie) headers.cookie = cookie;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e: unknown) {
    throw apiError(0, "CONNECTION_FAILED", `Cannot reach server ${cfg.server}: ${(e as Error).message}`);
  }
  const setCookie = res.headers.get("set-cookie") || undefined;
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const p = parsed as { error?: { code?: string; message?: string } } | null;
    throw apiError(res.status, p?.error?.code || "REQUEST_FAILED", p?.error?.message || `HTTP ${res.status}`);
  }
  return { data: (parsed ?? {}) as T, cookieOut: setCookie };
}

export function explain(e: ApiError): string {
  switch (e.code) {
    case "CONNECTION_FAILED":
      return e.message + "\nCheck `tmin config show` and `tmin doctor`.";
    case "TUNNEL_LIMIT_REACHED":
      return "Free accounts can run a maximum of 3 active tunnels. Stop one with `tmin stop <id>` (see `tmin tunnels`).";
    case "QUOTA_EXCEEDED_UPLOAD":
    case "QUOTA_EXCEEDED_DOWNLOAD":
      return "Daily bandwidth quota exhausted. See `tmin usage`. Resets at midnight UTC.";
    case "ANON_EXPIRED":
      return "Anonymous session expired. Start a new tunnel or `tmin login` for permanent URLs.";
    case "INVALID_CREDENTIALS":
      return "Invalid credentials. Try again.";
    case "AUTHORIZATION_PENDING":
      return "Waiting for you to approve the code in the browser…";
    case "SLOW_DOWN":
      return "Polling too fast; slowing down automatically.";
    case "ACCESS_DENIED":
      return "The device login request was denied in the browser.";
    case "INVALID_DEVICE_CODE":
    case "DEVICE_CODE_EXPIRED":
      return "Device code invalid or expired. Run `tmin login` again.";
    case "TOKEN_REVOKED":
      return "Saved token is revoked or expired. Run `tmin login` again.";
    case "NOT_AUTHENTICATED":
      return "Not logged in. Run `tmin login` or use --anonymous.";
    case "ROUTE_CONFLICT":
      return e.message;
    default:
      return `${e.message} [${e.code}]`;
  }
}
