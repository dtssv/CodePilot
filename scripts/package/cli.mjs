#!/usr/bin/env node
/**
 * Package the `codepilot` CLI:
 * - platform binaries via esbuild + @yao-pkg/pkg
 * - npm .tgz via pnpm pack
 * Embeds / copies the web SPA next to each binary (CODEPILOT_WEB_ROOT / ./web).
 */

import { chmodSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  CACHE_ROOT,
  RELEASE_ROOT,
  REPO_ROOT,
  cleanDir,
  copyTree,
  ensureDir,
  fail,
  log,
  pnpm,
  resolveTargets,
  run,
  tarGzipDir,
} from "./_util.mjs";
import { bundleNodeEntry, runPkg } from "./bundle-node.mjs";

const outDir = join(RELEASE_ROOT, "cli");
const cacheDir = join(CACHE_ROOT, "cli");
const entryOut = join(cacheDir, "cli.cjs");
const webCache = join(cacheDir, "web");

async function buildWeb() {
  pnpm(["--filter", "@codepilot/web", "build"]);
  const webDist = join(REPO_ROOT, "apps", "web", "dist");
  if (!existsSync(join(webDist, "index.html"))) fail("web dist missing after build");
  cleanDir(webCache);
  copyTree(webDist, webCache);
}

async function bundleCli() {
  await bundleNodeEntry({
    entry: join(REPO_ROOT, "packages", "protocol", "dist", "cli.js"),
    outfile: entryOut,
  });
}

function packageBinaries() {
  ensureDir(outDir);
  const targets = resolveTargets();
  for (const t of targets) {
    const outName = `codepilot-${t.binarySuffix}`;
    const outPath = join(outDir, outName.replace(/\.exe$/, ""));
    try {
      runPkg({
        entry: entryOut,
        targets: [t.pkgTarget],
        outputPath: outPath,
      });
    } catch (err) {
      // Don't silently skip: a 504'd Node-binary download used to fail soft
      // here, producing a release with no CLI binary. Surface the error so
      // the CI job fails instead of shipping an incomplete release.
      fail(`pkg ${t.pkgTarget}: ${err instanceof Error ? err.message : err}`);
    }
 // pkg may emit outPath or outPath.exe
    let binary = outPath;
    if (t.family === "win") {
      const exe = `${outPath}.exe`;
      if (existsSync(exe)) binary = exe;
      const wanted = join(outDir, outName);
      if (binary !== wanted && existsSync(binary)) {
        renameSync(binary, wanted);
        binary = wanted;
      }
    } else if (existsSync(outPath)) {
      try {
        chmodSync(outPath, 0o755);
      } catch {
 /* ignore */
      }
    }
 // Ship SPA beside the binary for detectWebRoot(execPath/web).
 // One shared web/ is enough — copy once as outDir/web
    const sharedWeb = join(outDir, "web");
    if (!existsSync(join(sharedWeb, "index.html"))) {
      copyTree(webCache, sharedWeb);
    }
    log(`binary ready: ${binary}`);
  }
 // Per-target web SPA tarball — the install.sh/ps1 release path downloads
 // codepilot-web-<target>.tar.gz and unpacks it beside the binary.
  const sharedWeb = join(outDir, "web");
  if (existsSync(join(sharedWeb, "index.html"))) {
    for (const t of targets) {
      const suffix = t.binarySuffix.replace(/\.exe$/, "");
      const tarball = join(outDir, `codepilot-web-${suffix}.tar.gz`);
      tarGzipDir(sharedWeb, tarball);
      log(`web tarball: ${tarball}`);
    }
  }
}

function packageNpm() {
  const npmDir = ensureDir(join(outDir, "npm"));
  const dirs = {
    "@codepilot/core": join(REPO_ROOT, "packages", "core"),
    "@codepilot/protocol": join(REPO_ROOT, "packages", "protocol"),
  };
  for (const [name, cwd] of Object.entries(dirs)) {
    log(`pack ${name}`);
    run("corepack", ["pnpm", "pack", "--pack-destination", npmDir], { cwd });
  }
  log(`npm packs → ${npmDir}`);
}

async function main() {
  ensureDir(outDir);
  // Build core+protocol first — both web (vite import) and bundleCli (esbuild
  // import) resolve @codepilot/core and @codepilot/protocol from dist/.
  pnpm(["--filter", "@codepilot/core", "build"]);
  pnpm(["--filter", "@codepilot/protocol", "build"]);
  await buildWeb();
  await bundleCli();
  packageBinaries();
  packageNpm();
  log(`CLI release → ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
