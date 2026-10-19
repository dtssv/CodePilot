// Discovery file for a running `codepilot serve --web`. Written on startup,
// removed on exit, so that `codepilot chat` / `codepilot-tui` can detect a
// live server and attach to it (follow the same sessions) instead of silently
// starting a second, conflicting in-process engine.
//
// Only loopback servers are advertised — we never want a terminal to
// auto-connect to a remote host it wasn't told about.

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
}

function serveInfoPath(): string {
  return join(homedir(), ".codepilot", "serve.json");
}

/** Write the discovery file. Best-effort; never throws. */
export async function writeServeInfo(info: ServeInfo): Promise<void> {
  try {
    const path = serveInfoPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(info, null, 2), "utf-8");
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
export async function readLiveServeInfo(): Promise<ServeInfo | null> {
  let info: ServeInfo;
  try {
    info = JSON.parse(await readFile(serveInfoPath(), "utf-8")) as ServeInfo;
  } catch {
    return null;
  }
  if (!info?.url || typeof info.pid !== "number") return null;
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
