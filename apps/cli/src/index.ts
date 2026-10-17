#!/usr/bin/env node
/** tmin CLI — cross-platform, zero deps beyond ws. */
import * as readline from "node:readline";
import * as dns from "node:dns";
import * as net from "node:net";
import { loadConfig, saveConfig, readRuntime, removeRuntime, configPath, type CliConfig } from "./config";
import { api, explain, type ApiError } from "./api";
import { runHttpTunnel } from "./forward";

export const VERSION = "0.1.0";
const PROTOCOL_VERSION = 1;

function help(): string {
  return `tmin ${VERSION} — expose local apps through your own tunnel server.

Usage:
  tmin http <port> [--slot 1|2|3] [--anonymous] [--target-host 127.0.0.1] [--json]
  tmin login [--server URL]            Log in (token stored with 0600 perms)
  tmin logout                          Revoke token and clear local config
  tmin status [--json]                 Connection state + account summary
  tmin tunnels [--json]                List server-side tunnels
  tmin stop <tunnel-id>                Terminate a tunnel
  tmin token create [--name N] [--days D]   Create API token (secret shown once)
  tmin token list [--json]             List tokens (prefixes only)
  tmin token revoke <token-id>         Revoke a token
  tmin account [--json]                Show current account
  tmin usage [--json]                  Show bandwidth usage + quota
  tmin route list [--json]             List route assignments
  tmin route release <slot>            Release a route slot (must be offline)
  tmin config set server <url>         Set server address
  tmin config show                     Show config (secrets redacted)
  tmin doctor                          Connectivity diagnostics (no secrets printed)
  tmin update                          Update instructions
  tmin version                          Print version
`;
}

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

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const json = has(argv, "--json");
  let cfg = await loadConfig();

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(json ? JSON.stringify({ version: VERSION, commands: ["http", "login", "logout", "status"] }) : help());
    return 0;
  }

  try {
    switch (cmd) {
      case "version":
      case "--version":
      case "-V":
        console.log(json ? JSON.stringify({ version: VERSION, protocol: PROTOCOL_VERSION }) : `tmin ${VERSION} (protocol ${PROTOCOL_VERSION})`);
        return 0;

      case "http": {
        const port = Number(rest[0]);
        if (!rest[0] || !Number.isInteger(port)) {
          console.error("Usage: tmin http <port> [--slot N] [--anonymous]");
          return 2;
        }
        const slot = Number(pick(rest, "--slot") || "1");
        return runHttpTunnel(cfg, {
          port,
          slot,
          anonymous: has(rest, "--anonymous", "--anon"),
          targetHost: pick(rest, "--target-host") || "127.0.0.1",
          json,
        });
      }

      case "login": {
        const serverFlag = pick(rest, "--server", "-s");
        if (serverFlag) {
          cfg.server = serverFlag.replace(/\/$/, "");
          await saveConfig(cfg);
        }
        const login = await ask("Username or email: ", false);
        const password = await ask("Password: ", true);
        if (!login || !password) {
          console.error("Login and password are required.");
          return 2;
        }
        const { cookieOut } = await api<{ user: { username: string } }>(cfg, "POST", "/api/v1/auth/login", { login, password });
        const cookie = (cookieOut || "").split(";")[0];
        const name = `cli-${new Date().toISOString().slice(0, 10)}`;
        const created = await api<{ token: { id: string; prefix: string }; secret: string }>(cfg, "POST", "/api/v1/tokens", { name }, cookie);
        cfg.token = created.data.secret;
        cfg.tokenPrefix = created.data.token.prefix;
        cfg.username = login.toLowerCase();
        await saveConfig(cfg);
        console.log(json ? JSON.stringify({ ok: true, user: cfg.username }) : `Logged in as ${cfg.username} (token ${created.data.token.prefix}…, stored in ${configPath()}).`);
        return 0;
      }

      case "logout": {
        if (cfg.token) {
          // Best-effort revoke of own token is not directly addressable; clear local state.
          try {
            const list = await api<{ tokens: Array<{ id: string; prefix: string }> }>(cfg, "GET", "/api/v1/tokens");
            const mine = list.data.tokens.find((t) => t.prefix === cfg.tokenPrefix);
            if (mine) await api(cfg, "DELETE", `/api/v1/tokens/${mine.id}`);
          } catch {
            undefined;
          }
        }
        cfg.token = null;
        cfg.tokenPrefix = null;
        cfg.username = null;
        await saveConfig(cfg);
        console.log(json ? JSON.stringify({ ok: true }) : "Logged out. Local token cleared.");
        return 0;
      }

      case "status": {
        const local = await readRuntime();
        let server: unknown = null;
        if (cfg.token) {
          try {
            const me = await api(cfg, "GET", "/api/v1/me");
            server = (me.data as { user: unknown }).user;
          } catch {
            server = null;
          }
        }
        if (json) {
          console.log(JSON.stringify({ server: cfg.server, user: cfg.username, tokenPrefix: cfg.tokenPrefix, account: server, localTunnels: local }));
        } else {
          console.log(`Server: ${cfg.server}\nUser: ${cfg.username || "(not logged in)"}${cfg.tokenPrefix ? ` (token ${cfg.tokenPrefix}…)` : ""}`);
          if (local.length === 0) console.log("No tunnels running in this CLI.");
          for (const t of local) {
            const age = Math.floor((Date.now() - t.startedAt) / 1000);
            let extra = `up ${age}s`;
            if (t.anonymous && t.expiresAt) extra += `, expires in ${Math.max(0, Math.floor((t.expiresAt - Date.now()) / 1000))}s`;
            console.log(`  ● ${t.publicUrl} → :${t.localPort} [${t.tunnelId}] ${extra}`);
          }
        }
        return 0;
      }

      case "tunnels": {
        const r = await api<{ tunnels: Array<{ id: string; routePath: string; publicUrl: string; status: string; label: string }> }>(cfg, "GET", "/api/v1/tunnels");
        if (json) console.log(JSON.stringify(r.data));
        else if (r.data.tunnels.length === 0) console.log("No tunnels.");
        else for (const t of r.data.tunnels) console.log(`${t.status === "online" ? "●" : "○"} ${t.publicUrl} (${t.id}) → ${t.label} [${t.status}]`);
        return 0;
      }

      case "stop": {
        const id = rest[0];
        if (!id) {
          console.error("Usage: tmin stop <tunnel-id>");
          return 2;
        }
        await api(cfg, "DELETE", `/api/v1/tunnels/${id}`);
        await removeRuntime(id).catch(() => undefined);
        console.log(json ? JSON.stringify({ ok: true }) : `Tunnel ${id} stopped.`);
        return 0;
      }

      case "token": {
        const sub = rest[0];
        if (sub === "create") {
          const name = pick(rest, "--name", "-n") || "cli";
          const days = pick(rest, "--days", "-d");
          const r = await api<{ token: { id: string; prefix: string }; secret: string }>(cfg, "POST", "/api/v1/tokens", { name, ...(days ? { expiresInDays: Number(days) } : {}) });
          if (json) console.log(JSON.stringify(r.data));
          else {
            console.log(`Token ${r.data.token.prefix}… created.\nSECRET (copy now, shown once):\n${r.data.secret}`);
          }
          return 0;
        }
        if (sub === "list") {
          const r = await api<{ tokens: unknown[] }>(cfg, "GET", "/api/v1/tokens");
          if (json) console.log(JSON.stringify(r.data));
          else for (const t of r.data.tokens as Array<{ prefix: string; name: string; id: string }>) console.log(`${t.prefix}…  ${t.name}  (${t.id})`);
          return 0;
        }
        if (sub === "revoke") {
          const id = rest[1];
          if (!id) {
            console.error("Usage: tmin token revoke <token-id>");
            return 2;
          }
          await api(cfg, "DELETE", `/api/v1/tokens/${id}`);
          console.log(json ? JSON.stringify({ ok: true }) : "Token revoked.");
          return 0;
        }
        console.error("Usage: tmin token <create|list|revoke>");
        return 2;
      }

      case "account": {
        const r = await api(cfg, "GET", "/api/v1/me");
        if (json) console.log(JSON.stringify(r.data));
        else {
          const u = (r.data as { user: Record<string, unknown> }).user;
          console.log(`${u.username} (${u.role})\nBase URL: ${u.baseUrl}\nMax tunnels: ${u.maxTunnels}`);
        }
        return 0;
      }

      case "usage": {
        const r = await api(cfg, "GET", "/api/v1/me/usage");
        if (json) console.log(JSON.stringify(r.data));
        else {
          const u = (r.data as { usage: { uploadUsed: number; uploadLimit: number; downloadUsed: number; downloadLimit: number; periodEnd: string } }).usage;
          const f = (n: number) => (n < 0 ? "∞" : `${(n / 1048576).toFixed(1)} MB`);
          console.log(`Upload:   ${f(u.uploadUsed)} / ${f(u.uploadLimit)}\nDownload: ${f(u.downloadUsed)} / ${f(u.downloadLimit)}\nResets: ${u.periodEnd}`);
        }
        return 0;
      }

      case "route": {
        const sub = rest[0];
        if (sub === "list") {
          const r = await api(cfg, "GET", "/api/v1/me/routes");
          if (json) console.log(JSON.stringify(r.data));
          else {
            const d = r.data as { routes: Array<{ path: string; publicUrl: string; online: boolean }>; availableSlots: number[] };
            for (const x of d.routes) console.log(`${x.online ? "●" : "○"} ${x.publicUrl}`);
            console.log(`Free slots: ${d.availableSlots.join(", ") || "none"}`);
          }
          return 0;
        }
        if (sub === "release") {
          const slot = Number(rest[1]);
          if (![1, 2, 3].includes(slot)) {
            console.error("Usage: tmin route release <1|2|3>");
            return 2;
          }
          const list = await api<{ routes: Array<{ id: string; slot: number }> }>(cfg, "GET", "/api/v1/me/routes");
          const route = list.data.routes.find((x) => x.slot === slot);
          if (!route) {
            console.error(`No route assigned for slot ${slot}.`);
            return 1;
          }
          await api(cfg, "DELETE", `/api/v1/routes/${route.id}`);
          console.log(json ? JSON.stringify({ ok: true }) : `Route slot ${slot} released.`);
          return 0;
        }
        console.error("Usage: tmin route <list|release>");
        return 2;
      }

      case "config": {
        const sub = rest[0];
        if (sub === "set" && rest[1] === "server" && rest[2]) {
          cfg.server = rest[2].replace(/\/$/, "");
          await saveConfig(cfg);
          console.log(`Server set to ${cfg.server}`);
          return 0;
        }
        if (sub === "show") {
          const safe = { server: cfg.server, username: cfg.username, token: cfg.token ? `${cfg.tokenPrefix}… (redacted)` : null, configFile: configPath() };
          if (json) console.log(JSON.stringify(safe));
          else console.log(`server: ${safe.server}\nuser: ${safe.username || "-"}\ntoken: ${safe.token || "-"}\nfile: ${safe.configFile}`);
          return 0;
        }
        console.error("Usage: tmin config <set server <url>|show>");
        return 2;
      }

      case "doctor":
        return await doctor(cfg, json);

      case "update": {
        console.log(json ? JSON.stringify({ version: VERSION }) : `tmin ${VERSION} — update by pulling this repo and rebuilding:\n  git pull && npm install && npm run build\n(Auto-update from a registry is planned, not implemented.)`);
        return 0;
      }

      default:
        console.error(`Unknown command: ${cmd}\n` + help());
        return 2;
    }
  } catch (e: unknown) {
    const err = e as ApiError;
    if (json) console.log(JSON.stringify({ ok: false, code: err.code || "ERROR", message: err.message }));
    else console.error(`Error: ${explain(err)}`);
    return 1;
  }
}

async function doctor(cfg: CliConfig, jsonOut: boolean): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  // 1. server URL parses
  let u: URL | null = null;
  try {
    u = new URL(cfg.server);
    checks.push({ name: "server-address", ok: true, detail: cfg.server });
  } catch {
    checks.push({ name: "server-address", ok: false, detail: `Invalid server URL: ${cfg.server}` });
  }
  // 2. DNS
  if (u) {
    try {
      const host = u.hostname;
      if (net.isIP(host)) {
        checks.push({ name: "dns", ok: true, detail: `${host} (literal IP)` });
      } else {
        await dns.promises.lookup(host);
        checks.push({ name: "dns", ok: true, detail: `${host} resolves` });
      }
    } catch {
      checks.push({ name: "dns", ok: false, detail: `Cannot resolve ${u.hostname}` });
    }
    // 3. TCP/TLS reachability
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    const tls = u.protocol === "https:";
    const tcpOk = await new Promise<boolean>((resolve) => {
      const s = (tls ? require("node:tls").connect : net.connect)({ host: u!.hostname, port, timeout: 8000 }, () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
      s.on("timeout", () => {
        s.destroy();
        resolve(false);
      });
    });
    checks.push({ name: tls ? "tls-connectivity" : "tcp-connectivity", ok: tcpOk, detail: tcpOk ? `${u.hostname}:${port} reachable` : `${u.hostname}:${port} unreachable` });
    // 4. HTTP health + protocol version
    try {
      const h = await fetch(cfg.server.replace(/\/$/, "") + "/health").then((r) => r.json()) as { ok?: boolean };
      checks.push({ name: "server-health", ok: h.ok === true, detail: h.ok ? "GET /health ok" : "unexpected /health response" });
    } catch (e: unknown) {
      checks.push({ name: "server-health", ok: false, detail: `GET /health failed: ${(e as Error).message}` });
    }
    checks.push({ name: "protocol", ok: true, detail: `CLI protocol ${PROTOCOL_VERSION} (server negotiates on connect)` });
    // 5. auth state (no secrets printed)
    if (cfg.token) {
      try {
        const me = await api<{ user: { username: string } }>(cfg, "GET", "/api/v1/me");
        checks.push({ name: "auth", ok: true, detail: `token ${cfg.tokenPrefix}… valid for ${me.data.user.username}` });
      } catch {
        checks.push({ name: "auth", ok: false, detail: `saved token ${cfg.tokenPrefix}… invalid — run tmin login` });
      }
    } else {
      checks.push({ name: "auth", ok: true, detail: "no token saved (anonymous mode available)" });
    }
  }
  const allOk = checks.every((c) => c.ok);
  if (jsonOut) console.log(JSON.stringify({ ok: allOk, checks }));
  else {
    for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  }
  return allOk ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`Fatal: ${(e as Error).message}`);
    process.exit(1);
  },
);
