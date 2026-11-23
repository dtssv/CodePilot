/**
 * Spawn a shared daemon that is not a long-lived child of the calling app.
 *
 * Plain `spawn(..., { detached: true })` + `unref()` only creates a new session;
 * while the parent lives the daemon's PPID is still the IDE/Electron process, so
 * quitting VS Code / Desktop / etc. warns about "background processes".
 *
 * Unix: launch via `/bin/sh -c '… &'` so the shell exits immediately and the
 * daemon is reparented to init/launchd. Windows: `cmd /c start /b …`.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** POSIX single-quote escaping for `/bin/sh -c`. */
export function shellQuoteUnix(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Minimal cmd.exe quoting for `start /b`. */
export function shellQuoteWin(s: string): string {
  if (s.length === 0) return '""';
  if (!/[\s"&<>|^()%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export type OrphanSpawnOptions = Pick<SpawnOptions, "cwd" | "env">;

/** Pure argv for the short-lived launcher (shell / cmd). Exported for tests. */
export function buildOrphanLaunch(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  if (platform === "win32") {
    const line = [command, ...args].map(shellQuoteWin).join(" ");
    return {
      cmd: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `start "" /b ${line}`],
    };
  }
  const line = [command, ...args].map(shellQuoteUnix).join(" ");
  return { cmd: "/bin/sh", args: ["-c", `${line} >/dev/null 2>&1 &`] };
}

/**
 * Fire-and-forget daemon start. Returns the short-lived launcher process (shell
 * / cmd); callers must not treat it as the daemon — wait on serve.json instead.
 */
export function spawnOrphanDaemon(
  command: string,
  args: readonly string[],
  options?: OrphanSpawnOptions,
): ChildProcess {
  const launch = buildOrphanLaunch(command, args);
  const child = spawn(launch.cmd, launch.args, {
    cwd: options?.cwd,
    env: options?.env,
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  try {
    child.unref();
  } catch {
    /* ignore */
  }
  return child;
}
