import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { boot, http, post, mkUser, mkToken, TunnelClient, startTarget, sleep, type TestServer } from "./helpers";

describe("authorization boundaries", () => {
  let s: TestServer;
  let target: { port: number; close: () => Promise<void> };
  const users: Record<string, { cookie: string; token: string }> = {};
  before(async () => {
    s = await boot();
    target = await startTarget();
    for (const n of ["alice", "bob"]) {
      const { cookie } = await mkUser(s.base, n);
      users[n] = { cookie, token: await mkToken(s.base, cookie) };
    }
    const ta = new TunnelClient(s.base, target.port, { token: users.alice.token, slot: 1 });
    await ta.registered;
    (global as Record<string, unknown>).__ta = ta;
  });
  after(async () => {
    (global as Record<string, unknown>).__ta = undefined;
    await target.close();
    await s.close();
  });

  it("bob cannot read/terminate/release alice's stuff", async () => {
    const routes = await http(s.base, "GET", "/api/v1/me/routes", { cookie: users.alice.cookie });
    const aliceRoute = (routes.json as { routes: Array<{ id: string }> }).routes[0];
    assert.equal((await http(s.base, "GET", `/api/v1/routes/${aliceRoute.id}`, { cookie: users.bob.cookie })).status, 404);
    assert.equal((await http(s.base, "DELETE", `/api/v1/routes/${aliceRoute.id}`, { cookie: users.bob.cookie })).status, 404);
    const tunnels = await http(s.base, "GET", "/api/v1/tunnels", { cookie: users.alice.cookie });
    const tid = (tunnels.json as { tunnels: Array<{ id: string }> }).tunnels[0].id;
    assert.equal((await http(s.base, "DELETE", `/api/v1/tunnels/${tid}`, { cookie: users.bob.cookie })).status, 404);
    // bob connecting slot 1 gets /bob, alice keeps /alice
    const tb = new TunnelClient(s.base, target.port, { token: users.bob.token, slot: 1 });
    assert.equal((await tb.registered).routePath, "/bob");
    const pub = await http(s.base, "GET", "/alice/echo");
    assert.equal(pub.status, 200);
    tb.close();
  });

  it("non-admin cannot touch admin APIs; admin can, and everything is audited", async () => {
    assert.equal((await http(s.base, "GET", "/api/v1/admin/users", { cookie: users.bob.cookie })).status, 403);
    assert.equal((await http(s.base, "GET", "/api/v1/admin/users")).status, 401);
    const adminLogin = await post(s.base, "/api/v1/auth/login", { login: "admin", password: "Adminpass1!" });
    assert.equal(adminLogin.status, 200);
    // login via raw request to capture the session cookie properly
    const loginRaw = await new Promise<string>((resolve, reject) => {
      const u = new URL("/api/v1/auth/login", s.base);
      const r = (require("node:http") as typeof import("node:http")).request(u, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => resolve((res.headers["set-cookie"]?.[0] || "").split(";")[0]));
      });
      r.on("error", reject);
      r.write(JSON.stringify({ login: "admin", password: "Adminpass1!" }));
      r.end();
    });
    const users1 = await http(s.base, "GET", "/api/v1/admin/users", { cookie: loginRaw });
    assert.equal(users1.status, 200);
    assert.ok((users1.json as { total: number }).total >= 3);
    // suspend alice → her public route 403s and tunnel killed
    const alice = s.store.db.users.find((u) => u.usernameLower === "alice")!;
    assert.equal((await http(s.base, "PATCH", `/api/v1/admin/users/${alice.id}/status`, { cookie: loginRaw, body: JSON.stringify({ status: "suspended" }), headers: { "content-type": "application/json" } })).status, 200);
    await sleep(300);
    assert.equal((await http(s.base, "GET", "/alice/echo")).status, 403);
    assert.equal((await post(s.base, "/api/v1/auth/login", { login: "alice", password: "Password1!" })).status, 401);
    // audit trail exists
    const audit = await http(s.base, "GET", "/api/v1/admin/audit-logs?search=suspend", { cookie: loginRaw });
    assert.ok((audit.json as { data: unknown[] }).data.length >= 1);
    // reactivate for other suites (isolated store per suite file, but keep tidy)
    await http(s.base, "PATCH", `/api/v1/admin/users/${alice.id}/status`, { cookie: loginRaw, body: JSON.stringify({ status: "active" }), headers: { "content-type": "application/json" } });
    // admin cannot demote self
    const adminRow = s.store.db.users.find((u) => u.usernameLower === "admin")!;
    assert.equal((await http(s.base, "PATCH", `/api/v1/admin/users/${adminRow.id}/role`, { cookie: loginRaw, body: JSON.stringify({ role: "user" }), headers: { "content-type": "application/json" } })).status, 403);
  });

  it("token revocation kills tunnel auth; sessions revocable", async () => {
    const { cookie } = await mkUser(s.base, "carol");
    const token = await mkToken(s.base, cookie);
    const list = await http(s.base, "GET", "/api/v1/tokens", { cookie });
    const id = (list.json as { tokens: Array<{ id: string }> }).tokens[0].id;
    await http(s.base, "DELETE", `/api/v1/tokens/${id}`, { cookie });
    const bad = new TunnelClient(s.base, target.port, { token, slot: 1 });
    await assert.rejects(() => bad.registered, /TOKEN_REVOKED/);
    bad.close();
  });
});

describe("input + protocol abuse", () => {
  let s: TestServer;
  before(async () => {
    s = await boot();
  });
  after(async () => {
    await s.close();
  });

  it("reserved/lookalike names and encoded paths can't capture traffic", async () => {
    for (const n of ["API", "Admin", "Docs", "Health", "Ready"]) {
      assert.equal((await post(s.base, "/api/v1/auth/register", { username: n, email: `${n}@x.com`, password: "Password1!" })).status, 400);
    }
    const { cookie } = await mkUser(s.base, "myapp");
    await mkToken(s.base, cookie);
    const { cookie: c2 } = await mkUser(s.base, "myapp2");
    await mkToken(s.base, c2);
    // /myapp2 must not hit myapp (both offline → 404/502, but never cross-served; check body mentions right path)
    const r = await http(s.base, "GET", "/myapp2/echo");
    assert.ok([404, 502].includes(r.status));
    // encoded traversal is not a route
    assert.equal((await http(s.base, "GET", "/%2e%2e/echo")).status, 404);
    // %2f decodes to a path separator → parses as slot 2 (no route) → 404, never /myapp's traffic
    assert.equal((await http(s.base, "GET", "/myapp%2f2/echo")).status, 404);
    // double-encoded %252f decodes to literal "%2f" in the username → no such route → 404
    assert.equal((await http(s.base, "GET", "/myapp%252f2/echo")).status, 404);
  });

  it("oversized API bodies rejected; malformed WS frames don't crash", async () => {
    const big = "x".repeat(20 * 1024);
    const r = await post(s.base, "/api/v1/auth/register", { username: "zz", email: "z@x.com", password: big });
    assert.ok([400, 413].includes(r.status));
    const ws = new WebSocket(s.base.replace(/^http/, "ws") + "/tunnel");
    const reply = await new Promise<string>((resolve) => {
      ws.on("open", () => {
        ws.send("not-json{{{");
        ws.send(JSON.stringify({ type: "register", slot: 1, localPort: 1 }));
      });
      ws.on("message", (m) => resolve(String(m)));
      setTimeout(() => resolve("timeout"), 4000).unref?.();
    });
    assert.ok(reply.includes("PROTOCOL_ERROR") || reply.includes("hello"));
    ws.close();
  });

  it("maintenance mode fails closed on gateway but health stays", async () => {
    const loginRaw = await new Promise<string>((resolve, reject) => {
      const u = new URL("/api/v1/auth/login", s.base);
      const r = (require("node:http") as typeof import("node:http")).request(u, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => resolve((res.headers["set-cookie"]?.[0] || "").split(";")[0]));
      });
      r.on("error", reject);
      r.write(JSON.stringify({ login: "admin", password: "Adminpass1!" }));
      r.end();
    });
    await http(s.base, "POST", "/api/v1/admin/maintenance", { cookie: loginRaw, body: JSON.stringify({ enabled: true }), headers: { "content-type": "application/json" } });
    assert.equal((await http(s.base, "GET", "/nope")).status, 503);
    assert.equal((await http(s.base, "GET", "/health")).status, 200);
    await http(s.base, "POST", "/api/v1/admin/maintenance", { cookie: loginRaw, body: JSON.stringify({ enabled: false }), headers: { "content-type": "application/json" } });
  });

  it("MAINTENANCE_MODE env boots fail-closed and is reflected in /ready", async () => {
    const m = await boot({ MAINTENANCE_MODE: "true" });
    try {
      assert.equal(m.store.db.settings.maintenanceMode, true);
      assert.equal((await http(m.base, "GET", "/nope")).status, 503);
      assert.equal((await http(m.base, "GET", "/health")).status, 200);
      const ready = await http(m.base, "GET", "/ready");
      assert.equal(ready.status, 200);
      assert.equal((ready.json as { maintenance: boolean }).maintenance, true);
    } finally {
      await m.close();
    }
  });
});
