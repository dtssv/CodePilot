/**
 * Thin node-pty loader for interactive background bash jobs (session +
 * write_stdin). Applies the same darwin spawn-helper fix as the protocol
 * terminal host. Fail-soft: callers fall back to pipe spawn when node-pty is
 * unavailable.
 */

import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type PtyModule = typeof import("node-pty");
export type IPty = import("node-pty").IPty;

let ptyModule: PtyModule | null | undefined;
let spawnHelperFixed = false;

/**
 * node-pty@1.1.0 ships macOS `spawn-helper` without the execute bit; pnpm
 * preserves that, so every spawn throws `posix_spawnp failed`. Fix at runtime.
 */
function ensureDarwinSpawnHelperExecutable(): void {
  if (spawnHelperFixed || process.platform !== "darwin") {
    spawnHelperFixed = true;
    return;
  }
  spawnHelperFixed = true;
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("node-pty/package.json");
    const root = dirname(pkgJson);
    for (const rel of [
      "build/Release/spawn-helper",
      "build/Debug/spawn-helper",
      `prebuilds/darwin-${process.arch}/spawn-helper`,
      "prebuilds/darwin-arm64/spawn-helper",
      "prebuilds/darwin-x64/spawn-helper",
    ]) {
      const helper = join(root, rel);
      if (!existsSync(helper)) continue;
      try {
        chmodSync(helper, 0o755);
      } catch {
        /* ignore — may already be executable or read-only */
      }
    }
  } catch {
    /* resolve failed — spawn will surface a clearer error */
  }
}

/** Load node-pty once; `null` means unavailable for this process. */
export async function loadPty(): Promise<PtyModule | null> {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ensureDarwinSpawnHelperExecutable();
    ptyModule = await import("node-pty");
    return ptyModule;
  } catch {
    ptyModule = null;
    return null;
  }
}

export interface SpawnPtyOpts {
  shell: string;
  shellArgs: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

/** Spawn `shell shellArgs… command` under a PTY, or `null` if node-pty cannot. */
export async function spawnPtyCommand(opts: SpawnPtyOpts): Promise<IPty | null> {
  const pty = await loadPty();
  if (!pty) return null;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = env.TERM || "xterm-256color";
  env.COLORTERM = env.COLORTERM || "truecolor";
  try {
    return pty.spawn(opts.shell, [...opts.shellArgs, opts.command], {
      name: "xterm-256color",
      cols: Math.max(20, opts.cols ?? 80),
      rows: Math.max(5, opts.rows ?? 24),
      cwd: opts.cwd,
      env,
    });
  } catch {
    return null;
  }
}
