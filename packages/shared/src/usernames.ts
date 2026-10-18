/** Username rules: single source of truth (server authoritative). */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-_]{1,30}[a-z0-9])?$/;

export const RESERVED_NAMES = new Set([
  "api", "admin", "dashboard", "docs", "login", "logout", "assets",
  "health", "ready", "metrics", "tunnel", "tunnels", "favicon", "static",
  "www", "mail", "root", "support", "status", "help", "about",
  "settings", "config", "auth", "register", "signup", "signin",
  "websocket", "ws", "public", "private", "null", "undefined",
  "anonymous", "anon", "share", "s", "t", "u", "go", "r", "device",
]);

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export type UsernameError =
  | "USERNAME_TOO_SHORT"
  | "USERNAME_TOO_LONG"
  | "USERNAME_INVALID_CHARS"
  | "USERNAME_RESERVED";

export function validateUsername(raw: string): { ok: true; value: string } | { ok: false; code: UsernameError; message: string } {
  const value = normalizeUsername(raw);
  if (value.length < USERNAME_MIN) {
    return { ok: false, code: "USERNAME_TOO_SHORT", message: `Username must be at least ${USERNAME_MIN} characters.` };
  }
  if (value.length > USERNAME_MAX) {
    return { ok: false, code: "USERNAME_TOO_LONG", message: `Username must be at most ${USERNAME_MAX} characters.` };
  }
  // "a-" prefix is the anonymous tunnel namespace; reserving it prevents route shadowing.
  if (value.startsWith("a-")) {
    return { ok: false, code: "USERNAME_RESERVED", message: "Usernames may not start with \"a-\" (reserved for anonymous tunnels)." };
  }
  if (RESERVED_NAMES.has(value)) {
    return { ok: false, code: "USERNAME_RESERVED", message: `Username "${value}" is reserved.` };
  }
  if (!USERNAME_RE.test(value)) {
    return {
      ok: false,
      code: "USERNAME_INVALID_CHARS",
      message: "Username may contain lowercase letters, digits, hyphen and underscore; must start and end with a letter or digit.",
    };
  }
  return { ok: true, value };
}
