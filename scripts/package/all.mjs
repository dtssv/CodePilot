#!/usr/bin/env node
/**
 * Build everything, then package all endpoints.
 * Failures on optional cross-targets are logged; hard failures abort.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT, log, pnpm } from "./_util.mjs";

const steps = [
  ["web", join(REPO_ROOT, "scripts", "package", "web.mjs")],
  ["cli", join(REPO_ROOT, "scripts", "package", "cli.mjs")],
  ["tui", join(REPO_ROOT, "scripts", "package", "tui.mjs")],
  ["desktop", join(REPO_ROOT, "scripts", "package", "desktop.mjs")],
  ["vscode", join(REPO_ROOT, "scripts", "package", "vscode.mjs")],
  ["idea", join(REPO_ROOT, "scripts", "package", "idea.mjs")],
];

function runStep(name, script) {
  log(`==== package:${name} ====`);
  const r = spawnSync(process.execPath, [script, ...process.argv.slice(2)], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error(`package:${name} failed with exit ${r.status}`);
  }
}

pnpm(["-r", "--workspace-concurrency=4", "build"]);
for (const [name, script] of steps) {
  try {
    runStep(name, script);
  } catch (err) {
 // Desktop signing / IDEA JDK 17 are environment-sensitive — continue others.
    if (name === "desktop" || name === "idea") {
      log(`${err instanceof Error ? err.message : err} (continuing package:all)`);
      continue;
    }
    throw err;
  }
}
log("package:all finished → dist/release/");
