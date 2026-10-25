/**
 * Interactive PTY host for the web workspace terminal.
 *
 * Spawns real shells via `node-pty` so Tab completion / readline work like a
 * local terminal. One connection owns its terminals; dispose kills them all.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, delimiter } from "node:path";

export type HostPlatform = "darwin" | "linux" | "win32" | "other";

export interface TerminalShellInfo {
  id: string;
  path: string;
  label: string;
}

export interface TerminalShellsResult {
  platform: HostPlatform;
  shells: TerminalShellInfo[];
}

export interface TerminalOpenOpts {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}

export interface TerminalHandle {
  id: string;
  shell: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

type PtyModule = typeof import("node-pty");

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

async function loadPty(): Promise<PtyModule> {
  if (ptyModule !== undefined) {
    if (!ptyModule) throw new Error("node-pty is not available on this host");
    return ptyModule;
  }
  try {
    ensureDarwinSpawnHelperExecutable();
    ptyModule = await import("node-pty");
    return ptyModule;
  } catch (err) {
    ptyModule = null;
    throw new Error(
      `Interactive terminal requires node-pty (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

export function hostPlatform(): HostPlatform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win32";
  return "other";
}

function whichOnPath(name: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate =
      process.platform === "win32" ? `${dir}\\${name}` : `${dir}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Probe shells for the host OS (Windows → PowerShell/cmd; Unix → $SHELL/zsh/bash). */
export function listAvailableShells(): TerminalShellInfo[] {
  return listTerminalShells().shells;
}

/** Host platform + shells available for the interactive terminal picker. */
export function listTerminalShells(): TerminalShellsResult {
  const platform = hostPlatform();
  const out: TerminalShellInfo[] = [];
  const seen = new Set<string>();
  const add = (id: string, path: string, label: string): void => {
    if (!path || seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    out.push({ id, path, label });
  };

  if (platform === "win32") {
    const pwsh = whichOnPath("pwsh.exe");
    if (pwsh) add("pwsh", pwsh, "PowerShell 7");
    const ps =
      whichOnPath("powershell.exe") ??
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    add("powershell", ps, "Windows PowerShell");
    const cmd = whichOnPath("cmd.exe") ?? "C:\\Windows\\System32\\cmd.exe";
    add("cmd", cmd, "Command Prompt");
    return { platform, shells: out };
  }

  // macOS / Linux / other Unix: prefer login shell, then common interpreters.
  const envShell = process.env.SHELL?.trim();
  if (envShell) {
    const base = envShell.split("/").pop() ?? "shell";
    add("default", envShell, `${base} (default)`);
  }

  if (platform === "darwin") {
    add("zsh", "/bin/zsh", "zsh");
    add("bash", "/bin/bash", "bash");
    add("sh", "/bin/sh", "sh");
  } else {
    // Linux and others: prefer bash, then zsh/sh; also PATH copies (e.g. /usr/bin).
    add("bash", "/bin/bash", "bash");
    add("bash-usr", "/usr/bin/bash", "bash");
    add("zsh", "/bin/zsh", "zsh");
    add("zsh-usr", "/usr/bin/zsh", "zsh");
    add("sh", "/bin/sh", "sh");
    add("sh-usr", "/usr/bin/sh", "sh");
    const fish = whichOnPath("fish");
    if (fish) add("fish", fish, "fish");
  }

  for (const name of ["zsh", "bash", "sh"] as const) {
    const hit = whichOnPath(name);
    if (hit) add(`${name}-path`, hit, name);
  }

  return { platform, shells: out };
}

function resolveShellPath(requested?: string): string {
  const shells = listAvailableShells();
  if (requested?.trim()) {
    const hit = shells.find(
      (s) => s.id === requested || s.path === requested || s.label === requested,
    );
    if (hit) return hit.path;
    if (existsSync(requested)) return requested;
    throw new Error(`Shell not found: ${requested}`);
  }
  if (shells[0]) return shells[0].path;
  throw new Error("No shell available on this host");
}

function shellArgs(shellPath: string): string[] {
  const base = shellPath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (process.platform === "win32") {
    if (base.includes("powershell") || base === "pwsh.exe") {
      return ["-NoLogo"];
    }
    return [];
  }
  // Interactive login so completion / rc files work.
  if (base === "zsh") return ["-i"];
  if (base === "bash") return ["-il"];
  return ["-i"];
}

/** Per-connection PTY registry. */
export class TerminalHost {
  private readonly terminals = new Map<
    string,
    { pty: import("node-pty").IPty; shell: string }
  >();

  async open(opts: TerminalOpenOpts): Promise<TerminalHandle> {
    const pty = await loadPty();
    const shell = resolveShellPath(opts.shell);
    const cwd = opts.cwd?.trim() || process.cwd();
    const cols = Math.max(20, opts.cols ?? 80);
    const rows = Math.max(5, opts.rows ?? 24);
    const id = `term_${randomUUID().slice(0, 8)}`;

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    env.HOME = process.env.HOME ?? homedir();
    if (opts.env) Object.assign(env, opts.env);
    // Avoid leaking serve token into child env if present under odd keys.
    delete env.CODEPILOT_SERVE_TOKEN;

    // Register id before spawn so early onData can be correlated by callers
    // that assign their box after open() resolves — buffer briefly instead.
    const early: string[] = [];
    let ready = false;

    let child: import("node-pty").IPty;
    try {
      child = pty.spawn(shell, shellArgs(shell), {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env,
      });
    } catch (err) {
      throw new Error(
        `Failed to spawn shell ${shell}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.terminals.set(id, { pty: child, shell });
    child.onData((data) => {
      if (!ready) {
        early.push(data);
        return;
      }
      try {
        opts.onData(data);
      } catch {
        /* ignore UI notify failures */
      }
    });
    child.onExit(({ exitCode }) => {
      this.terminals.delete(id);
      try {
        opts.onExit(exitCode ?? 0);
      } catch {
        /* ignore */
      }
    });

    // Defer ready until after the caller's await assigns box.id — microtask
    // is enough because open()'s return runs before the next tick of pty data
    // that was buffered; flush early chunks now.
    queueMicrotask(() => {
      ready = true;
      for (const chunk of early) {
        try {
          opts.onData(chunk);
        } catch {
          /* ignore */
        }
      }
      early.length = 0;
    });

    return {
      id,
      shell,
      write: (data: string) => {
        const t = this.terminals.get(id);
        if (!t) throw new Error(`Terminal closed: ${id}`);
        t.pty.write(data);
      },
      resize: (c: number, r: number) => {
        const t = this.terminals.get(id);
        if (!t) return;
        try {
          t.pty.resize(Math.max(20, c), Math.max(5, r));
        } catch {
          /* ignore */
        }
      },
      kill: () => {
        const t = this.terminals.get(id);
        if (!t) return;
        this.terminals.delete(id);
        try {
          t.pty.kill();
        } catch {
          /* ignore */
        }
      },
    };
  }

  write(terminalId: string, data: string): void {
    const t = this.terminals.get(terminalId);
    if (!t) throw new Error(`Unknown terminal: ${terminalId}`);
    t.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    try {
      t.pty.resize(Math.max(20, cols), Math.max(5, rows));
    } catch {
      /* ignore */
    }
  }

  close(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    this.terminals.delete(terminalId);
    try {
      t.pty.kill();
    } catch {
      /* ignore */
    }
  }

  disposeAll(): void {
    for (const [id, t] of this.terminals) {
      this.terminals.delete(id);
      try {
        t.pty.kill();
      } catch {
        /* ignore */
      }
    }
  }
}
