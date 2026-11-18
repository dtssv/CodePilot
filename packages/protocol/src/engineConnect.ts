/**
 * Discover a live shared daemon (`~/.codepilot/serve.json` / `server.json`) or
 * spawn one and wait until it advertises itself, so multiple clients (VS Code /
 * IDEA / TUI) share one local protocol server.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createConnection } from "node:net";

import {
  readLiveServeInfo,
  serveInfoWsUrl,
  isDaemonBinaryStale,
  clearServeInfo,
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
 * its lockfile. Do not kill `owned` on one client leaving — other UIs may share
 * it; the daemon exits on idle grace after the last client leaves.
 */
export async function discoverOrSpawnDaemon(
  opts: DiscoverOrSpawnOptions,
): Promise<DiscoverOrSpawnResult> {
  const existing = await readLiveServeInfo();
  if (existing) {
    // Install/upgrade replaced ~/.codepilot/bin/codepilot under a live daemon —
    // recycle so clients pick up the new binary (schema, idle-exit, …).
    if (await isDaemonBinaryStale(existing)) {
      try {
        process.kill(existing.pid);
      } catch {
        /* already gone */
      }
      await clearServeInfo();
      const port = portFromArgs(opts.args);
      if (port !== null) {
        for (let i = 0; i < 40; i++) {
          if (!(await portInUse(port))) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    } else {
      return { info: existing, owned: null };
    }
  }

  // Port held but no (loopback) serve.json: a live daemon is almost certainly
  // there but momentarily undiscoverable (e.g. its lockfile was cleared by a
  // racing reader, or it advertises a non-loopback host). Spawning now would
  // hit EADDRINUSE and strand us in the wait-for-lockfile timeout. Wait for the
  // daemon's re-assert to republish serve.json instead of binding again.
  const port = portFromArgs(opts.args);
  if (port !== null && (await portInUse(port))) {
    const republished = await waitForLiveServeInfo(opts.waitMs ?? 15_000);
    if (republished) {
      if (!(await isDaemonBinaryStale(republished))) {
        return { info: republished, owned: null };
      }
      try {
        process.kill(republished.pid);
      } catch {
        /* ignore */
      }
      await clearServeInfo();
      for (let i = 0; i < 40; i++) {
        if (!(await portInUse(port))) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  // Default spawner: `detached: true` makes the child a new session leader via
  // setsid(2) on Unix (Node/libuv) so it survives TUI/Desktop/IDE parent exit.
  // Do not wrap with the `setsid` CLI — it is Linux-only (ENOENT on macOS).
  // Tests pass a custom `spawner` and keep the plain spawn path.
  const defaultSpawner: Spawner = (command, args, options) =>
    spawn(command, args, { ...options, detached: true });
  const spawner = opts.spawner ?? defaultSpawner;
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
  // Detach so one client exiting does not take the shared daemon with it
  // while other UIs may still be connected. Idle grace stops it later.
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
