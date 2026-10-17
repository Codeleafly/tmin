"use strict";

// Build helper used by "prepare"/"prepack" so that `npm i -g .` from the
// repository root always installs a working command:
//   - builds dist/ when it is missing or older than the TypeScript sources
//   - prefers the local typescript compiler, falls back to a global `tsc`
//   - skips gracefully (with a clear warning) when no compiler is available
//   - then runs the Termux bin shim (covers `npm link`, where bins exist
//     by the time "prepare" runs)
// Always exits 0 unless the compiler itself fails.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const stamp = path.join(root, "dist", "apps", "cli", "src", "index.js");

function newestSourceTime(dir, newest) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = newestSourceTime(full, newest);
    } else if (entry.name.endsWith(".ts")) {
      const t = fs.statSync(full).mtimeMs;
      if (t > newest) newest = t;
    }
  }
  return newest;
}

function sourcesNewest() {
  let newest = 0;
  for (const base of ["apps", "packages"]) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, base));
    } catch {
      continue;
    }
    for (const name of names) {
      newest = newestSourceTime(path.join(root, base, name, "src"), newest);
    }
  }
  return newest;
}

function buildIfNeeded() {
  const built = fs.existsSync(stamp) ? fs.statSync(stamp).mtimeMs : 0;
  const newest = sourcesNewest();
  if (built > 0 && newest > 0 && built >= newest) return;

  const tsconfig = path.join(root, "tsconfig.json");
  const localTsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  let cmd = null;
  let args = [];
  if (fs.existsSync(localTsc)) {
    cmd = process.execPath;
    args = [localTsc, "-p", tsconfig];
  } else {
    const probe = spawnSync("tsc", ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) {
      cmd = "tsc";
      args = ["-p", tsconfig];
    }
  }

  if (!cmd) {
    process.stdout.write(
      "tmin: dist/ is missing or stale and no TypeScript compiler was found.\n" +
        "tmin: run `npm install && npm run build` in the repo before installing globally.\n"
    );
    return;
  }

  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status || 1);
}

try {
  buildIfNeeded();
  require("./termux-link.js").main();
} catch (e) {
  process.stdout.write(`tmin: prepare warning: ${e && e.message ? e.message : e}\n`);
}
