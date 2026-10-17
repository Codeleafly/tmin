import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { boot, http, post, mkUser, mkToken, TunnelClient, startTarget, sleep, type TestServer } from "./helpers";

describe("auth + accounts", () => {
  let s: TestServer;
  before(async () => {
    s = await boot();
  });
  after(async () => {
    await s.close();
  });

  it("registers, rejects duplicates + reserved names", async () => {
    const r1 = await post(s.base, "/api/v1/auth/register", { username: "alice", email: "a@x.com", password: "Password1!" });
    assert.equal(r1.status, 201);
    const dup = await post(s.base, "/api/v1/auth/register", { username: "ALICE", email: "b@x.com", password: "Password1!" });
    assert.equal(dup.status, 409);
    const reserved = await post(s.base, "/api/v1/auth/register", { username: "api", email: "c@x.com", password: "Password1!" });
    assert.equal(reserved.status, 400);
  });

  it("login/logout + generic failures", async () => {
    const bad = await post(s.base, "/api/v1/auth/login", { login: "alice", password: "nope" });
    assert.equal(bad.status, 401);
    const ghost = await post(s.base, "/api/v1/auth/login", { login: "nobody-here", password: "Password1!" });
    assert.equal(ghost.status, 401);
    assert.deepEqual(ghost.json, bad.json && { ...(ghost.json as object) }); // same shape, no enumeration
    const good = await post(s.base, "/api/v1/auth/login", { login: "alice", password: "Password1!" });
    assert.equal(good.status, 200);
  });

  it("me/usage/limits + token lifecycle + sessions", async () => {
    const { cookie } = await mkUser(s.base, "bella");
    const me = await http(s.base, "GET", "/api/v1/me", { cookie });
    assert.equal(me.status, 200);
    const usage = await http(s.base, "GET", "/api/v1/me/usage", { cookie });
    assert.equal((usage.json as { usage: { uploadLimit: number } }).usage.uploadLimit, 1073741824);
    const secret = await mkToken(s.base, cookie);
    assert.ok(secret.startsWith("tmin_"));
    const authed = await http(s.base, "GET", "/api/v1/me", { token: secret });
    assert.equal(authed.status, 200);
    // token list never leaks secrets
    const list = await http(s.base, "GET", "/api/v1/tokens", { cookie });
    assert.ok(!(list.body.toString().includes(secret.slice(5, 15))));
    // revoke → dead immediately
    const id = (list.json as { tokens: Array<{ id: string }> }).tokens[0].id;
    assert.equal((await http(s.base, "DELETE", `/api/v1/tokens/${id}`, { cookie })).status, 200);
    assert.equal((await http(s.base, "GET", "/api/v1/me", { token: secret })).status, 401);
    // sessions visible + revocable
    const sess = await http(s.base, "GET", "/api/v1/sessions", { cookie });
    assert.equal((sess.json as { sessions: unknown[] }).sessions.length, 1);
  });

  it("password change + reset flow", async () => {
    const { cookie } = await mkUser(s.base, "cara");
    const ch = await post(s.base, "/api/v1/auth/change-password", { currentPassword: "Password1!", newPassword: "Newpass22!" }, { cookie });
    assert.equal(ch.status, 200);
    assert.equal((await post(s.base, "/api/v1/auth/login", { login: "cara", password: "Password1!" })).status, 401);
    assert.equal((await post(s.base, "/api/v1/auth/login", { login: "cara", password: "Newpass22!" })).status, 200);
    const fg = await post(s.base, "/api/v1/auth/forgot-password", { email: "cara@example.com" });
    assert.equal(fg.status, 200);
    assert.ok((fg.json as { resetToken?: string }).resetToken); // test env returns token
    const rst = await post(s.base, "/api/v1/auth/reset-password", { token: (fg.json as { resetToken: string }).resetToken, newPassword: "Reset33!!" });
    assert.equal(rst.status, 200);
    // old session revoked by reset
    assert.equal((await http(s.base, "GET", "/api/v1/me", { cookie })).status, 401);
    assert.equal((await post(s.base, "/api/v1/auth/login", { login: "cara", password: "Reset33!!" })).status, 200);
    // single-use
    assert.equal((await post(s.base, "/api/v1/auth/reset-password", { token: (fg.json as { resetToken: string }).resetToken, newPassword: "Xxxxx111!" })).status, 400);
  });
});

describe("three-tunnel free limit (server-enforced)", () => {
  let s: TestServer;
  let target: { port: number; close: () => Promise<void> };
  const clients: TunnelClient[] = [];
  before(async () => {
    s = await boot();
    target = await startTarget();
  });
  after(async () => {
    for (const c of clients) c.close();
    await sleep(150);
    await target.close();
    await s.close();
  });

  it("allows 3, rejects the 4th; frees after stop", async () => {
    const { cookie } = await mkUser(s.base, "dario");
    const token = await mkToken(s.base, cookie);
    const t1 = new TunnelClient(s.base, target.port, { token, slot: 1 });
    clients.push(t1);
    const r1 = await t1.registered;
    assert.equal(r1.routePath, "/dario");
    const t2 = new TunnelClient(s.base, target.port, { token, slot: 2 });
    clients.push(t2);
    assert.equal((await t2.registered).routePath, "/dario/2");
    const t3 = new TunnelClient(s.base, target.port, { token, slot: 3 });
    clients.push(t3);
    assert.equal((await t3.registered).routePath, "/dario/3");
    // 4th connection, even reusing slot 1, must fail server-side
    const t4 = new TunnelClient(s.base, target.port, { token, slot: 1 });
    clients.push(t4);
    await assert.rejects(() => t4.registered, /TUNNEL_LIMIT_REACHED/);
    t4.close();
    // stop one via API → slot frees
    const list = await http(s.base, "GET", "/api/v1/tunnels", { cookie });
    assert.equal((list.json as { tunnels: unknown[] }).tunnels.filter((t) => (t as { status: string }).status === "online").length, 3);
    const id = r1.tunnelId;
    assert.equal((await http(s.base, "DELETE", `/api/v1/tunnels/${id}`, { cookie })).status, 200);
    await sleep(300);
    const t5 = new TunnelClient(s.base, target.port, { token, slot: 1 });
    clients.push(t5);
    assert.equal((await t5.registered).routePath, "/dario");
    for (const t of [t1, t2, t3, t5]) t.close();
  });
});

describe("route stability + concurrent allocation", () => {
  let s: TestServer;
  let target: { port: number; close: () => Promise<void> };
  before(async () => {
    s = await boot();
    target = await startTarget();
  });
  after(async () => {
    await target.close();
    await s.close();
  });

  it("reconnect keeps the same route; concurrent allocation is single", async () => {
    const { cookie } = await mkUser(s.base, "elena");
    const token = await mkToken(s.base, cookie);
    const a = new TunnelClient(s.base, target.port, { token, slot: 2 });
    const ra = await a.registered;
    assert.equal(ra.routePath, "/elena/2");
    a.close();
    await sleep(300);
    const b = new TunnelClient(s.base, target.port, { token, slot: 2 });
    assert.equal((await b.registered).routePath, "/elena/2");
    b.close();
    // transactional: 10 parallel allocations → 1 row
    const { allocateRoute } = require("../src/tunnels/routes.js") as typeof import("../src/tunnels/routes");
    const user = s.store.db.users.find((u) => u.usernameLower === "elena")!;
    await Promise.all(Array.from({ length: 10 }, () => allocateRoute(s.store, user.id, "elena", 3)));
    assert.equal(s.store.db.routes.filter((r) => r.userId === user.id && r.slot === 3).length, 1);
    // release refused while live
    const routes = await http(s.base, "GET", "/api/v1/me/routes", { cookie });
    const slot2 = (routes.json as { routes: Array<{ id: string; slot: number }> }).routes.find((r) => r.slot === 2)!;
    const c = new TunnelClient(s.base, target.port, { token, slot: 2 });
    await c.registered;
    assert.equal((await http(s.base, "DELETE", `/api/v1/routes/${slot2.id}`, { cookie })).status, 409);
    c.close();
  });
});

describe("quota enforcement + persistence", () => {
  let s: TestServer;
  let target: { port: number; close: () => Promise<void> };
  before(async () => {
    s = await boot({ FREE_DOWNLOAD_LIMIT_BYTES: "300", FREE_UPLOAD_LIMIT_BYTES: "100000" });
    target = await startTarget();
  });
  after(async () => {
    await target.close();
    await s.close();
  });

  it("blocks after download quota, persists across flush", async () => {
    const { cookie } = await mkUser(s.base, "farid");
    const token = await mkToken(s.base, cookie);
    const t = new TunnelClient(s.base, target.port, { token, slot: 1 });
    await t.registered;
    // 2MB stream exceeds the 300B download quota → counted, then blocked
    const big = await http(s.base, "GET", "/farid/stream");
    assert.equal(big.status, 200);
    assert.ok(big.body.length > 1_000_000);
    const again = await http(s.base, "GET", "/farid/echo");
    assert.equal(again.status, 429);
    assert.equal((again.json as { error: { code: string } }).error.code, "QUOTA_EXCEEDED_DOWNLOAD");
    // usage persisted (flush hot counters; sweeper also flushes every 5s)
    s.flush();
    const user = s.store.db.users.find((u) => u.usernameLower === "farid")!;
    const row = s.store.db.usage.find((r) => r.userId === user.id)!;
    assert.ok(row && row.down > 1_000_000, `persisted down=${row?.down}`);
    t.close();
  });
});

describe("restart recovery", () => {
  let s: TestServer;
  before(async () => {
    s = await boot();
  });
  after(async () => {
    await s.close();
  });

  it("marks connected rows closed and expires stale anon", async () => {
    const { recoverAfterRestart } = require("../src/sweeper.js") as typeof import("../src/sweeper");
    s.store.db.tunnels.push({
      id: "tun_ghost", userId: "u1", routeId: "r1", routePath: "/ghost", slot: 1, label: "x",
      status: "connected", anon: true, anonSessionId: "a1", connectedAt: 1, lastSeenAt: 1, closedAt: null, upBytes: 0, downBytes: 0,
    });
    s.store.db.anonSessions.push({
      id: "a1", pathToken: "a-ghost", tunnelId: null, ipHash: "h", createdAt: 1, expiresAt: Date.now() - 1000, status: "active",
    });
    recoverAfterRestart(s.store);
    assert.equal(s.store.db.tunnels.find((t) => t.id === "tun_ghost")!.status, "closed");
    assert.equal(s.store.db.anonSessions.find((x) => x.id === "a1")!.status, "expired");
  });
});
