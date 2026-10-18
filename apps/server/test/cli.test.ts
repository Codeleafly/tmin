/** Real CLI end-to-end: spawns the actual tmin binary, kills connections, verifies reconnect. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

type CliChild = ChildProcessByStdio<null, Readable, Readable>;
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { boot, http, post, mkUser, mkToken, startTarget, sleep, internals, type TestServer } from "./helpers";

const CLI = resolve(__dirname, "../../cli/src/index.js");

interface Connected { event: string; routePath?: string; publicUrl?: string; attempt?: number; userCode?: string; user?: string; tokenPrefix?: string }

function spawnCli(env: Record<string, string>, args: string[]): { child: CliChild; events: Connected[]; exited: Promise<number>; waitFor: (pred: (e: Connected) => boolean, ms?: number) => Promise<Connected>; stderr: () => string } {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Capture the exit eagerly: the CLI can exit before a later `on("exit")` attaches.
  const exited = new Promise<number>((res) => child.once("exit", (code) => res(code ?? -1)));
  const events: Connected[] = [];
  let errBuf = "";
  child.stderr.on("data", (d: Buffer) => {
    errBuf += d.toString();
  });
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as Connected);
      } catch {
        undefined;
      }
    }
  });
  const waitFor = (pred: (e: Connected) => boolean, ms = 15000): Promise<Connected> =>
    new Promise((res, rej) => {
      const started = Date.now();
      const t = setInterval(() => {
        const found = events.find(pred);
        if (found) {
          clearInterval(t);
          res(found);
        } else if (Date.now() - started > ms) {
          clearInterval(t);
          rej(new Error(`CLI event timeout. events=${JSON.stringify(events)} stderr=${errBuf.slice(0, 400)}`));
        }
      }, 100);
    });
  return { child, events, exited, waitFor, stderr: () => errBuf };
}

describe("real CLI against real server", () => {
  let s: TestServer;
  let target: { port: number; close: () => Promise<void> };
  let home: string;
  let child: CliChild | null = null;

  before(async () => {
    s = await boot();
    target = await startTarget();
    home = mkdtempSync(join(tmpdir(), "tmin-cli-home-"));
  });
  after(async () => {
    child?.kill("SIGKILL");
    await target.close();
    await s.close();
  });

  it("connects, serves, survives connection kill, reconnects with SAME URL, exits on SIGINT", async () => {
    const { cookie } = await mkUser(s.base, "zena");
    const token = await mkToken(s.base, cookie);
    const cli = spawnCli({ TMIN_SERVER: s.base, TMIN_TOKEN: token, HOME: home }, ["http", String(target.port), "--json"]);
    child = cli.child;
    const first = await cli.waitFor((e) => e.event === "connected");
    assert.equal(first.routePath, "/zena");
    assert.equal(first.publicUrl, `http://127.0.0.1:${s.port}/zena`);
    // serves traffic
    assert.equal((await http(s.base, "GET", "/zena/echo")).status, 200);
    // kill the tunnel socket server-side (simulates network drop, no shutdown frame)
    const registry = internals().registry;
    const live = registry.allLive()[0];
    assert.ok(live, "tunnel should be live");
    live.ws.terminate();
    // CLI must reconnect and re-register the SAME route
    const second = await cli.waitFor((e) => e.event === "connected" && cli.events.filter((x) => x.event === "connected").length >= 2, 20000);
    assert.equal(second.routePath, "/zena");
    await sleep(200);
    assert.equal((await http(s.base, "GET", "/zena/echo")).status, 200);
    // clean SIGINT exit
    cli.child.kill("SIGINT");
    const code = await Promise.race([cli.exited, sleep(5000).then(() => -99)]);
    assert.equal(code, 0);
  });

  it("anonymous flow prints expiry and refuses to extend after expiry", async () => {
    const s2 = await boot({ ANONYMOUS_TUNNEL_TTL_SECONDS: "2" });
    try {
      const tgt = await startTarget();
      const cli = spawnCli({ TMIN_SERVER: s2.base, HOME: home }, ["http", String(tgt.port), "--anonymous", "--json"]);
      const connected = await cli.waitFor((e) => e.event === "connected");
      assert.ok(connected.routePath?.startsWith("/a-"));
      assert.equal((await http(s2.base, "GET", `${connected.routePath}/echo`)).status, 200);
      // after TTL the server closes the session (reconnectMs 0) → CLI exits fatally
      const code = await Promise.race([cli.exited, sleep(8000).then(() => -99)]);
      assert.equal(code, 1, `anon CLI should exit(1) after expiry, got ${code}; stderr=${cli.stderr().slice(0, 300)}`);
      assert.equal(cli.events.filter((e) => e.event === "connected").length, 1);
      await tgt.close();
    } finally {
      await s2.close();
    }
  });

  it("device-flow login: browser approval yields a stored bearer token", async () => {
    const { cookie } = await mkUser(s.base, "flowuser");
    const cli = spawnCli({ TMIN_SERVER: s.base, HOME: home }, ["login", "--json", "--no-browser"]);
    const authz = await cli.waitFor((e) => e.event === "device_authorization");
    assert.ok(authz.userCode, "CLI must print the user code");
    const approve = await post(s.base, "/api/v1/auth/device/verify", { user_code: authz.userCode, action: "approve" }, { cookie });
    assert.equal(approve.status, 200, approve.body.toString());
    const logged = await cli.waitFor((e) => e.event === "logged_in", 20000);
    assert.equal(logged.user, "flowuser");
    assert.match(String(logged.tokenPrefix), /^tm_/);
    const code = await cli.exited;
    assert.equal(code, 0, `CLI should exit 0 after login; stderr=${cli.stderr().slice(0, 300)}`);
  });

  it("token login: --token validates the secret against the server", async () => {
    const { cookie } = await mkUser(s.base, "tokenuser");
    const token = await mkToken(s.base, cookie);
    const cli = spawnCli({ TMIN_SERVER: s.base, HOME: home }, ["login", "--token", token, "--json"]);
    const logged = await cli.waitFor((e) => e.event === "logged_in");
    assert.equal(logged.user, "tokenuser");
    const code = await cli.exited;
    assert.equal(code, 0);
  });

  it("doctor passes against a healthy server", async () => {
    const cli = spawnCli({ TMIN_SERVER: s.base, HOME: home }, ["doctor", "--json"]);
    const code = await Promise.race([cli.exited, sleep(15000).then(() => -99)]);
    assert.equal(code, 0, `doctor stderr=${cli.stderr().slice(0, 300)}`);
  });
});
