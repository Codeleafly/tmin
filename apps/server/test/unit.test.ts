import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateUsername, normalizeUsername } from "../../../packages/shared/src/usernames";
import { parsePublicPath, routePathFor, publicUrlFor } from "../../../packages/shared/src/routes";
import { quotaRemaining, quotaExhausted, usagePercent, shouldWarn, formatBytes } from "../../../packages/shared/src/quota";
import { statusFor } from "../../../packages/shared/src/errors";
import { validateClientFrame, validateServerFrame } from "../../../packages/protocol/src/validate";
import { hashPassword, verifyPassword } from "../../../packages/shared/src/passwords";
import { loadConfig } from "../../../packages/shared/src/config";
import { str, port as isPort, email } from "../../../packages/shared/src/validate";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { migrate, SCHEMA_VERSION } from "../src/db/store";
import { renderTemplate, renderOffline, pageFor, webDir } from "../src/web/static";

describe("usernames", () => {
  it("normalizes case", () => {
    assert.equal(normalizeUsername("  MyApp "), "myapp");
  });
  it("accepts valid names", () => {
    for (const n of ["abc", "my-app_2", "a1b2c3", "x".repeat(32)]) {
      const r = validateUsername(n);
      assert.ok(r.ok, n);
    }
  });
  it("rejects short/long/bad/reserved", () => {
    assert.equal(validateUsername("ab").ok, false);
    assert.equal(validateUsername("x".repeat(33)).ok, false);
    assert.equal(validateUsername("-bad").ok, false);
    assert.equal(validateUsername("bad-").ok, false);
    assert.equal(validateUsername("has space").ok, false);
    assert.equal(validateUsername("UPPEROK").ok, true); // case-insensitive accept
    for (const r of ["api", "admin", "dashboard", "docs", "login", "health", "ready", "metrics", "tunnel"]) {
      const v = validateUsername(r);
      assert.equal(v.ok, false, r);
      if (!v.ok) assert.equal(v.code, "USERNAME_RESERVED");
    }
    // anonymous namespace reserved
    assert.equal(validateUsername("a-bob").ok, false);
  });
});

describe("route matching (segment-aware)", () => {
  it("parses base, slots and rest", () => {
    assert.deepEqual(parsePublicPath("/myapp"), { username: "myapp", slot: 1, rest: "/" });
    assert.deepEqual(parsePublicPath("/myapp/2"), { username: "myapp", slot: 2, rest: "/" });
    assert.deepEqual(parsePublicPath("/myapp/3/deep/path"), { username: "myapp", slot: 3, rest: "/deep/path" });
    assert.deepEqual(parsePublicPath("/myapp/"), { username: "myapp", slot: 1, rest: "/" });
    assert.deepEqual(parsePublicPath("/MyApp/2"), { username: "myapp", slot: 2, rest: "/" });
  });
  it("never substring-matches", () => {
    // /myapp2 is its own username, NOT /myapp slot 2
    assert.deepEqual(parsePublicPath("/myapp2"), { username: "myapp2", slot: 1, rest: "/" });
    // /myapp/22 → rest path "/22", not slot 22
    assert.deepEqual(parsePublicPath("/myapp/22"), { username: "myapp", slot: 1, rest: "/22" });
    // /myapp/4 → rest, not a slot
    assert.deepEqual(parsePublicPath("/myapp/4"), { username: "myapp", slot: 1, rest: "/4" });
  });
  it("rejects empty/root", () => {
    assert.equal(parsePublicPath("/"), null);
    assert.equal(parsePublicPath(""), null);
  });
  it("builds stable paths", () => {
    assert.equal(routePathFor("MyApp", 1), "/myapp");
    assert.equal(routePathFor("MyApp", 2), "/myapp/2");
    assert.equal(publicUrlFor("https://t.example.com/", "A", 3), "https://t.example.com/a/3");
  });
});

describe("quota math", () => {
  it("computes remaining/exhaustion", () => {
    const s = { uploadUsed: 100, downloadUsed: 50, uploadLimit: 1000, downloadLimit: 40, periodStart: "", periodEnd: "" };
    assert.deepEqual(quotaRemaining(s), { uploadLeft: 900, downloadLeft: 0 });
    assert.equal(quotaExhausted(s), "download");
    assert.equal(quotaExhausted({ ...s, downloadUsed: 0, uploadUsed: 1000 }), "upload");
    assert.equal(quotaExhausted({ ...s, uploadLimit: -1, downloadLimit: -1 }), null);
  });
  it("treats each limit independently (mixed unlimited)", () => {
    const s = { uploadUsed: 10, downloadUsed: 500, uploadLimit: -1, downloadLimit: 1000, periodStart: "", periodEnd: "" };
    assert.deepEqual(quotaRemaining(s), { uploadLeft: Number.MAX_SAFE_INTEGER, downloadLeft: 500 });
    const t = { uploadUsed: 10, downloadUsed: 500, uploadLimit: 1000, downloadLimit: 0, periodStart: "", periodEnd: "" };
    assert.deepEqual(quotaRemaining(t), { uploadLeft: 990, downloadLeft: Number.MAX_SAFE_INTEGER });
    assert.equal(quotaExhausted({ ...s, downloadUsed: 1000 }), "download");
    assert.equal(quotaExhausted({ ...t, uploadUsed: 1000 }), "upload");
  });
  it("warn thresholds + formatting", () => {
    assert.equal(shouldWarn(800, 1000, 80), true);
    assert.equal(shouldWarn(799, 1000, 80), false);
    assert.equal(usagePercent(500, 1000), 50);
    assert.equal(formatBytes(1073741824), "1.0 GB");
  });
});

describe("error codes map to status", () => {
  it("stable mapping", () => {
    assert.equal(statusFor("TUNNEL_LIMIT_REACHED"), 429);
    assert.equal(statusFor("ANON_EXPIRED"), 410);
    assert.equal(statusFor("NOT_AUTHENTICATED"), 401);
    assert.equal(statusFor("ROUTE_OFFLINE"), 502);
  });
});

describe("protocol validation", () => {
  it("accepts good client frames", () => {
    assert.equal(validateClientFrame({ type: "hello", protocolVersion: 1, auth: { mode: "anonymous" } }), null);
    assert.equal(validateClientFrame({ type: "register", slot: 2, localPort: 3000 }), null);
    assert.equal(validateClientFrame({ type: "response_head", requestId: "req_x", status: 200, headers: {} }), null);
  });
  it("rejects bad/oversized/malformed frames", () => {
    assert.ok(validateClientFrame({ type: "register", slot: 9, localPort: 3000 }));
    assert.ok(validateClientFrame({ type: "register", slot: 1, localPort: 99999 }));
    assert.ok(validateClientFrame({ type: "response_chunk", requestId: "x", data: "!!not-b64!!" }));
    assert.ok(validateClientFrame({ type: "response_chunk", requestId: "x", data: "A".repeat(200 * 1024) }));
    assert.ok(validateClientFrame({ type: "nope" }));
    assert.ok(validateClientFrame("string"));
    assert.ok(validateClientFrame({ type: "response_head", requestId: "x", status: 99, headers: {} }));
  });
  it("validates server frames", () => {
    assert.equal(validateServerFrame({ type: "request_head", requestId: "a", method: "GET", path: "/", headers: {} }), null);
    assert.ok(validateServerFrame({ type: "request_head", requestId: "a", method: "BREW", path: "/", headers: {} }));
  });
  it("rejects non-finite heartbeat timestamps", () => {
    assert.equal(validateClientFrame({ type: "heartbeat", at: Date.now() }), null);
    assert.ok(validateClientFrame({ type: "heartbeat", at: NaN }));
    assert.ok(validateClientFrame({ type: "heartbeat", at: Infinity }));
    assert.ok(validateClientFrame({ type: "heartbeat" }));
  });
});

describe("static web UI", () => {
  const dir = webDir();
  it("web directory resolves with all pages", () => {
    assert.ok(dir, "web/ directory must be resolvable from the built server");
    for (const [route, file] of [
      ["/", "index.html"],
      ["/login", "login.html"],
      ["/register", "register.html"],
      ["/dashboard", "dashboard.html"],
      ["/admin", "admin.html"],
      ["/docs", "docs.html"],
      ["/device", "device.html"],
    ] as Array<[string, string]>) {
      assert.equal(pageFor(route), file, route);
      assert.ok(existsSync(join(dir!, file)), `${file} must exist`);
    }
    assert.equal(pageFor("/nope"), null);
    assert.ok(existsSync(join(dir!, "offline.html")), "offline.html must exist (gateway 502 page)");
  });

  it("pages are mobile-responsive, CDN-styled and reference existing assets", () => {
    for (const file of ["index.html", "login.html", "register.html", "dashboard.html", "admin.html", "docs.html", "device.html", "offline.html"]) {
      const html = readFileSync(join(dir!, file), "utf8");
      assert.ok(html.includes('name="viewport"'), `${file}: missing viewport meta`);
      assert.ok(html.includes("cdn.tailwindcss.com"), `${file}: Tailwind CDN missing`);
      for (const m of html.matchAll(/<script src="(\/assets\/[^"]+)"/g)) {
        const asset = m[1].slice("/assets/".length);
        assert.ok(existsSync(join(dir!, "assets", asset)), `${file}: missing asset ${m[1]}`);
      }
      for (const m of html.matchAll(/<link[^>]+href="(\/assets\/[^"]+)"/g)) {
        const asset = m[1].slice("/assets/".length);
        assert.ok(existsSync(join(dir!, "assets", asset)), `${file}: missing asset ${m[1]}`);
      }
    }
  });

  it("inline and asset scripts parse as valid JavaScript", () => {
    const files = ["app.js", "login.js", "register.js", "dashboard.js", "admin.js", "device.js"];
    for (const f of files) {
      const src = readFileSync(join(dir!, "assets", f), "utf8");
      assert.doesNotThrow(() => new Function(src), `${f}: syntax error`);
    }
    for (const f of ["index.html", "login.html", "register.html", "dashboard.html", "admin.html", "device.html", "docs.html"]) {
      const html = readFileSync(join(dir!, f), "utf8");
      for (const s of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) {
        assert.doesNotThrow(() => new Function(s), `${f}: inline script syntax error`);
      }
    }
  });

  it("template placeholders render with server values", () => {
    const cfg = loadConfig();
    const out = renderTemplate("<i>{{baseUrl}}|{{anonTtlSeconds}}|{{anonTtlMinutes}}|{{version}}</i>", cfg);
    assert.ok(!out.includes("{{"), "all placeholders must be replaced");
    assert.ok(out.includes(cfg.publicBaseUrl.replace(/\/$/, "")));
  });

  it("offline page renders from web/ and escapes the route path", () => {
    const raw = readFileSync(join(dir!, "offline.html"), "utf8");
    assert.ok(raw.includes("{{routePath}}"), "offline.html must carry the routePath placeholder");
    const out = renderOffline(raw, loadConfig(), `/x-<script>alert("pwn")</script>`);
    assert.ok(!out.includes("<script>alert"), "route path must be HTML-escaped");
    assert.ok(out.includes("&lt;script&gt;"));
    assert.ok(out.includes("offline"), "offline page must say so");
    assert.ok(!out.includes("{{"), "all placeholders must be replaced");
  });

  it("wired pages: login/register/device/dashboard scripts exist", () => {
    const index = readFileSync(join(dir!, "index.html"), "utf8");
    assert.ok(index.includes('href="/login"'), "landing must link to login");
    assert.ok(index.includes('href="/register"'), "landing must link to register");
    const login = readFileSync(join(dir!, "login.html"), "utf8");
    assert.ok(login.includes("ADMIN_PASSWORD"), "login page must document admin bootstrap");
    const device = readFileSync(join(dir!, "device.html"), "utf8");
    assert.ok(device.includes("device_code") || device.includes("/device"), "device page wired");
  });
});

describe("db migrations", () => {
  it("v3 databases upgrade to v4 with an empty deviceAuths table", () => {
    const v3 = {
      schemaVersion: 3,
      users: [], sessions: [], tokens: [], routes: [], anonSessions: [], usage: [],
      resets: [], audit: [], requestLogs: [], tunnels: [], settings: { maintenanceMode: false },
    };
    const db = migrate(v3 as unknown as Record<string, unknown>);
    assert.equal(db.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(db.deviceAuths, []);
  });
  it("brand new databases carry deviceAuths", () => {
    const db = migrate({});
    assert.deepEqual(db.deviceAuths, []);
  });
});

describe("passwords (scrypt)", () => {
  it("hash + verify roundtrip", async () => {
    const h = await hashPassword("Password1!");
    assert.ok(h.startsWith("scrypt$v1$"));
    assert.equal(await verifyPassword("Password1!", h), true);
    assert.equal(await verifyPassword("wrong", h), false);
    assert.equal(await verifyPassword("x", "garbage"), false);
  });
  it("rejects short passwords", async () => {
    await assert.rejects(() => hashPassword("short"));
  });
});

describe("config validation", () => {
  it("rejects bad production secrets", () => {
    const old = { ...process.env };
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "short";
    assert.throws(() => loadConfig(), /SESSION_SECRET/);
    process.env = old;
  });
  it("rejects out-of-range TTL", () => {
    const old = { ...process.env };
    process.env.ANONYMOUS_TUNNEL_TTL_SECONDS = "99999";
    assert.throws(() => loadConfig(), /TTL/);
    process.env = old;
  });
  it("binds all interfaces by default and honors HOST", () => {
    const old = { ...process.env };
    delete process.env.HOST;
    assert.equal(loadConfig().host, "0.0.0.0");
    process.env.HOST = "127.0.0.1";
    assert.equal(loadConfig().host, "127.0.0.1");
    process.env = old;
  });
  it("derives the public URL from platform domains only when unset", () => {
    const old = { ...process.env };
    delete process.env.PUBLIC_DOMAIN;
    delete process.env.PUBLIC_BASE_URL;
    process.env.REPLIT_DOMAINS = "first.example.net, second.example.net";
    let c = loadConfig();
    assert.equal(c.publicDomain, "first.example.net");
    assert.equal(c.publicBaseUrl, "https://first.example.net");
    delete process.env.REPLIT_DOMAINS;
    process.env.REPLIT_DEV_DOMAIN = "dev.example.org";
    c = loadConfig();
    assert.equal(c.publicBaseUrl, "https://dev.example.org");
    process.env.PUBLIC_BASE_URL = "https://explicit.example.com";
    assert.equal(loadConfig().publicBaseUrl, "https://explicit.example.com");
    process.env = old;
  });
});

describe("validators", () => {
  it("port/email", () => {
    assert.equal(isPort(3000), true);
    assert.equal(isPort(0), false);
    assert.equal(email("a@b.com"), true);
    assert.equal(email("nope"), false);
    assert.equal(str("x"), true);
  });
});
