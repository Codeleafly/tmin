/** OpenAPI ↔ implementation sync: every documented route must exist and vice versa. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ROUTE_TABLE, buildOpenApi } from "../src/api/openapi";
import { boot, http, post, mkUser, type TestServer } from "./helpers";

describe("openapi sync", () => {
  it("spec contains every route-table entry exactly once", () => {
    const spec = buildOpenApi("http://x") as { paths: Record<string, Record<string, unknown>> };
    const seen = new Set<string>();
    for (const r of ROUTE_TABLE) {
      const key = `${r.method} ${r.path}`;
      assert.ok(!seen.has(key), `duplicate ${key}`);
      seen.add(key);
      const methods = spec.paths[r.path];
      assert.ok(methods, `missing path ${r.path}`);
      assert.ok(methods[r.method.toLowerCase()], `missing ${key}`);
    }
  });

  let s: TestServer;
  before(async () => {
    s = await boot();
  });
  after(async () => {
    await s.close();
  });

  it("every documented route responds (no silent 404s)", async () => {
    const { cookie } = await mkUser(s.base, "specuser");
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
    const admin = s.store.db.users.find((u) => u.usernameLower === "admin")!;
    // create fixtures: token + tunnel meta so :id routes resolve
    const tok = await post(s.base, "/api/v1/tokens", { name: "spec" }, { cookie });
    const tokenId = (tok.json as { token: { id: string } }).token.id;
    const tun = await post(s.base, "/api/v1/tunnels", { slot: 1 }, { cookie });
    assert.equal(tun.status, 201);
    const routeId = ((await http(s.base, "GET", "/api/v1/me/routes", { cookie })).json as { routes: Array<{ id: string }> }).routes[0].id;
    // tunnel rows appear only after a WS connect; insert one meta row to exercise :id routes
    const me = (await http(s.base, "GET", "/api/v1/me", { cookie })).json as { user: { id: string } };
    const now = Date.now();
    s.store.db.tunnels.push({
      id: "tun_spec", userId: me.user.id, routeId, routePath: "/specuser", slot: 1, label: "spec",
      status: "closed", anon: false, anonSessionId: null, connectedAt: now, lastSeenAt: now, closedAt: null, upBytes: 0, downBytes: 0,
    });
    const tunnelId = "tun_spec";
    const sessId = ((await http(s.base, "GET", "/api/v1/sessions", { cookie })).json as { sessions: Array<{ id: string }> }).sessions[0].id;

    const fill = (p: string) =>
      p.replace("/api/v1/tokens/{id}", `/api/v1/tokens/${tokenId}`)
        .replace("/api/v1/tunnels/{id}/metrics", `/api/v1/tunnels/${tunnelId}/metrics`)
        .replace("/api/v1/tunnels/{id}", `/api/v1/tunnels/${tunnelId}`)
        .replace("/api/v1/routes/{id}", `/api/v1/routes/${routeId}`)
        .replace("/api/v1/sessions/{id}", `/api/v1/sessions/${sessId}`)
        .replace("/api/v1/admin/users/{id}/status", `/api/v1/admin/users/${admin.id}/status`)
        .replace("/api/v1/admin/users/{id}/limits", `/api/v1/admin/users/${admin.id}/limits`)
        .replace("/api/v1/admin/users/{id}/role", `/api/v1/admin/users/${admin.id}/role`)
        .replace("/api/v1/admin/users/{id}/username", `/api/v1/admin/users/${admin.id}/username`)
        .replace("/api/v1/admin/users/{id}/revoke-sessions", `/api/v1/admin/users/${admin.id}/revoke-sessions`)
        .replace("/api/v1/admin/users/{id}/reset-password", `/api/v1/admin/users/${admin.id}/reset-password`)
        .replace("/api/v1/admin/users/{id}", `/api/v1/admin/users/${admin.id}`)
        .replace("/api/v1/admin/tunnels/{id}", `/api/v1/admin/tunnels/${tunnelId}`);

    const bodies: Record<string, unknown> = {
      "POST /api/v1/auth/register": { username: "spec2", email: "s2@x.com", password: "Password1!" },
      "POST /api/v1/auth/login": { login: "specuser", password: "Password1!" },
      "POST /api/v1/auth/logout": {},
      "POST /api/v1/auth/forgot-password": { email: "specuser@example.com" },
      "POST /api/v1/auth/reset-password": { token: "bogus", newPassword: "Password1!" },
      "POST /api/v1/auth/change-password": { currentPassword: "x", newPassword: "Password1!" },
      "POST /api/v1/tokens": { name: "x" },
      "POST /api/v1/tunnels": { slot: 1 },
      "POST /api/v1/routes": { slot: 2 },
      "PATCH /api/v1/admin/users/{id}/status": { status: "active" },
      "PATCH /api/v1/admin/users/{id}/limits": { maxTunnels: 3 },
      "PATCH /api/v1/admin/users/{id}/role": { role: "user" },
      "PATCH /api/v1/admin/users/{id}/username": { username: "admin" },
      "POST /api/v1/admin/users/{id}/revoke-sessions": {},
      "POST /api/v1/admin/users/{id}/reset-password": { newPassword: "Adminpass1!" },
      "PATCH /api/v1/admin/config/quotas": {},
      "POST /api/v1/admin/maintenance": { enabled: false },
    };

    for (const r of ROUTE_TABLE) {
      const path = fill(r.path);
      const key = `${r.method} ${r.path}`;
      const useAdmin = r.auth === "admin";
      const headers = { "content-type": "application/json" };
      let res: { status: number };
      if (r.method === "GET") res = await http(s.base, "GET", path, { cookie: useAdmin ? loginRaw : cookie, headers });
      else if (r.method === "DELETE") res = await http(s.base, "DELETE", path, { cookie: useAdmin ? loginRaw : cookie });
      else if (r.method === "PATCH") res = await http(s.base, "PATCH", path, { cookie: useAdmin ? loginRaw : cookie, body: JSON.stringify(bodies[key] ?? {}), headers });
      else res = await http(s.base, "POST", path, { cookie: useAdmin ? loginRaw : cookie, body: JSON.stringify(bodies[key] ?? {}), headers });
      assert.notEqual(res.status, 404, `${key} returned 404 — spec/implementation drift`);
    }
    // spot check: spec served live matches builder
    const live = await http(s.base, "GET", "/openapi.json");
    assert.equal(live.status, 200);
    assert.ok((live.body.toString().length) > 1000);
  });
});
