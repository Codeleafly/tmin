/** OAuth-style device flow (CLI login): authorize → approve in browser → bearer token. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { boot, http, post, mkUser, type TestServer } from "./helpers";

interface Authz {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

describe("device authorization flow", () => {
  let s: TestServer;

  before(async () => {
    // This suite intentionally makes many auth-endpoint calls from one IP.
    s = await boot({ RATE_AUTH_PER_MIN: "1000" });
  });
  after(async () => {
    await s.close();
  });

  it("authorize returns a device code and a formatted one-time user code", async () => {
    const r = await post(s.base, "/api/v1/auth/device/authorize", { clientName: "tmin CLI test" });
    assert.equal(r.status, 201);
    const d = r.json as Authz;
    assert.ok(d.device_code.length >= 32);
    assert.match(d.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(d.verification_uri.endsWith("/device"), d.verification_uri);
    assert.ok(d.verification_uri_complete.includes(d.user_code.replace("-", "")) || d.verification_uri_complete.includes(d.user_code));
    assert.equal(d.interval, 5);
    assert.equal(d.expires_in, 600);
    // device_code is never stored in plaintext
    assert.ok(!s.store.db.deviceAuths.some((x) => (x as unknown as { deviceCode?: string }).deviceCode === d.device_code));
  });

  it("polling before approval returns AUTHORIZATION_PENDING, then SLOW_DOWN", async () => {
    const authz = (await post(s.base, "/api/v1/auth/device/authorize", {})).json as Authz;
    const first = await post(s.base, "/api/v1/auth/device/token", { device_code: authz.device_code });
    assert.equal(first.status, 400);
    assert.equal((first.json as { error: { code: string } }).error.code, "AUTHORIZATION_PENDING");
    const second = await post(s.base, "/api/v1/auth/device/token", { device_code: authz.device_code });
    assert.equal(second.status, 400);
    assert.equal((second.json as { error: { code: string } }).error.code, "SLOW_DOWN");
  });

  it("unknown device codes and bad input are rejected", async () => {
    const unknown = await post(s.base, "/api/v1/auth/device/token", { device_code: "nope" });
    assert.equal(unknown.status, 400);
    assert.equal((unknown.json as { error: { code: string } }).error.code, "INVALID_DEVICE_CODE");
    const missing = await post(s.base, "/api/v1/auth/device/token", {});
    assert.equal(missing.status, 400);
    assert.equal((missing.json as { error: { code: string } }).error.code, "BAD_REQUEST");
  });

  it("verify requires login, then check/approve yields a working bearer token exactly once", async () => {
    const { cookie, user } = await mkUser(s.base, "devuser");
    const authz = (await post(s.base, "/api/v1/auth/device/authorize", { clientName: "tmin CLI e2e" })).json as Authz;

    const anon = await post(s.base, "/api/v1/auth/device/verify", { user_code: authz.user_code, action: "check" });
    assert.equal(anon.status, 401);

    const check = await post(s.base, "/api/v1/auth/device/verify", { user_code: authz.user_code, action: "check" }, { cookie });
    assert.equal(check.status, 200);
    assert.equal((check.json as { clientName: string }).clientName, "tmin CLI e2e");

    const approve = await post(s.base, "/api/v1/auth/device/verify", { user_code: authz.user_code, action: "approve" }, { cookie });
    assert.equal(approve.status, 200);
    assert.equal((approve.json as { status: string }).status, "approved");

    const tokenRes = await post(s.base, "/api/v1/auth/device/token", { device_code: authz.device_code });
    assert.equal(tokenRes.status, 200);
    const t = tokenRes.json as { access_token: string; token_type: string; prefix: string; user: { username: string } };
    assert.match(t.access_token, /^tmin_/);
    assert.equal(t.token_type, "Bearer");
    assert.equal(t.user.username, "devuser");

    // Token authenticates like any API token.
    const me = await http(s.base, "GET", "/api/v1/me", { token: t.access_token });
    assert.equal(me.status, 200);
    assert.equal((me.json as { user: { id: string } }).user.id, user.id);

    // Single use: the same device code cannot mint another token.
    const again = await post(s.base, "/api/v1/auth/device/token", { device_code: authz.device_code });
    assert.equal(again.status, 400);
    assert.equal((again.json as { error: { code: string } }).error.code, "INVALID_DEVICE_CODE");

    // Already-processed code cannot be approved twice.
    const reapprove = await post(s.base, "/api/v1/auth/device/verify", { user_code: authz.user_code, action: "approve" }, { cookie });
    assert.equal(reapprove.status, 409);
  });

  it("denying a code blocks token issuance", async () => {
    const { cookie } = await mkUser(s.base, "denier");
    const authz = (await post(s.base, "/api/v1/auth/device/authorize", {})).json as Authz;
    const deny = await post(s.base, "/api/v1/auth/device/verify", { user_code: authz.user_code, action: "deny" }, { cookie });
    assert.equal(deny.status, 200);
    const tokenRes = await post(s.base, "/api/v1/auth/device/token", { device_code: authz.device_code });
    assert.equal(tokenRes.status, 403);
    assert.equal((tokenRes.json as { error: { code: string } }).error.code, "ACCESS_DENIED");
  });

  it("expired codes cannot be approved or exchanged", async () => {
    const { cookie } = await mkUser(s.base, "expirer");
    const authz = (await post(s.base, "/api/v1/auth/device/authorize", {})).json as Authz;
    const row = s.store.db.deviceAuths.find((d) => d.userCode === authz.user_code.replace("-", ""))!;
    assert.ok(row, "device row stored");
    row.expiresAt = Date.now() - 1;

    const verify = await post(s.base, "/api/v1/auth/device/verify", { user_code: authz.user_code, action: "approve" }, { cookie });
    assert.equal(verify.status, 400);
    assert.equal((verify.json as { error: { code: string } }).error.code, "DEVICE_CODE_EXPIRED");

    const tokenRes = await post(s.base, "/api/v1/auth/device/token", { device_code: authz.device_code });
    assert.equal(tokenRes.status, 400);
    assert.equal((tokenRes.json as { error: { code: string } }).error.code, "DEVICE_CODE_EXPIRED");
  });

  it("unknown user code / malformed action are rejected", async () => {
    const { cookie } = await mkUser(s.base, "verifier");
    const unknown = await post(s.base, "/api/v1/auth/device/verify", { user_code: "ZZZZ-ZZZZ", action: "check" }, { cookie });
    assert.equal(unknown.status, 400);
    assert.equal((unknown.json as { error: { code: string } }).error.code, "INVALID_DEVICE_CODE");
    const bad = await post(s.base, "/api/v1/auth/device/verify", { user_code: "ZZZZ-ZZZZ", action: "nuke" }, { cookie });
    assert.equal(bad.status, 400);
    assert.equal((bad.json as { error: { code: string } }).error.code, "BAD_REQUEST");
  });

  it("the /device route is reserved (no username capture)", async () => {
    const r = await post(s.base, "/api/v1/auth/register", { username: "device", email: "device@x.com", password: "Password1!" });
    assert.equal(r.status, 400);
  });
});
