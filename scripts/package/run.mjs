#!/usr/bin/env node
/**
 * Run a packaged artifact for the current host.
 * Usage: node scripts/package/run.mjs <cli|tui|desktop|web> [-- args...]
 *
 * Web is an executable launcher (opens the browser UI), not a static zip.
 */

import { existsSync, readdirSync } from "node:fs";
import { spawn as spawnProc } from "node:child_process";
import { join } from "node:path";
import {
  RELEASE_ROOT,
  REPO_ROOT,
  currentPlatform,
  fail,
  findHostBinary,
  log,
} from "./_util.mjs";

const kind = process.argv[2];
const passthrough = process.argv.slice(3);
const args = passthrough[0] === "--" ? passthrough.slice(1) : passthrough;

if (!kind || !["cli", "tui", "desktop", "web"].includes(kind)) {
  fail("Usage: node scripts/package/run.mjs <cli|tui|desktop|web> [-- args...]");
}

function runBinary(bin, binArgs) {
  log(`exec ${bin} ${binArgs.join(" ")}`);
  const child = spawnProc(bin, binArgs, { stdio: "inherit", cwd: REPO_ROOT });
  child.on("exit", (code) => process.exit(code ?? 1));
}

function runDesktop {
  const dir = join(RELEASE_ROOT, "desktop");
  if (!existsSync(dir)) fail(`No desktop release at ${dir}. Run: pnpm package:desktop`);
  const { family } = currentPlatform;
  const files = readdirSync(dir);
  let app;
  if (family === "mac") {
    app = files.find((f) => f.endsWith(".app"));
    if (app) {
      spawnProc("open", [join(dir, app), ...args], { stdio: "inherit" });
      return;
    }
    const dmg = files.find((f) => f.endsWith(".dmg"));
    if (dmg) fail(`Install from DMG first: ${join(dir, dmg)}`);
  } else if (family === "win") {
    app = files.find((f) => /Setup.*\.exe$/i.test(f)) ?? files.find((f) => f.endsWith(".exe"));
  } else {
    app = files.find((f) => f.endsWith(".AppImage"));
  }
  if (!app) fail(`No runnable desktop artifact for ${family} in ${dir}`);
  const path = join(dir, app);
  runBinary(path, args);
}

if (kind === "desktop") {
  runDesktop;
} else {
  const namePrefix = kind === "web" ? "codepilot-web" : kind === "tui" ? "codepilot-tui" : "codepilot";
  const dir = join(RELEASE_ROOT, kind);
  const bin = findHostBinary(dir, namePrefix);
  if (!bin) {
    fail(`No ${namePrefix} binary in ${dir}. Run: pnpm package:${kind}`);
  }
  runBinary(bin, args);
}
