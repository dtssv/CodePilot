#!/usr/bin/env node
/**
 * Package the Web end as a **runnable program** (`codepilot-web`), not a static zip.
 * Same engine as the CLI: starts `serve --web --web-root` and opens the browser.
 * Binary name triggers the web-launcher argv rewrite in protocol/cli.ts.
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
} from "./_util.mjs";
import { bundleNodeEntry, runPkg } from "./bundle-node.mjs";

const outDir = join(RELEASE_ROOT, "web");
const cacheDir = join(CACHE_ROOT, "web");
const entryOut = join(cacheDir, "cli.cjs");
const webCache = join(cacheDir, "web");

async function main {
  ensureDir(outDir);
  pnpm(["--filter", "@codepilot/web", "build"]);
  const webDist = join(REPO_ROOT, "apps", "web", "dist");
  if (!existsSync(join(webDist, "index.html"))) fail("web dist missing");
  cleanDir(webCache);
  copyTree(webDist, webCache);

  pnpm(["--filter", "@codepilot/protocol", "build"]);
  await bundleNodeEntry({
    entry: join(REPO_ROOT, "packages", "protocol", "dist", "cli.js"),
    outfile: entryOut,
  });

  const sharedWeb = join(outDir, "web");
  if (!existsSync(join(sharedWeb, "index.html"))) copyTree(webCache, sharedWeb);

  for (const t of resolveTargets) {
    const base = join(outDir, `codepilot-web-${t.binarySuffix.replace(/\.exe$/, "")}`);
    try {
      runPkg({ entry: entryOut, targets: [t.pkgTarget], outputPath: base });
    } catch (err) {
      log(`skip ${t.pkgTarget}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (t.family === "win") {
      const exe = `${base}.exe`;
      const wanted = join(outDir, `codepilot-web-${t.binarySuffix}`);
      if (existsSync(exe) && exe !== wanted) renameSync(exe, wanted);
    } else if (existsSync(base)) {
      try {
        chmodSync(base, 0o755);
      } catch {
 /* ignore */
      }
    }
    log(`web launcher ready: codepilot-web-${t.binarySuffix}`);
  }
  log(`Web release → ${outDir}`);
  log(`Run: ./dist/release/web/codepilot-web-<platform>  (opens browser)`);
}

main.catch((e) => {
  console.error(e);
  process.exit(1);
});
