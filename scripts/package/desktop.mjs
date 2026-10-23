#!/usr/bin/env node
/**
 * Package the Electron desktop app with electron-builder.
 * Targets: win nsis, mac dmg, linux AppImage (per PACKAGE_TARGETS / --all).
 * macOS builds may only succeed on a Mac host.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  RELEASE_ROOT,
  REPO_ROOT,
  copyTree,
  ensureDir,
  fail,
  log,
  pnpm,
  resolveTargets,
  run,
} from "./_util.mjs";

const appDir = join(REPO_ROOT, "apps", "desktop");
const outDir = join(RELEASE_ROOT, "desktop");

function builderArgsForFamily(family) {
  if (family === "win") return ["--win", "nsis"];
  if (family === "mac") return ["--mac", "dmg"];
  return ["--linux", "AppImage"];
}

async function main() {
  ensureDir(outDir);
  pnpm(["--filter", "@codepilot/web", "build"]);
  pnpm(["--filter", "@codepilot/desktop", "build"]);

  const webDist = join(REPO_ROOT, "apps", "web", "dist");
  if (!existsSync(join(webDist, "index.html"))) fail("web dist missing");
 // Stage web into desktop resources expected by main.ts findWebRoot.
  const staged = join(appDir, "resources", "web");
  copyTree(webDist, staged);

  const families = [...new Set(resolveTargets().map((t) => t.family))];
  for (const family of families) {
    const args = [
      "electron-builder",
      ...builderArgsForFamily(family),
      "--publish",
      "never",
      `-c.directories.output=${outDir}`,
    ];
 // Run inside apps/desktop so local electron-builder + config resolve.
    const code = run("corepack", ["pnpm", "exec", ...args], { allowFail: true, cwd: appDir });
    if (code !== 0) {
      log(
        `desktop ${family} failed (exit ${code}). ` +
          (family === "mac" ? "macOS targets usually require a Mac host / signing tooling." : "See electron-builder log above."),
      );
    }
  }
  log(`Desktop release → ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
