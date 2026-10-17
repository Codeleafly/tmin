#!/usr/bin/env node
/** Real smoke test: boots the server binary, checks surfaces, cleans up. */
const { spawn } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const http = require("node:http");

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function get(path, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.get(`${BASE}${path}`, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolvePromise({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    setTimeout(() => {
      req.destroy(new Error("timeout"));
    }, 5000);
  });
}

function post(path, body) {
  return new Promise((resolvePromise, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${BASE}${path}`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolvePromise({ status: res.statusCode, body: out, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "tmin-smoke-"));
  const server = spawn(process.execPath, [resolve(__dirname, "../dist/apps/server/src/index.js")], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(PORT),
      DATA_DIR: dir,
      DATA_FILE: "smoke.json",
      SESSION_SECRET: "smoke-secret-0123456789-abcdefghij",
      ADMIN_PASSWORD: "Smokepass1!",
      LOG_LEVEL: "error",
      PUBLIC_BASE_URL: BASE,
      PUBLIC_DOMAIN: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverErr = "";
  server.stderr.on("data", (d) => (serverErr += d));

  try {
    // wait for ready
    let up = false;
    for (let i = 0; i < 50; i++) {
      try {
        const h = await get("/health");
        if (h.status === 200) {
          up = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    check("server boots and /health returns 200", up, serverErr.slice(0, 200));
    if (!up) return;

    const landing = await get("/");
    check("landing page served", landing.status === 200 && landing.body.includes("tmin"));
    const docs = await get("/docs");
    check("docs site served", docs.status === 200 && docs.body.includes("Quick start") || docs.body.includes("Getting started"));
    const openapi = await get("/openapi.json");
    check("openapi.json served", openapi.status === 200 && openapi.body.includes("openapi"));
    const notFound = await get("/nope-route");
    check("unknown route is 404", notFound.status === 404);
    const reserved = await post("/api/v1/auth/register", { username: "api", email: "a@b.co", password: "Password1!" });
    check("reserved username rejected", reserved.status === 400, `got ${reserved.status}`);
    const reg = await post("/api/v1/auth/register", { username: "smoke", email: "smoke@b.co", password: "Password1!" });
    check("registration works", reg.status === 201, `got ${reg.status}`);
    const login = await post("/api/v1/auth/login", { login: "smoke", password: "Password1!" });
    check("login sets session cookie", login.status === 200 && String(login.headers["set-cookie"] || "").includes("tmin_sid"));
    const badLogin = await post("/api/v1/auth/login", { login: "smoke", password: "wrong" });
    check("wrong password rejected", badLogin.status === 401);
    const admin = await post("/api/v1/auth/login", { login: "admin", password: "Smokepass1!" });
    check("admin bootstrap works", admin.status === 200);
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => server.on("exit", r));
  }

  console.log(failures === 0 ? "\nsmoke: ALL CHECKS PASSED" : `\nsmoke: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
