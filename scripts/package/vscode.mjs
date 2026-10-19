#!/usr/bin/env node
/**
 * Build and package the VS Code extension → dist/release/vscode/*.vsix
 */

import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_ROOT, REPO_ROOT, ensureDir, fail, log, pnpm } from "./_util.mjs";

const outDir = join(RELEASE_ROOT, "vscode");
const appDir = join(REPO_ROOT, "apps", "vscode");

async function main {
  ensureDir(outDir);
 // Remove stale vsix in the app dir so we only move fresh ones.
  for (const f of readdirSync(appDir).filter((n) => n.endsWith(".vsix"))) {
    try {
      renameSync(join(appDir, f), join(outDir, `prev-${f}`));
    } catch {
 /* ignore */
    }
  }
  pnpm(["--filter", "codepilot-vscode", "build"]);
  pnpm(["--filter", "codepilot-vscode", "package"]);
  const found = readdirSync(appDir).filter((f) => f.endsWith(".vsix"));
  if (found.length === 0) fail("No .vsix produced under apps/vscode");
  for (const f of found) {
    const dest = join(outDir, f);
    renameSync(join(appDir, f), dest);
    log(`vsix → ${dest}`);
  }
 // Drop any prev-* leftovers
  for (const f of readdirSync(outDir).filter((n) => n.startsWith("prev-"))) {
    try {
      const { rmSync } = await import("node:fs");
      rmSync(join(outDir, f), { force: true });
    } catch {
 /* ignore */
    }
  }
  if (!existsSync(outDir)) fail("vscode out dir missing");
  log(`VS Code release → ${outDir}`);
}

main.catch((e) => {
  console.error(e);
  process.exit(1);
});
