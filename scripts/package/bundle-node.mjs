/**
 * esbuild a Node entry into a single CJS file suitable for @yao-pkg/pkg.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { ensureDir, log } from "./_util.mjs";

const require = createRequire(import.meta.url);

/**
 * @param {{ entry: string, outfile: string, banner?: string }} opts
 */
export async function bundleNodeEntry(opts) {
  const esbuild = await import("esbuild");
  ensureDir(dirname(opts.outfile));
  log(`esbuild ${opts.entry} → ${opts.outfile}`);
  // The core/protocol dist is ESM and uses `import.meta.url` (createRequire,
  // fileURLToPath). Bundling to CJS for pkg turns that into `undefined`, so we
  // shim it to the current file via __filename. `--define` rewrites every
  // `import.meta.url` occurrence to our banner-provided constant.
  const importMetaShim =
    "var __cp_import_meta_url = require('url').pathToFileURL(__filename).href;";

  // Read the real core version so version-probe requires can be inlined below.
  let coreVersion = "0.0.0";
  try {
    coreVersion =
      JSON.parse(readFileSync(require.resolve("@codepilot/core/package.json"), "utf8")).version ??
      coreVersion;
  } catch {
    /* keep default */
  }
  const pkgShim = `var __cp_pkg = ${JSON.stringify({ name: "@codepilot/core", version: coreVersion })};`;

  await esbuild.build({
    entryPoints: [opts.entry],
    outfile: opts.outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: false,
    define: {
      "import.meta.url": "__cp_import_meta_url",
    },
 // Keep native / electron-unrelated packages that pkg ships or that break when bundled.
    external: [
      "electron",
      "fsevents",
 // ink pulls optional native; leave resolved from node_modules inside pkg.
    ],
    banner: {
      js: opts.banner ? `${importMetaShim}\n${pkgShim}\n${opts.banner}` : `${importMetaShim}\n${pkgShim}`,
    },
    logLevel: "warning",
  });
 // Strip shebang(s) — pkg's babel parser rejects `#!` in the entry.
  let code = readFileSync(opts.outfile, "utf8");
  code = code.replace(/^(#!.*\r?\n)+/, "");
  // `createRequire(...)("../package.json")` and `require("@codepilot/core/package.json")`
  // are dynamic requires esbuild can't inline; under pkg's /snapshot FS they throw.
  // Rewrite those version-probe calls to the banner-injected literal.
  code = code.replace(
    /\b(?:require\d*|req)\s*\(\s*["'](?:\.\.\/package\.json|@codepilot\/core\/package\.json)["']\s*\)/g,
    "__cp_pkg",
  );
  writeFileSync(opts.outfile, code);
}

/**
 * Run @yao-pkg/pkg on a CJS entry.
 * @param {{ entry: string, targets: string[], outputPath: string, assets?: string[] }} opts
 */
export function runPkg(opts) {
  const { spawnSync } = require("node:child_process");
  const pkgCli = (() => {
    try {
      return require.resolve("@yao-pkg/pkg/lib-es5/bin.js");
    } catch {
      return require.resolve("@yao-pkg/pkg/bin/pkg.js");
    }
  })();

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
  // pkg downloads a ~40 MB pre-built Node binary on first run; a transient
  // download failure can be cleared by retry. A short per-attempt timeout
  // prevents a source-build fallback from burning the whole job budget.
  // Requires a target (node22-*) that pkg-fetch publishes prebuilt binaries
  // for — node20 binaries don't exist, so pkg would fall back to compiling
  // Node from source, which fails on runners without a C++ toolchain.
  const MAX_ATTEMPTS = 3;
  const ATTEMPT_TIMEOUT_MS = 300_000; // 5 min
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = spawnSync(process.execPath, args, { stdio: "inherit", timeout: ATTEMPT_TIMEOUT_MS });
    if (r.error && r.error.code === "ETIMEDOUT") {
      lastErr = `pkg timed out after ${ATTEMPT_TIMEOUT_MS / 1000}s (stalled download or source build)`;
    } else if (r.error) {
      lastErr = `pkg spawn error: ${r.error.message}`;
    } else if (r.status !== 0) {
      lastErr = `pkg failed with exit ${r.status}`;
    } else {
      return; // success
    }
    if (attempt < MAX_ATTEMPTS) {
      log(`pkg attempt ${attempt}/${MAX_ATTEMPTS} failed (${lastErr}); retrying…`);
    }
  }
  throw new Error(`${lastErr} (after ${MAX_ATTEMPTS} attempts)`);
}
