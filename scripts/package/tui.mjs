#!/usr/bin/env node
/**
 * Package `codepilot-tui`: platform binaries + npm .tgz.
 *
 * Ink/yoga use top-level await, so we `pnpm deploy` a prod tree and let pkg
 * follow real node_modules instead of esbuild-bundling the TUI into one CJS.
 */

import { chmodSync, existsSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CACHE_ROOT,
  RELEASE_ROOT,
  REPO_ROOT,
  cleanDir,
  ensureDir,
  fail,
  log,
  pnpm,
  resolveTargets,
  run,
} from "./_util.mjs";
import { runPkg } from "./bundle-node.mjs";

const outDir = join(RELEASE_ROOT, "tui");
const deployDir = join(CACHE_ROOT, "tui-deploy");

async function main() {
  ensureDir(outDir);
  pnpm(["--filter", "@codepilot/tui", "build"]);
  const distCli = join(REPO_ROOT, "apps", "tui", "dist", "cli.js");
  if (!existsSync(distCli)) fail("apps/tui/dist/cli.js missing");

  cleanDir(deployDir);
 // Portable prod install of the tui package + deps.
  pnpm(["--filter", "@codepilot/tui", "deploy", "--prod", deployDir]);

  const entry = join(deployDir, "dist", "cli.js");
  if (!existsSync(entry)) fail(`deploy missing ${entry}`);

 // pkg needs a package.json "bin" / main near the entry for some resolvers.
  const pkgJsonPath = join(deployDir, "package.json");
  if (existsSync(pkgJsonPath)) {
    const pj = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    pj.bin = { "codepilot-tui": "./dist/cli.js" };
    writeFileSync(pkgJsonPath, `${JSON.stringify(pj, null, 2)}\n`);
  }

  for (const t of resolveTargets()) {
    const base = join(outDir, `codepilot-tui-${t.binarySuffix.replace(/\.exe$/, "")}`);
    try {
      runPkg({ entry, targets: [t.pkgTarget], outputPath: base });
    } catch (err) {
      log(`skip ${t.pkgTarget}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (t.family === "win") {
      const exe = `${base}.exe`;
      const wanted = join(outDir, `codepilot-tui-${t.binarySuffix}`);
      if (existsSync(exe) && exe !== wanted) renameSync(exe, wanted);
    } else if (existsSync(base)) {
      try {
        chmodSync(base, 0o755);
      } catch {
 /* ignore */
      }
    }
  }

  const npmDir = ensureDir(join(outDir, "npm"));
  run("corepack", ["pnpm", "pack", "--pack-destination", npmDir], {
    cwd: join(REPO_ROOT, "apps", "tui"),
  });
  log(`TUI release → ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
