/**
 * esbuild a Node entry into a single CJS file suitable for @yao-pkg/pkg.
 */

import * as esbuild from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { ensureDir, log } from "./_util.mjs";

const require = createRequire(import.meta.url);

/**
 * @param {{ entry: string, outfile: string, banner?: string }} opts
 */
export async function bundleNodeEntry(opts) {
  ensureDir(dirname(opts.outfile));
  log(`esbuild ${opts.entry} → ${opts.outfile}`);
  await esbuild.build({
    entryPoints: [opts.entry],
    outfile: opts.outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: false,
 // Keep native / electron-unrelated packages that pkg ships or that break when bundled.
    external: [
      "electron",
      "fsevents",
 // ink pulls optional native; leave resolved from node_modules inside pkg.
    ],
    ...(opts.banner ? { banner: { js: opts.banner } } : {}),
    logLevel: "warning",
  });
 // Strip shebang(s) — pkg's babel parser rejects `#!` in the entry.
  let code = readFileSync(opts.outfile, "utf8");
  code = code.replace(/^(#!.*\r?\n)+/, "");
  writeFileSync(opts.outfile, code);
}

/**
 * Run @yao-pkg/pkg on a CJS entry.
 * @param {{ entry: string, targets: string[], outputPath: string, assets?: string[] }} opts
 */
export function runPkg(opts) {
  const { spawnSync } = require("node:child_process");
  const pkgCli = ( => {
    try {
      return require.resolve("@yao-pkg/pkg/lib-es5/bin.js");
    } catch {
      return require.resolve("@yao-pkg/pkg/bin/pkg.js");
    }
  });

  const args = [
    pkgCli,
    opts.entry,
    "--targets",
    opts.targets.join(","),
    "--output",
    opts.outputPath,
 // Avoid bytecode compile issues with large bundles.
    "--no-bytecode",
    "--public",
  ];
  if (opts.assets?.length) {
    for (const a of opts.assets) {
      args.push("--assets", a);
    }
  }
  log(`pkg ${opts.targets.join(",")} → ${opts.outputPath}`);
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`pkg failed with exit ${r.status}`);
  }
}
