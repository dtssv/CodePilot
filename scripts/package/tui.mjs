#!/usr/bin/env node
/**
 * Package `codepilot-tui`: self-contained binaries (via Bun) + npm .tgz.
 *
 * The TUI is ESM and Ink/yoga use top-level await, so it cannot be bundled to
 * CJS for @yao-pkg/pkg (which also can't reliably run an ESM entry from its
 * snapshot FS). Bun's `--compile` handles ESM + top-level await + native addons
 * natively, so we use it here — the same approach opencode uses for the same
 * reason. Native addons (better-sqlite3) are embedded host-arch; cross-compiled
 * targets carry the host arch but degrade fail-soft (the session index is
 * optional). CI builds each target on its own OS/arch runner for correctness.
 */

import { chmodSync, existsSync, renameSync } from "node:fs";
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

const outDir = join(RELEASE_ROOT, "tui");
const bundleScript = join(REPO_ROOT, "scripts", "package", "bundle-bun.mjs");

/** Locate the `bun` executable (PATH, or the default user install). */
function findBun() {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return "bun";
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const fallback = join(home, ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  if (existsSync(fallback)) return fallback;
  fail(
    "bun not found — install it (https://bun.sh) to package the TUI.\n" +
      "  curl -fsSL https://bun.sh/install | bash",
  );
  return "bun";
}

async function main() {
  ensureDir(outDir);
  // tui imports @codepilot/core and @codepilot/protocol — build them first
  // so their dist/ exists when tsc resolves types on a clean checkout.
  pnpm(["--filter", "@codepilot/core", "build"]);
  pnpm(["--filter", "@codepilot/protocol", "build"]);
  pnpm(["--filter", "@codepilot/tui", "build"]);
  const entry = join(REPO_ROOT, "apps", "tui", "dist", "cli.js");
  if (!existsSync(entry)) fail("apps/tui/dist/cli.js missing");

  const bun = findBun();

  for (const t of resolveTargets()) {
    const suffix = t.binarySuffix.replace(/\.exe$/, "");
    const wanted = join(outDir, `codepilot-tui-${t.binarySuffix}`);
    // Bun appends .exe for windows targets; build to a base path then fix up.
    const base = join(outDir, `codepilot-tui-${suffix}`);
    const bunTarget = bunTargetFor(t.family, t.arch);
    const r = spawnSync(bun, [bundleScript, entry, base, bunTarget], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (r.status !== 0) {
      log(`skip ${bunTarget}: bun compile exited ${r.status}`);
      continue;
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
