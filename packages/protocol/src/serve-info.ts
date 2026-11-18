// Discovery file for a running `codepilot serve --web`. Written on
// startup, removed on exit, so `codepilot chat` / `codepilot-tui` can
// detect a live server and attach instead of starting a conflicting
// in-process engine. Only loopback servers are advertised.

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ServeInfo {
 /** ws:// URL (without token). */
  url: string;
 /** Auth token (may be empty when --no-auth). */
  token: string;
 /** Server process id, used to check liveness. */
  pid: number;
 /** Host the server bound to. */
  host: string;
 /** Port. */
  port: number;
 /** When it started (ISO). */
  startedAt: string;
 /** Optional package / CLI version string. */
  version?: string;
}

function serveInfoPath(): string {
  return join(homedir(), ".codepilot", "serve.json");
}

/** Alias path from the shared-daemon plan (`server.json`). */
function serverJsonPath(): string {
  return join(homedir(), ".codepilot", "server.json");
}

/** Write the discovery file. Best-effort; never throws. */
export async function writeServeInfo(info: ServeInfo): Promise<void> {
  try {
    const dir = join(homedir(), ".codepilot");
    await mkdir(dir, { recursive: true });
    const body = JSON.stringify(info, null, 2);
    await writeFile(serveInfoPath(), body, "utf-8");
    // Plan alias so plugins looking for server.json find the same daemon.
    await writeFile(serverJsonPath(), body, "utf-8");
  } catch {
 /* best-effort */
  }
}

/** Remove the discovery file (on server shutdown). Best-effort. */
export async function clearServeInfo(): Promise<void> {
  try {
    await unlink(serveInfoPath());
  } catch {
 /* already gone */
  }
  try {
    await unlink(serverJsonPath());
  } catch {
 /* already gone */
  }
}

/** WebSocket URL including token for attaching clients. */
export function serveInfoWsUrl(info: ServeInfo): string {
  const base = info.url.replace(/\/$/, "");
  if (!info.token) return base;
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(info.token)}`;
}

/** Whether a pid is a live process. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the discovery file and return it only when it describes a LIVE,
 * loopback server. Returns null otherwise (no file, dead pid, non-loopback,
 * or malformed). Callers treat null as "no server — run in-process".
 */
async function readServeInfoFile(): Promise<ServeInfo | null> {
  for (const path of [serveInfoPath(), serverJsonPath()]) {
    try {
      const info = JSON.parse(await readFile(path, "utf-8")) as ServeInfo;
      if (info?.url && typeof info.pid === "number") return info;
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function readLiveServeInfo(): Promise<ServeInfo | null> {
  const info = await readServeInfoFile();
  if (!info) return null;
 // Only auto-attach to loopback servers.
  const loopback = info.host === "127.0.0.1" || info.host === "localhost" || info.host === "::1";
  if (!loopback) return null;
  if (!pidAlive(info.pid)) {
 // Stale file from a crashed server — clean it up.
    await clearServeInfo();
    return null;
  }
  return info;
}

/** Default path of the installed unified CLI binary. */
export function installedDaemonBinaryPath(): string {
  const name = process.platform === "win32" ? "codepilot.exe" : "codepilot";
  return join(homedir(), ".codepilot", "bin", name);
}

/**
 * True when `~/.codepilot/bin/codepilot` is newer than the running daemon's
 * `startedAt` (install/upgrade replaced the binary under a live process).
 * Callers should kill + respawn so the new build is what clients talk to.
 */
export async function isDaemonBinaryStale(
  info: ServeInfo,
  binaryPath: string = installedDaemonBinaryPath(),
): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    const st = await stat(binaryPath);
    const started = Date.parse(info.startedAt);
    if (!Number.isFinite(started)) return false;
    // 2s skew so a daemon we just spawned is never treated as stale.
    return st.mtimeMs > started + 2_000;
  } catch {
    return false;
  }
}
