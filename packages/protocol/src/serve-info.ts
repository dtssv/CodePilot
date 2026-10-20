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
