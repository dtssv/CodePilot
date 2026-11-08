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
// @yao-pkg/pkg downloads a ~40 MB pre-built Node binary on first run from
// https://github.com/yao-pkg/pkg-fetch/releases/download/v3.6/node-<ver>-<plat>-<arch>,
// then verifies it against an expected sha256. When that download 504s on a
// CI runner, pkg falls back to COMPILING Node from source — which takes 20+
// min, needs a C++ toolchain (absent on Windows runners), and never finishes
// within the job budget. pkg's own download has no retry. We pre-seed the
// cache (~/.pkg-cache/v3.6/fetched-<ver>-<plat>-<arch>) with curl, which has
// built-in retry+backoff that survives the transient 504s. A present, valid
// cache file makes pkg skip its download AND the source-build fallback.
const PKG_FETCH_TAG = "v3.6";
const NODE_BIN_VERSION = "v20.20.2";
// platform-arch as pkg-fetch names them (the name segment of the release asset).
const PKG_TARGET_MAP = {
  "node20-win-x64": "win-x64",
  "node20-win-arm64": "win-arm64",
  "node20-macos-x64": "macos-x64",
  "node20-macos-arm64": "macos-arm64",
  "node20-linux-x64": "linux-x64",
  "node20-linux-arm64": "linux-arm64",
};

/** Pre-seed pkg's Node-binary cache for the given targets, so pkg skips its
 *  own (504-prone) download and the source-build fallback. No-op if already
 *  cached or if the target is unknown (pkg will then handle it as before). */
function preseedPkgCache(targets) {
  const { existsSync, mkdirSync, readFileSync, renameSync } = require("node:fs");
  const { join } = require("node:path");
  const { homedir } = require("node:os");
  const { spawnSync } = require("node:child_process");
  const cacheDir = process.env.PKG_CACHE_PATH || join(homedir(), ".pkg-cache", PKG_FETCH_TAG);
  mkdirSync(cacheDir, { recursive: true });

  // expected-shas.json is shipped with @yao-pkg/pkg-fetch (a nested dep of
  // @yao-pkg/pkg, not hoisted to the top level). Resolve it from pkg's path.
  let expected = {};
  try {
    const pkgRequire = require("module").createRequire(
      require.resolve("@yao-pkg/pkg/package.json"),
    );
    const shasPath = pkgRequire.resolve(
      "@yao-pkg/pkg-fetch/lib-es5/expected-shas.json",
    );
    expected = JSON.parse(readFileSync(shasPath, "utf8"));
  } catch {
    /* fall back to no hash check */
  }

  const { createHash } = require("node:crypto");
  for (const target of targets) {
    const suffix = PKG_TARGET_MAP[target];
    if (!suffix) continue; // unknown target — let pkg handle it
    const name = `node-${NODE_BIN_VERSION}-${suffix}`;
    const local = join(cacheDir, `fetched-${NODE_BIN_VERSION}-${suffix}`);
    if (existsSync(local) && localValid(local, name, expected, createHash)) {
      log(`pkg cache hit: ${name}`);
      continue;
    }
    const url = `https://github.com/yao-pkg/pkg-fetch/releases/download/${PKG_FETCH_TAG}/${name}`;
    const tmp = `${local}.tmp`;
    // curl: --retry covers 504/502/connection errors with exponential backoff;
    // -C - resumes partial downloads; --fail turns a 504 into a non-zero exit.
    const r = spawnSync(
      "curl",
      [
        "--fail",
        "--retry",
        "5",
        "--retry-delay",
        "10",
        "--retry-all-errors",
        "-L",
        "-o",
        tmp,
        url,
      ],
      { stdio: "inherit" },
    );
    if (r.status !== 0 || !existsSync(tmp)) {
      log(`pkg cache pre-seed failed for ${name} (curl exit ${r.status}); pkg will retry`);
      continue;
    }
    if (localValid(tmp, name, expected, createHash)) {
      renameSync(tmp, local);
      log(`pkg cache seeded: ${name}`);
    } else {
      log(`pkg cache pre-seed hash mismatch for ${name}; pkg will retry`);
    }
  }
}

function localValid(file, name, expected, createHash) {
  const { existsSync, statSync, readFileSync } = require("node:fs");
  if (!existsSync(file)) return false;
  if (statSync(file).size < 1024) return false; // guard against error pages
  const want = expected[name];
  if (!want) return true; // no expected hash on record — accept
  const got = createHash("sha256").update(readFileSync(file)).digest("hex");
  return got === want;
}

export function runPkg(opts) {
  const { spawnSync } = require("node:child_process");
  const pkgCli = (() => {
    try {
      return require.resolve("@yao-pkg/pkg/lib-es5/bin.js");
    } catch {
      return require.resolve("@yao-pkg/pkg/bin/pkg.js");
    }
  })();

  // Pre-seed the Node-binary cache before invoking pkg, so a transient 504
  // on github.com/yao-pkg/pkg-fetch/releases doesn't trigger pkg's source-
  // build fallback (which never completes on CI). See preseedPkgCache above.
  preseedPkgCache(opts.targets);

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
  // pkg may still need to download if pre-seeding didn't cover a target.
  // A short per-attempt timeout kills a source build fast; retrying gives a
  // transient 504 time to clear. A successful download+package finishes well
  // under the timeout, and the result is cached in ~/.pkg-cache.
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
