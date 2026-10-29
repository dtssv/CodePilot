#!/usr/bin/env node
/**
 * Package the Electron desktop app with electron-builder.
 * Targets: win nsis, mac dmg, linux AppImage (per PACKAGE_TARGETS / --all).
 * macOS builds may only succeed on a Mac host.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  RELEASE_ROOT,
  REPO_ROOT,
  copyTree,
  ensureDir,
  fail,
  listFiles,
  log,
  pnpm,
  resolveTargets,
  run,
} from "./_util.mjs";

const appDir = join(REPO_ROOT, "apps", "desktop");
const outDir = join(RELEASE_ROOT, "desktop");

function builderArgsForFamily(family) {
  // Build every arch declared in package.json's build config for this OS.
  if (family === "win") return ["--win", "nsis", "--x64", "--arm64"];
  if (family === "mac") return ["--mac", "dmg", "--x64", "--arm64"];
  return ["--linux", "AppImage", "--x64", "--arm64"];
}

async function main() {
  ensureDir(outDir);
  // Build the workspace deps whose dist/ is bundled into the app BEFORE web/
  // desktop. Omitting these shipped stale core/protocol dist (e.g. a daemon
  // missing newly-added RPCs), so the packaged app silently lacked features
  // whose source had changed. Build the whole dependency chain here.
  pnpm(["--filter", "@codepilot/core", "build"]);
  pnpm(["--filter", "@codepilot/protocol", "build"]);
  pnpm(["--filter", "@codepilot/web", "build"]);
  pnpm(["--filter", "@codepilot/desktop", "build"]);

  const webDist = join(REPO_ROOT, "apps", "web", "dist");
  if (!existsSync(join(webDist, "index.html"))) fail("web dist missing");
 // Stage web into desktop resources expected by main.ts findWebRoot.
  const staged = join(appDir, "resources", "web");
  copyTree(webDist, staged);

 // Trim local build residue from the workspace deps electron-builder will
 // collect (coverage reports, packed .tgz, tsbuildinfo). These are not in
 // each package's npm `files` allowlist but still sit on disk under pnpm.
  for (const pkg of ["core", "protocol"]) {
    const base = join(REPO_ROOT, "packages", pkg);
    for (const junk of ["coverage"]) {
      rmSync(join(base, junk), { recursive: true, force: true });
    }
    for (const f of listFiles(base, (_p, name) => name.endsWith(".tgz") || name.endsWith(".tsbuildinfo"))) {
      rmSync(f, { force: true });
    }
  }

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
 // Per-arch targets come from the `build.<platform>.target[].arch` config.
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
