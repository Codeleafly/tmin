/**
 * Tunnel session: outbound WS -> server, local HTTP forwarding, reconnect.
 * Never logs secrets; token shown only as prefix.
 */
import WebSocket from "ws";
import { request as httpRequest } from "node:http";
import { PROTOCOL_VERSION, validateServerFrame, asServerFrame } from "../../../packages/protocol/src/index";
import type { CliConfig } from "./config";
import { loadConfig, saveConfig, addRuntime, removeRuntime } from "./config";

export interface HttpOptions {
  port: number;
  slot: number;
  anonymous: boolean;
  targetHost: string;
  json: boolean;
}

function wsUrl(server: string): string {
  const u = new URL(server.replace(/\/$/, "") + "/tunnel");
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

function backoff(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
  return Math.floor(base * (0.7 + Math.random() * 0.6)); // jitter
}

function out(json: boolean, obj: unknown, text: string): void {
  if (json) console.log(JSON.stringify(obj));
  else console.log(text);
}

export async function runHttpTunnel(cfg: CliConfig, opt: HttpOptions): Promise<number> {
  if (!Number.isInteger(opt.port) || opt.port < 1 || opt.port > 65535) {
    console.error("Invalid port. Use 1..65535.");
    return 2;
  }
  if (![1, 2, 3].includes(opt.slot)) {
    console.error("Invalid --slot. Use 1, 2 or 3.");
    return 2;
  }
  if (opt.anonymous && opt.slot !== 1) {
    console.error("Anonymous tunnels only support slot 1.");
    return 2;
  }
  if (!opt.anonymous && !cfg.token) {
    console.error("Not logged in. Run `tmin login` or use --anonymous.");
    return 2;
  }
  let attempt = 0;
  let stopped = false;
  let currentTunnelId: string | null = null;

  const stop = async () => {
    stopped = true;
    if (currentTunnelId) await removeRuntime(currentTunnelId).catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  for (;;) {
    if (stopped) return 0;
    const code = await once(cfg, opt);
    if (code === "fatal") return 1;
    if (stopped) return 0;
    // Reconnectable close: backoff, same slot (server keeps route identity).
    attempt++;
    const wait = backoff(attempt);
    out(opt.json, { event: "reconnecting", attempt, waitMs: wait }, `Connection lost. Reconnecting in ${(wait / 1000).toFixed(1)}s (attempt ${attempt})…`);
    await new Promise((r) => setTimeout(r, wait));
    // Reload config (token may have been refreshed).
    cfg = await loadConfig();
  }

  async function once(c: CliConfig, o: HttpOptions): Promise<"fatal" | "retry"> {
    return new Promise((resolve) => {
      const url = wsUrl(c.server);
      const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
      const bodies = new Map<string, { head: { method: string; path: string; headers: Record<string, string>; wsUpgrade: boolean }; chunks: Buffer[]; size: number }>();
      const localWs = new Map<string, WebSocket>();
      /** Frames received before the local socket finished connecting (bounded). */
      const wsQueues = new Map<string, { frames: Array<{ data: Buffer; binary: boolean }>; bytes: number }>();
      let registered: { tunnelId: string; routePath: string; publicUrl: string; expiresAt: number | null; anonymous: boolean } | null = null;
      let helloOk = false;
      let countdown: NodeJS.Timeout | null = null;

      const fail = (msg: string) => {
        out(o.json, { event: "error", message: msg }, `Error: ${msg}`);
        try {
          ws.close();
        } catch {
          undefined;
        }
      };

      const resumeKey = `anon:${c.server}`;

      ws.on("open", () => {
        attempt = 0;
        if (o.anonymous) {
          const resume = c.anonResume[resumeKey];
          ws.send(JSON.stringify({
            type: "hello",
            protocolVersion: PROTOCOL_VERSION,
            auth: resume ? { mode: "anonymous", resumeToken: resume } : { mode: "anonymous" },
            clientVersion: "cli/0.1.0",
          }));
        } else {
          ws.send(JSON.stringify({
            type: "hello",
            protocolVersion: PROTOCOL_VERSION,
            auth: { mode: "token", token: c.token },
            clientVersion: "cli/0.1.0",
          }));
        }
        setTimeout(() => {
          if (!helloOk) fail("Server did not answer hello. Run `tmin doctor`.");
        }, 10_000).unref?.();
      });

      ws.on("message", (raw) => {
        let f: unknown;
        try {
          f = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (validateServerFrame(f)) return;
        const frame = asServerFrame(f);
        switch (frame.type) {
          case "welcome":
            helloOk = true;
            ws.send(JSON.stringify({ type: "register", slot: o.slot, localPort: o.port, target: `${o.targetHost}:${o.port}` }));
            break;
          case "registered": {
            helloOk = true;
            currentTunnelId = frame.tunnelId;
            registered = {
              tunnelId: frame.tunnelId,
              routePath: frame.routePath,
              publicUrl: frame.publicUrl,
              expiresAt: frame.expiresAt,
              anonymous: frame.anonymous,
            };
            if (frame.anonymous && frame.resumeToken) {
              c.anonResume = { ...c.anonResume, [resumeKey]: frame.resumeToken };
              void saveConfig(c).catch(() => undefined);
            }
            void addRuntime({
              tunnelId: frame.tunnelId,
              routePath: frame.routePath,
              publicUrl: frame.publicUrl,
              slot: o.slot,
              localPort: o.port,
              anonymous: frame.anonymous,
              expiresAt: frame.expiresAt,
              startedAt: Date.now(),
              pid: process.pid,
            });
            out(o.json, { event: "connected", ...registered, local: `${o.targetHost}:${o.port}` },
              `\n  ✓ Forwarding ${frame.publicUrl}  →  ${o.targetHost}:${o.port}` +
                (frame.anonymous && frame.expiresAt ? `\n  ⏳ anonymous link expires in ${Math.max(1, Math.round((frame.expiresAt - Date.now()) / 60000))} min (${new Date(frame.expiresAt).toISOString()})` : `\n  ● permanent URL (slot ${o.slot})`) +
                `\n  Press Ctrl+C to stop.\n`);
            if (frame.anonymous && frame.expiresAt) {
              countdown = setInterval(() => {
                const left = Math.max(0, Math.floor((frame.expiresAt! - Date.now()) / 1000));
                if (!o.json) process.stdout.write(`\r  ⏳ expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}   `);
                if (left <= 0 && countdown) clearInterval(countdown);
              }, 1000);
              countdown.unref?.();
            }
            break;
          }
          case "request_head": {
            const head = { method: frame.method, path: frame.path, headers: frame.headers, wsUpgrade: !!(frame as unknown as { wsUpgrade?: boolean }).wsUpgrade };
            if (head.wsUpgrade) {
              // WebSocket upgrade: bridge immediately, no body chunks follow.
              void forwardHttp(ws, frame.requestId, head, Buffer.alloc(0), o);
            } else {
              bodies.set(frame.requestId, { head, chunks: [], size: 0 });
            }
            break;
          }
          case "request_chunk": {
            const b = bodies.get(frame.requestId);
            if (!b) break;
            try {
              const buf = Buffer.from(frame.data, "base64");
              b.size += buf.length;
              if (b.size > 10 * 1024 * 1024) {
                bodies.delete(frame.requestId);
                ws.send(JSON.stringify({ type: "response_error", requestId: frame.requestId, code: "PAYLOAD_TOO_LARGE", message: "Body too large" }));
                break;
              }
              b.chunks.push(buf);
              if (frame.last) {
                bodies.delete(frame.requestId);
                void forwardHttp(ws, frame.requestId, b.head, Buffer.concat(b.chunks), o);
              }
            } catch {
              bodies.delete(frame.requestId);
            }
            break;
          }
          case "request_cancel": {
            bodies.delete(frame.requestId);
            break;
          }
          case "ws_frame": {
            const lw = localWs.get(frame.requestId);
            if (!lw) break;
            const buf = Buffer.from(frame.data, "base64");
            if (lw.readyState === 1) {
              lw.send(buf, { binary: frame.binary });
            } else if (lw.readyState === 0) {
              const q = wsQueues.get(frame.requestId) ?? { frames: [], bytes: 0 };
              if (q.bytes + buf.length <= 1024 * 1024 && q.frames.length < 256) {
                q.frames.push({ data: buf, binary: !!frame.binary });
                q.bytes += buf.length;
                wsQueues.set(frame.requestId, q);
              }
            }
            break;
          }
          case "ws_close": {
            const lw = localWs.get(frame.requestId);
            localWs.delete(frame.requestId);
            wsQueues.delete(frame.requestId);
            try {
              lw?.close(frame.code);
            } catch {
              undefined;
            }
            break;
          }
          case "heartbeat":
            ws.send(JSON.stringify({ type: "heartbeat", at: Date.now() }));
            break;
          case "shutdown": {
            out(o.json, { event: "shutdown", reason: frame.reason }, `Server: ${frame.reason}`);
            try {
              ws.close();
            } catch {
              undefined;
            }
            if (frame.reconnectMs === 0) {
              if (registered) void removeRuntime(registered.tunnelId).catch(() => undefined);
              if (o.anonymous) {
                delete c.anonResume[resumeKey];
                void saveConfig(c).catch(() => undefined);
              }
              stopped = true;
              resolve("fatal");
            }
            break;
          }
          case "error": {
            const msg = `Server refused connection [${frame.code}]: ${frame.message}`;
            if (frame.fatal) {
              out(o.json, { event: "fatal", code: frame.code, message: frame.message }, `Error: ${friendly(frame.code, frame.message)}`);
              try {
                ws.close();
              } catch {
                undefined;
              }
              if (!registered) {
                stopped = true;
                resolve("fatal");
              }
            } else {
              out(o.json, { event: "server-error", code: frame.code, message: frame.message }, msg);
            }
            break;
          }
        }
      });

      ws.on("close", () => {
        if (countdown) clearInterval(countdown);
        if (stopped) return;
        if (!registered) {
          // Never got a URL: likely fatal (printed already) — retry anyway unless stopped.
        }
        resolve("retry");
      });
      ws.on("error", (e) => {
        if (!helloOk && !registered) {
          out(o.json, { event: "error", message: String(e.message || e) }, `Connection failed: ${e.message}. Run \`tmin doctor\`.`);
        }
      });

      async function forwardHttp(
        sock: WebSocket, requestId: string,
        head: { method: string; path: string; headers: Record<string, string>; wsUpgrade: boolean },
        body: Buffer, opts: HttpOptions,
      ): Promise<void> {
        if (head.wsUpgrade || (head.headers["upgrade"] || "").toLowerCase() === "websocket") {
          // WS upgrade requested: bridge via local ws client.
          const localUrl = `ws://${opts.targetHost}:${opts.port}${head.path}`;
          let lw: WebSocket;
          try {
            lw = new WebSocket(localUrl, { handshakeTimeout: 10_000 });
          } catch {
            sock.send(JSON.stringify({ type: "response_error", requestId, code: "UPSTREAM_UNAVAILABLE", message: "Local app unavailable" }));
            return;
          }
          localWs.set(requestId, lw);
          lw.on("open", () => {
            if (sock.readyState === 1) sock.send(JSON.stringify({ type: "ws_opened", requestId }));
            const q = wsQueues.get(requestId);
            if (q) {
              wsQueues.delete(requestId);
              for (const f of q.frames) {
                if (lw.readyState !== 1) break;
                lw.send(f.data, { binary: f.binary });
              }
            }
          });
          lw.on("message", (data, isBinary) => {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
            if (sock.readyState === 1) {
              sock.send(JSON.stringify({ type: "ws_frame", requestId, data: buf.toString("base64"), binary: !!isBinary }));
            }
          });
          const done = (code: number) => {
            localWs.delete(requestId);
            wsQueues.delete(requestId);
            if (sock.readyState === 1) sock.send(JSON.stringify({ type: "ws_closed", requestId, code }));
          };
          lw.on("close", done);
          lw.on("error", () => {
            try {
              lw.close(1011);
            } catch {
              undefined;
            }
            done(1011);
          });
          return;
        }
        const headers = { ...head.headers };
        delete headers["x-request-id"];
        // Re-frame deterministically: the body was reassembled, original framing is stale.
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        headers["content-length"] = String(body.length);
        const r = httpRequest(
          { host: opts.targetHost, port: opts.port, path: head.path, method: head.method, headers, timeout: 25_000 },
          (localRes) => {
            const outHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(localRes.headers)) {
              if (v === undefined) continue;
              if (k.toLowerCase() === "transfer-encoding") continue;
              outHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
            }
            if (sock.readyState === 1) {
              sock.send(JSON.stringify({ type: "response_head", requestId, status: localRes.statusCode || 200, headers: outHeaders }));
            }
            localRes.on("data", (c: Buffer) => {
              if (sock.readyState !== 1) return;
              // Bounded per-message chunks.
              for (let off = 0; off < c.length; off += 48 * 1024) {
                sock.send(JSON.stringify({ type: "response_chunk", requestId, data: c.subarray(off, off + 48 * 1024).toString("base64") }));
              }
            });
            localRes.on("end", () => {
              if (sock.readyState === 1) sock.send(JSON.stringify({ type: "response_end", requestId }));
            });
          },
        );
        r.on("timeout", () => {
          r.destroy();
          if (sock.readyState === 1) {
            sock.send(JSON.stringify({ type: "response_error", requestId, code: "GATEWAY_TIMEOUT", message: "Local app timed out" }));
          }
        });
        r.on("error", () => {
          if (sock.readyState === 1) {
            sock.send(JSON.stringify({ type: "response_error", requestId, code: "UPSTREAM_UNAVAILABLE", message: "Local app unavailable" }));
          }
        });
        if (body.length > 0) r.write(body);
        r.end();
      }
    });
  }
}

function friendly(code: string, msg: string): string {
  if (code === "TUNNEL_LIMIT_REACHED") return "Free accounts can run a maximum of 3 active tunnels. Stop one first.";
  if (code === "ANON_EXPIRED") return "Anonymous session expired. Start a new tunnel or run `tmin login` for permanent URLs.";
  if (code === "TOKEN_REVOKED") return "Saved login is invalid. Run `tmin login` again.";
  if (code === "PROTOCOL_VERSION_MISMATCH") return "CLI/server protocol mismatch. Update tmin.";
  return msg;
}
