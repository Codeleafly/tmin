import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { boot, http, post, mkUser, mkToken, TunnelClient, startTarget, sleep, type TestServer } from "./helpers";

describe("real end-to-end forwarding", () => {
  let s: TestServer;
  let target: { port: number; close: () => Promise<void> };
  let t: TunnelClient;
  before(async () => {
    s = await boot();
    target = await startTarget();
    const { cookie } = await mkUser(s.base, "gita");
    const token = await mkToken(s.base, cookie);
    t = new TunnelClient(s.base, target.port, { token, slot: 1 });
    const r = await t.registered;
    assert.equal(r.publicUrl, `http://127.0.0.1:${s.port}/gita`);
  });
  after(async () => {
    t.close();
    await target.close();
    await s.close();
  });

  it("GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS + query + headers + cookies", async () => {
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const r = await http(s.base, m, "/gita/echo?x=1&y=two", { body: m === "GET" ? undefined : "hello", headers: { "x-test": "42" } });
      assert.equal(r.status, 200, m);
      const j = r.json as { method: string; path: string; xTest: string; body?: string };
      assert.equal(j.method, m);
      assert.equal(j.path, "/echo?x=1&y=two");
      if (m !== "GET") assert.equal(j.body, "hello");
      assert.equal(j.xTest, "42");
    }
    const h = await http(s.base, "HEAD", "/gita/echo");
    assert.equal(h.status, 200);
    assert.equal(h.body.length, 0);
    // cookies + redirects preserved
    const e = await http(s.base, "GET", "/gita/echo");
    assert.ok((e.headers["set-cookie"] || "").includes("sid=abc"));
    // forwarded headers reflect the real hop (not a hardcoded "https")
    const xf = (await http(s.base, "GET", "/gita/echo")).json as { xfProto: string; xff: string };
    assert.equal(xf.xfProto, "http");
    assert.ok(xf.xff.includes("127.0.0.1"));
    const red = await http(s.base, "GET", "/gita/redirect");
    assert.equal(red.status, 302);
    assert.equal(red.headers.location, "/echo?from=redirect");
  });

  it("status codes + large streaming bodies both ways", async () => {
    assert.equal((await http(s.base, "GET", "/gita/status/418")).status, 418);
    assert.equal((await http(s.base, "GET", "/gita/status/500")).status, 500);
    const big = Buffer.alloc(512 * 1024, "u");
    const up = await http(s.base, "POST", "/gita/upload", { body: big });
    assert.equal((up.json as { received: number }).received, 512 * 1024);
    const down = await http(s.base, "GET", "/gita/stream");
    assert.equal(down.status, 200);
    assert.equal(down.body.length, 2 * 1024 * 1024);
  });

  it("20 simultaneous requests don't mix responses", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => http(s.base, "POST", `/gita/echo?n=${i}`, { body: `msg-${i}` })),
    );
    for (let i = 0; i < 20; i++) {
      const j = results[i].json as { path: string; body: string };
      assert.equal(j.path, `/echo?n=${i}`);
      assert.equal(j.body, `msg-${i}`);
    }
  });

  it("offline route shows offline page; unknown route 404", async () => {
    assert.equal((await http(s.base, "GET", "/nobody-here")).status, 404);
    // registered but offline user:
    const { cookie } = await mkUser(s.base, "henry");
    await mkToken(s.base, cookie);
    // reserve slot without connecting
    await post(s.base, "/api/v1/tunnels", { slot: 1 }, { cookie });
    const off = await http(s.base, "GET", "/henry/echo");
    assert.equal(off.status, 502);
    assert.ok(off.body.toString().includes("offline"));
  });

  it("websocket upgrade bridges bidirectionally", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/gita/ws/echo`);
    try {
      const got = await new Promise<string>((resolve, reject) => {
        ws.on("open", () => ws.send("ping-ws"));
        ws.on("message", (m) => resolve(String(m)));
        ws.on("error", reject);
        setTimeout(() => reject(new Error("ws e2e timeout")), 8000).unref?.();
      });
      assert.equal(got, "ping-ws");
    } finally {
      ws.close();
    }
  });

  it("upstream timeout returns 504", async () => {
    const slow = await boot({ REQUEST_TIMEOUT_MS: "800" });
    try {
      const tgt = await startTarget();
      const { cookie } = await mkUser(slow.base, "ivan");
      const token = await mkToken(slow.base, cookie);
      const tc = new TunnelClient(slow.base, tgt.port, { token, slot: 1 });
      await tc.registered;
      const r = await http(slow.base, "GET", "/ivan/slow");
      assert.equal(r.status, 504);
      tc.close();
      await tgt.close();
    } finally {
      await slow.close();
    }
  });
});

describe("anonymous lifecycle", () => {
  let s: TestServer;
  let target: { port: number; close: () => Promise<void> };
  before(async () => {
    s = await boot({ ANONYMOUS_TUNNEL_TTL_SECONDS: "2" });
    target = await startTarget();
  });
  after(async () => {
    await target.close();
    await s.close();
  });

  it("anon serves, then expires server-side; resume keeps ORIGINAL expiry", async () => {
    const a = new TunnelClient(s.base, target.port, { anonymous: true });
    const r = await a.registered;
    assert.ok(r.routePath.startsWith("/a-"));
    assert.ok(r.expiresAt && r.expiresAt - Date.now() <= 2000);
    assert.ok(r.resumeToken, "server must issue resume token");
    const before = await http(s.base, "GET", `${r.routePath}/echo`);
    assert.equal(before.status, 200);
    // resume joins the SAME session without extending expiry
    a.close();
    await sleep(200);
    const b = new TunnelClient(s.base, target.port, { anonymous: true, resumeToken: r.resumeToken });
    const r2 = await b.registered;
    assert.equal(r2.routePath, r.routePath);
    assert.equal(r2.expiresAt, r.expiresAt);
    b.close();
    // wait past TTL → gone (sweeper runs every 300ms in tests)
    await sleep(2500);
    const afterExp = await http(s.base, "GET", `${r.routePath}/echo`);
    assert.equal(afterExp.status, 410, "expired anonymous path must answer 410 Gone");
    assert.equal((afterExp.json as { error: { code: string } }).error.code, "ANON_EXPIRED");
    const row = s.store.db.anonSessions.find((x) => x.pathToken === r.routePath.slice(1));
    assert.equal(row?.status, "expired");
  });

  it("anonymous cannot take slot 2/3", async () => {
    const a = new TunnelClient(s.base, target.port, { anonymous: true, slot: 2 });
    await assert.rejects(() => a.registered);
    a.close();
  });

  it("per-IP anon limit refuses new sessions but allows resume; cooldown then blocks the IP", async () => {
    const ab = await boot({ ANONYMOUS_MAX_PER_IP: "1", ANONYMOUS_ABUSE_BLOCK_SECONDS: "60", ANONYMOUS_TUNNEL_TTL_SECONDS: "60" });
    const tgt = await startTarget();
    try {
      const a = new TunnelClient(ab.base, tgt.port, { anonymous: true });
      const r = await a.registered;
      a.close();
      await sleep(200);
      // reconnecting to your own session works even at the cap
      const a2 = new TunnelClient(ab.base, tgt.port, { anonymous: true, resumeToken: r.resumeToken });
      const r2 = await a2.registered;
      assert.equal(r2.routePath, r.routePath);
      // a fresh (non-resume) start from the same IP is refused…
      const b = new TunnelClient(ab.base, tgt.port, { anonymous: true });
      await assert.rejects(() => b.registered, /ANON_LIMIT_REACHED/);
      // …and the refusal starts the cooldown: even after the session ends, no new starts
      a2.close();
      await sleep(300);
      const c = new TunnelClient(ab.base, tgt.port, { anonymous: true });
      await assert.rejects(() => c.registered, /ANON_LIMIT_REACHED/);
      c.close();
    } finally {
      await tgt.close();
      await ab.close();
    }
  });
});
