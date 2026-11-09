#!/usr/bin/env node
/**
 * Package the unified `codepilot` binary:
 * - a single self-contained executable (via Bun `--compile`) that is both the
 *   interactive TUI and the command surface (`codepilot web` / `serve` / `run`
 *   / …). The web SPA is embedded in the binary (no separate web asset).
 * - npm .tgz for @codepilot/core and @codepilot/protocol.
 *
 * Bun is required: the entry is the TUI (ESM, Ink/yoga use top-level await), so
 * @yao-pkg/pkg cannot bundle it. Bun handles ESM + top-level await + native
 * addons. Native addons (better-sqlite3) are embedded host-arch; cross-compiled
 * targets carry the host arch but degrade fail-soft (the session index is
 * optional). CI builds each target on its own OS/arch runner for correctness.
 */

import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  CACHE_ROOT,
  RELEASE_ROOT,
  REPO_ROOT,
  bunTargetFor,
  ensureDir,
  fail,
  log,
  pnpm,
  resolveTargets,
  run,
} from "./_util.mjs";

const outDir = join(RELEASE_ROOT, "cli");
const bundleScript = join(REPO_ROOT, "scripts", "package", "bundle-bun.mjs");
const genWebVfs = join(REPO_ROOT, "scripts", "package", "gen-web-vfs.mjs");

/** Locate the `bun` executable (PATH, or the default user install). */
function findBun() {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return "bun";
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const fallback = join(home, ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  if (existsSync(fallback)) return fallback;
  fail(
    "bun not found — install it (https://bun.sh) to package the binary.\n" +
      "  curl -fsSL https://bun.sh/install | bash",
  );
  return "bun";
}

async function buildWeb() {
  pnpm(["--filter", "@codepilot/web", "build"]);
  const webDist = join(REPO_ROOT, "apps", "web", "dist");
  if (!existsSync(join(webDist, "index.html"))) fail("web dist missing after build");
}

const webVfsDist = join(
  REPO_ROOT,
  "packages",
  "protocol",
  "dist",
  "web-vfs.generated.js",
);

/** Generate the web VFS so the SPA bytes are embedded in the compiled binary. */
function embedWeb() {
  run("node", [genWebVfs], { cwd: REPO_ROOT });
}

/**
 * Restore the empty VFS in dist. The populated VFS uses `with { type: "file" }`,
 * which only Bun's compile understands — leaving it in dist breaks the IDE
 * plugin's esbuild→CJS bundle. The committed source VFS is empty, so emit that
 * shape back (tsc -b is incremental and won't re-emit an unchanged source).
 */
function restoreEmptyWebVfs() {
  if (!existsSync(webVfsDist)) return;
  const empty =
    "// AUTO-GENERATED — do not edit by hand.\n" +
    "// Restored to empty by scripts/package/cli.mjs after the Bun compile.\n" +
    "export const webVfs = {};\n";
  writeFileSync(webVfsDist, empty);
}

function packageBinaries() {
  ensureDir(outDir);
  const bun = findBun();
  for (const t of resolveTargets()) {
    const suffix = t.binarySuffix.replace(/\.exe$/, "");
    const wanted = join(outDir, `codepilot-${t.binarySuffix}`);
    // Bun appends .exe for windows targets; build to a base path then fix up.
    const base = join(outDir, `codepilot-${suffix}`);
    const entry = join(REPO_ROOT, "apps", "tui", "dist", "cli.js");
    if (!existsSync(entry)) fail("apps/tui/dist/cli.js missing");
    const bunTarget = bunTargetFor(t.family, t.arch);
    const r = spawnSync(bun, [bundleScript, entry, base, bunTarget], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (r.status !== 0) {
      fail(`bun compile ${bunTarget}: exited ${r.status}`);
    }
    if (t.family === "win") {
      const exe = `${base}.exe`;
      if (existsSync(exe) && exe !== wanted) renameSync(exe, wanted);
    } else if (existsSync(base)) {
      try {
        chmodSync(base, 0o755);
      } catch {
        /* ignore */
      }
    }
    log(`binary ready: ${wanted}`);
  }
}

function packageNpm() {
  const npmDir = ensureDir(join(outDir, "npm"));
  const dirs = {
    "@codepilot/core": join(REPO_ROOT, "packages", "core"),
    "@codepilot/protocol": join(REPO_ROOT, "packages", "protocol"),
    "@codepilot/tui": join(REPO_ROOT, "apps", "tui"),
  };
  for (const [name, cwd] of Object.entries(dirs)) {
    log(`pack ${name}`);
    run("corepack", ["pnpm", "pack", "--pack-destination", npmDir], { cwd });
  }
  log(`npm packs → ${npmDir}`);
}

async function main() {
  ensureDir(outDir);
  // Build core+protocol first — web (vite import), gen-web-vfs, and the TUI
  // entry all resolve @codepilot/core and @codepilot/protocol from dist/.
  pnpm(["--filter", "@codepilot/core", "build"]);
  pnpm(["--filter", "@codepilot/protocol", "build"]);
  await buildWeb();
  pnpm(["--filter", "@codepilot/tui", "build"]);
  try {
    // Embed the web SPA AFTER tsc (so the committed VFS stays empty and
    // type-checks) and BEFORE the Bun compile (which bundles from dist).
    embedWeb();
    packageBinaries();
  } finally {
    // The populated VFS must not linger in dist — it breaks the IDE plugin's
    // esbuild→CJS bundle (esbuild rejects `with { type: "file" }`).
    restoreEmptyWebVfs();
  }
  packageNpm();
  log(`unified binary release → ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
