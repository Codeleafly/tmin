/**
 * `tmin login` — three authentication methods:
 *   1. OAuth-style device flow (default): approve a code in the browser.
 *   2. `--token <secret>`: paste an existing API token.
 *   3. `--password`: classic username/email + password prompt (creates a token).
 * Secrets are never logged; only token prefixes are shown.
 */
import * as readline from "node:readline";
import { spawn } from "node:child_process";
import type { CliConfig } from "./config";
import { saveConfig, configPath } from "./config";
import { api, type ApiError } from "./api";

function ask(q: string, hidden: boolean): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: hidden ? undefined : process.stdout });
  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(q);
      let buf = "";
      const onData = (c: Buffer) => {
        const s = c.toString("utf8");
        if (s === "\n" || s === "\r") {
          process.stdin.off("data", onData);
          try {
            process.stdin.setRawMode?.(false);
          } catch {
            undefined;
          }
          process.stdout.write("\n");
          rl.close();
          resolve(buf);
        } else if (s === "\u0003") {
          process.exit(130);
        } else if (s === "\u007f") {
          buf = buf.slice(0, -1);
        } else {
          buf += s;
        }
      };
      try {
        process.stdin.setRawMode?.(true);
      } catch {
        undefined;
      }
      process.stdin.on("data", onData);
    } else {
      rl.question(q, (a) => {
        rl.close();
        resolve(a.trim());
      });
    }
  });
}

function pick(args: string[], ...names: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i]) && i + 1 < args.length) return args[i + 1];
  }
  return null;
}

function has(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isTermux(): boolean {
  return !!process.env.TERMUX_VERSION || (process.env.PREFIX || "").includes("com.termux");
}

/** Best-effort: open the verification URL in the user's browser. */
function openBrowser(url: string): void {
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";
  const attempts: Array<[string, string[]]> = [];
  if (isTermux()) attempts.push(["termux-open-url", [url]]);
  if (win) attempts.push(["cmd", ["/c", "start", "", url]]);
  else if (mac) attempts.push(["open", [url]]);
  else attempts.push(["xdg-open", [url]], ["termux-open-url", [url]]);
  let i = 0;
  const tryNext = (): void => {
    const a = attempts[i++];
    if (!a) return;
    try {
      const child = spawn(a[0], a[1], { stdio: "ignore", detached: true });
      child.on("error", () => tryNext());
      child.unref();
    } catch {
      tryNext();
    }
  };
  tryNext();
}

function prefixFromSecret(secret: string): string {
  const body = secret.startsWith("tmin_") ? secret.slice("tmin_".length) : secret;
  return `tm_${body.slice(0, 8)}`;
}

async function saveToken(cfg: CliConfig, token: string, prefix: string, username: string, json: boolean, method: string): Promise<number> {
  cfg.token = token;
  cfg.tokenPrefix = prefix;
  cfg.username = username;
  await saveConfig(cfg);
  if (json) {
    console.log(JSON.stringify({ ok: true, event: "logged_in", method, user: username, tokenPrefix: prefix }));
  } else {
    console.log(`✓ Logged in as ${username} (token ${prefix}…, stored with 0600 perms in ${configPath()}).`);
  }
  return 0;
}

/** Method 2: paste an existing API token. */
async function loginWithToken(cfg: CliConfig, rest: string[], json: boolean): Promise<number> {
  let token = pick(rest, "--token", "--api-key");
  if (!token) token = await ask("API token (tmin_…): ", true);
  token = token.trim();
  if (!token) {
    console.error("A token is required.");
    return 2;
  }
  const probe: CliConfig = { ...cfg, token };
  try {
    const me = await api<{ user: { username: string } }>(probe, "GET", "/api/v1/me");
    return await saveToken(cfg, token, prefixFromSecret(token), me.data.user.username, json, "token");
  } catch (e) {
    const err = e as ApiError;
    console.error(`Token rejected: ${err.message} [${err.code}]`);
    return 1;
  }
}

/** Method 3: classic username/password prompt (creates a fresh token). */
async function loginWithPassword(cfg: CliConfig, json: boolean): Promise<number> {
  const login = await ask("Username or email: ", false);
  const password = await ask("Password: ", true);
  if (!login || !password) {
    console.error("Login and password are required.");
    return 2;
  }
  const loginRes = await api<{ user: { username: string } }>(cfg, "POST", "/api/v1/auth/login", { login, password });
  const cookie = (loginRes.cookieOut || "").split(";")[0];
  const name = `cli-${new Date().toISOString().slice(0, 10)}`;
  const created = await api<{ token: { prefix: string }; secret: string }>(cfg, "POST", "/api/v1/tokens", { name }, cookie);
  return saveToken(cfg, created.data.secret, created.data.token.prefix, loginRes.data.user.username, json, "password");
}

/** Method 1: OAuth-style device flow (RFC 8628-inspired) — the default. */
async function loginWithDeviceFlow(cfg: CliConfig, rest: string[], json: boolean): Promise<number> {
  const authz = await api<{ device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number }>(
    cfg,
    "POST",
    "/api/v1/auth/device/authorize",
    { clientName: "tmin CLI" },
  );
  const d = authz.data;
  let interval = Math.max(2, d.interval || 5);

  if (json) {
    console.log(JSON.stringify({ ok: true, event: "device_authorization", userCode: d.user_code, verificationUri: d.verification_uri, verificationUriComplete: d.verification_uri_complete, expiresIn: d.expires_in, interval }));
  } else {
    console.log("");
    console.log(`  Your one-time code:  ${d.user_code}`);
    console.log(`  Open in browser:     ${d.verification_uri}`);
    console.log("");
    console.log(`Waiting for approval… (code expires in ${Math.round(d.expires_in / 60)} min, Ctrl+C to cancel)`);
  }
  if (!has(rest, "--no-browser")) openBrowser(d.verification_uri_complete || d.verification_uri);

  const deadline = Date.now() + (d.expires_in || 600) * 1000;
  for (;;) {
    await sleep(interval * 1000);
    if (Date.now() > deadline) {
      console.error("Login timed out. Run `tmin login` again.");
      return 1;
    }
    try {
      const r = await api<{ access_token: string; prefix: string; user: { username: string } }>(cfg, "POST", "/api/v1/auth/device/token", { device_code: d.device_code });
      return await saveToken(cfg, r.data.access_token, r.data.prefix, r.data.user.username, json, "device");
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "AUTHORIZATION_PENDING") continue;
      if (err.code === "SLOW_DOWN") {
        interval = Math.min(30, interval + 5);
        continue;
      }
      if (err.code === "ACCESS_DENIED") {
        console.error("The request was denied in the browser.");
        return 1;
      }
      if (err.code === "DEVICE_CODE_EXPIRED" || err.code === "INVALID_DEVICE_CODE") {
        console.error(`${err.message} Run \`tmin login\` again.`);
        return 1;
      }
      throw err;
    }
  }
}

export async function loginCommand(cfg: CliConfig, rest: string[], json: boolean): Promise<number> {
  const serverFlag = pick(rest, "--server", "-s");
  if (serverFlag) {
    cfg.server = serverFlag.replace(/\/$/, "");
    await saveConfig(cfg);
  }
  if (has(rest, "--token", "--api-key")) return loginWithToken(cfg, rest, json);
  if (has(rest, "--password")) return loginWithPassword(cfg, json);
  return loginWithDeviceFlow(cfg, rest, json);
}
