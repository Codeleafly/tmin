"use strict";

// Termux compatibility shim (no-op everywhere else).
//
// Termux has no /usr/bin/env, so npm bin symlinks to "#!/usr/bin/env node"
// scripts fail with "bad interpreter". Interactive Termux shells load
// termux-exec and work anyway, but non-login/agent shells do not. Whenever a
// global bin symlink exists (npm link / npm i -g), we replace it with a tiny
// sh wrapper that execs node directly on the symlink's real target.
//
// Safety: only symlinks are ever rewritten, to the exact file npm pointed at.
// Our own wrapper files are left as-is (idempotent); anything else is never
// touched. Runs from "prepare" and "postinstall"; always exits 0.

const fs = require("node:fs");
const path = require("node:path");

const MARK = "# tmin-termux-wrapper";

function shim(binDir, link) {
  let st;
  try {
    st = fs.lstatSync(link);
  } catch {
    return false; // no bin created (plain repo install): nothing to do
  }
  if (!st.isSymbolicLink()) return false; // wrapper or foreign file: leave it

  let target;
  try {
    target = fs.realpathSync(link);
  } catch {
    return false;
  }
  if (!fs.existsSync(target)) return false;

  const wrapper = `#!${path.join(binDir, "sh")}\n${MARK}\nexec ${JSON.stringify(
    process.execPath
  )} ${JSON.stringify(target)} "$@"\n`;
  try {
    fs.rmSync(link, { force: true });
    fs.writeFileSync(link, wrapper, { mode: 0o755 });
    fs.chmodSync(link, 0o755);
    return true;
  } catch {
    return false; // best effort; never block an install
  }
}

function main() {
  if (fs.existsSync("/usr/bin/env")) return; // standard systems: no-op

  const nodePath = process.execPath;
  const prefix =
    process.env.npm_config_prefix ||
    process.env.PREFIX ||
    path.dirname(path.dirname(nodePath));
  const binDir = path.join(prefix, "bin");
  if (!fs.existsSync(path.join(binDir, "sh")) || !fs.existsSync(nodePath)) return;

  const root = path.resolve(__dirname, "..");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return;
  }

  let changed = 0;
  for (const name of Object.keys(pkg.bin || {})) {
    if (shim(binDir, path.join(binDir, name))) changed += 1;
  }
  if (changed > 0) {
    process.stdout.write(`tmin: created Termux sh wrapper(s) in ${binDir}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch {
    // ignore
  }
}

module.exports = { main };
