/**
 * Discover a live shared daemon (`~/.codepilot/serve.json` /
 * `server.json`) or spawn one and wait until it advertises itself.
 *
 * Used by VS Code / IDEA / optional TUI attach so multiple clients share one
 * local protocol server instead of each spawning a private stdio serve.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createConnection } from "node:net";

import {
  readLiveServeInfo,
  serveInfoWsUrl,
  type ServeInfo,
} from "./serve-info.js";

export { readLiveServeInfo, serveInfoWsUrl, type ServeInfo };

export type Spawner = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The `--port N` value in a serve arg list, if present. */
function portFromArgs(args: readonly string[]): number | null {
  const i = args.indexOf("--port");
  if (i >= 0 && i + 1 < args.length) {
    const p = Number(args[i + 1]);
    if (Number.isInteger(p) && p > 0) return p;
  }
  return null;
}

/** Whether something is accepting TCP connections on loopback:port. */
function portInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (inUse: boolean): void => {
      socket.destroy();
      resolve(inUse);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

/** Poll until a live serve lockfile appears, or timeout. */
export async function waitForLiveServeInfo(
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<ServeInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await readLiveServeInfo();
    if (info) return info;
    await sleep(intervalMs);
  }
  return readLiveServeInfo();
}

export interface DiscoverOrSpawnOptions {
  /** Executable (e.g. `node` or `codepilot`). */
  command: string;
  /** Args that start a daemon, typically `["serve", "--daemon"]` or `[cli.cjs, "serve", "--daemon"]`. */
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for serve.json after spawn. Default 15s. */
  waitMs?: number;
  spawner?: Spawner;
}

export interface DiscoverOrSpawnResult {
  info: ServeInfo;
  /** Child we spawned (null when we attached to an existing daemon). */
  owned: ChildProcess | null;
}

/**
 * Prefer an already-running loopback daemon; otherwise spawn one and wait for
 * its lockfile. The caller owns disconnect semantics — do not kill `owned`
 * just because one client is leaving (other UIs may share it); the daemon
 * exits on idle grace after the last WebSocket client leaves.
 */
export async function discoverOrSpawnDaemon(
  opts: DiscoverOrSpawnOptions,
): Promise<DiscoverOrSpawnResult> {
  const existing = await readLiveServeInfo();
  if (existing) return { info: existing, owned: null };

  // Port held but no (loopback) serve.json: a live daemon is almost certainly
  // there but momentarily undiscoverable (e.g. its lockfile was cleared by a
  // racing reader, or it advertises a non-loopback host). Spawning now would
  // hit EADDRINUSE and strand us in the wait-for-lockfile timeout. Wait for the
  // daemon's re-assert to republish serve.json instead of binding again.
  const port = portFromArgs(opts.args);
  if (port !== null && (await portInUse(port))) {
    const republished = await waitForLiveServeInfo(opts.waitMs ?? 15_000);
    if (republished) return { info: republished, owned: null };
  }

  const spawner = opts.spawner ?? spawn;
  const child = spawner(opts.command, [...opts.args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  // Drain the piped stderr so a chatty daemon can never block on a full pipe
  // whose reader (this parent) outlives the spawn. We don't forward it.
  try {
    child.stderr?.resume();
  } catch {
    /* ignore */
  }
  // Detach so the extension host exit does not take the shared daemon with it
  // while other clients may still be connected. Idle grace stops it later.
  try {
    child.unref();
  } catch {
    /* ignore */
  }

  const info = await waitForLiveServeInfo(opts.waitMs ?? 15_000);
  if (!info) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    throw new Error(
      `CodePilot daemon did not publish ~/.codepilot/serve.json after starting \`${opts.command} ${opts.args.join(" ")}\``,
    );
  }
  return { info, owned: child };
}
