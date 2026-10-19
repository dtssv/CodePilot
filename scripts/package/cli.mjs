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
} from "./_util.mjs";
import { bundleNodeEntry, runPkg } from "./bundle-node.mjs";

const outDir = join(RELEASE_ROOT, "cli");
const cacheDir = join(CACHE_ROOT, "cli");
const entryOut = join(cacheDir, "cli.cjs");
const webCache = join(cacheDir, "web");

async function buildWeb {
  pnpm(["--filter", "@codepilot/web", "build"]);
  const webDist = join(REPO_ROOT, "apps", "web", "dist");
  if (!existsSync(join(webDist, "index.html"))) fail("web dist missing after build");
  cleanDir(webCache);
  copyTree(webDist, webCache);
}

async function bundleCli {
  pnpm(["--filter", "@codepilot/protocol", "build"]);
  await bundleNodeEntry({
    entry: join(REPO_ROOT, "packages", "protocol", "dist", "cli.js"),
    outfile: entryOut,
  });
}

function packageBinaries {
  ensureDir(outDir);
  const targets = resolveTargets;
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
      log(`skip ${t.pkgTarget}: ${err instanceof Error ? err.message : err}`);
      continue;
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
    const webNextTo = join(outDir, `web-${t.binarySuffix.replace(/\.exe$/, "")}`);
 // One shared web/ is enough — copy once as outDir/web
    const sharedWeb = join(outDir, "web");
    if (!existsSync(join(sharedWeb, "index.html"))) {
      copyTree(webCache, sharedWeb);
    }
    void webNextTo;
    log(`binary ready: ${binary}`);
  }
}

function packageNpm {
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

async function main {
  ensureDir(outDir);
  await buildWeb;
  await bundleCli;
  packageBinaries;
  packageNpm;
  log(`CLI release → ${outDir}`);
}

main.catch((e) => {
  console.error(e);
  process.exit(1);
});
