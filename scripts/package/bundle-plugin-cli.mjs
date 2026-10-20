#!/usr/bin/env node
/**
 * Bundle `packages/protocol/dist/cli.js` into a single CJS file for IDE plugins
 * (VS Code VSIX resources/codepilot-cli.cjs, IDEA lib/codepilot-cli.cjs).
 *
 * Usage: node scripts/package/bundle-plugin-cli.mjs [outfile]
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const outfile =
  process.argv[2] ??
  resolve(REPO_ROOT, "apps", "vscode", "resources", "codepilot-cli.cjs");

function log(msg) {
  console.log(`[bundle-plugin-cli] ${msg}`);
}

function fail(msg) {
  console.error(`[bundle-plugin-cli] ${msg}`);
  process.exit(1);
}

function resolveEsbuild() {
  const require = createRequire(import.meta.url);
  const candidates = [
    join(REPO_ROOT, "apps/vscode/node_modules/esbuild"),
    join(REPO_ROOT, "node_modules/esbuild"),
  ];
  for (const c of candidates) {
    try {
      return require(join(c, "lib/main.js"));
    } catch {
      /* try next */
    }
  }
  try {
    return require("esbuild");
  } catch {
    fail("esbuild not found — install apps/vscode deps or add esbuild at the repo root");
  }
}

async function main() {
  const entry = join(REPO_ROOT, "packages", "protocol", "dist", "cli.js");
  if (!existsSync(entry)) {
    log("building @codepilot/protocol…");
    const r = spawnSync("pnpm", ["--filter", "@codepilot/protocol", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (r.status !== 0) fail("protocol build failed");
  }
  if (!existsSync(entry)) fail(`missing ${entry} after protocol build`);

  mkdirSync(dirname(outfile), { recursive: true });
  const esbuild = resolveEsbuild();
  log(`esbuild ${entry} → ${outfile}`);
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: false,
    external: ["electron", "fsevents"],
    logLevel: "warning",
  });
  let code = readFileSync(outfile, "utf8");
  code = code.replace(/^(#!.*\r?\n)+/, "");
  writeFileSync(outfile, code);
  log(`plugin CLI → ${outfile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
