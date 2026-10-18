#!/usr/bin/env node
/**
 * Project lint: structural + hygiene checks (no external linters, keeps install tiny).
 * Checks:
 *  1. no console.log in server/src (use the structured logger)
 *  2. no eval / new Function
 *  3. no hardcoded secrets (password=, secret=, token= literals)
 *  4. module size guard (<700 lines) — keeps files focused
 *  5. no import of node:child_process inside server runtime
 *  6. every ROUTE_TABLE path is served by an /api/v1 handler file
 *  7. no HTML documents in server/src — pages live in web/ (AGENTS.md)
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
let failures = 0;

function fail(file, msg) {
  failures++;
  console.error(`LINT ${file}: ${msg}`);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const serverSrc = walk(path.join(ROOT, "apps/server/src"));
const cliSrc = walk(path.join(ROOT, "apps/cli/src"));
const pkgSrc = walk(path.join(ROOT, "packages"));

for (const f of serverSrc) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split("\n");
  if (lines.length > 700) fail(rel, `file too large (${lines.length} lines > 700)`);
  if (!rel.endsWith("logger.ts") && /\bconsole\.(log|error|warn)\(/.test(src)) {
    fail(rel, "console.* found — use logger from src/logger.ts");
  }
  if (/\beval\s*\(/.test(src) || /new Function\(/.test(src)) fail(rel, "eval/new Function forbidden");
  if (/<!doctype/i.test(src) || /<html[\s>]/i.test(src)) {
    fail(rel, "HTML document in server source — web pages live in web/ (see AGENTS.md)");
  }
  if (/node:child_process/.test(src)) fail(rel, "child_process must not be used in server runtime");
  for (const m of src.matchAll(/(password|secret|token)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{12,}["']/gi)) {
    fail(rel, `possible hardcoded secret: ${m[0].slice(0, 40)}…`);
  }
  if (/\.\.\/\.\.\/dist|require\(.*\/dist\//.test(src)) fail(rel, "must not import from dist/");
}

for (const f of [...cliSrc, ...pkgSrc]) {
  const rel = path.relative(ROOT, f);
  const lines = fs.readFileSync(f, "utf8").split("\n");
  if (lines.length > 700) fail(rel, `file too large (${lines.length} lines > 700)`);
  if (/\beval\s*\(/.test(lines.join("\n"))) fail(rel, "eval forbidden");
}

// Route table ↔ handler files
const openapi = fs.readFileSync(path.join(ROOT, "apps/server/src/api/openapi.ts"), "utf8");
const routes = [...openapi.matchAll(/path: "(\/api\/v1\/[^"]+)"/g)].map((m) => m[1]);
const handlers = [
  fs.readFileSync(path.join(ROOT, "apps/server/src/api/auth.ts"), "utf8"),
  fs.readFileSync(path.join(ROOT, "apps/server/src/api/resources.ts"), "utf8"),
  fs.readFileSync(path.join(ROOT, "apps/server/src/api/admin.ts"), "utf8"),
].join("\n");
for (const r of routes) {
  // dynamic segments appear as regex patterns in handlers; check the static prefix segment
  const seg = r.replace(/\/api\/v1\/?/, "").split("/")[0];
  if (!handlers.includes(seg)) fail("api/openapi.ts", `route ${r} has no handler referencing "${seg}"`);
}

if (failures > 0) {
  console.error(`\nlint: ${failures} problem(s) found`);
  process.exit(1);
}
console.log("lint: OK");
