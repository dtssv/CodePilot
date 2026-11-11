// Cross-process single-writer lease for a session's JSONL log.
//
// The same session id must never be appended by two processes at once (a
// standalone CLI + a daemon, or two daemons) — interleaved appends corrupt the
// append-only event log. There is no shared database to lock against, so we use
// an advisory lease file created with O_EXCL (atomic exclusive create, which
// works the same on POSIX and Windows).
//
// The lease file sits next to the JSONL as `<id>.lock` and holds the owner's
// identity: pid (for liveness) plus, when the owner is a daemon, its discovery
// url + token so a second opener can be redirected to attach as a subscriber
// instead of opening a competing writer. A crashed owner leaves a stale lock on
// disk; the next acquirer reclaims it after confirming the pid is dead — the
// same `process.kill(pid, 0)` liveness idiom the serve-discovery file uses.
//
// Design posture:
//  - Advisory, not mandatory: nothing stops a process that ignores the lease
//    from writing. Enforcement is that every Session acquires before loading.
//  - Fail-soft on the read side: a corrupt / unreadable lock is treated as
//    reclaimable (stale), never a hard error, so a bad lock can't wedge a
//    session forever.
//  - Reclaim is atomic-ish: we re-create with O_EXCL after unlinking the stale
//    file, so two racing reclaimers can't both win.

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "./session-utils.js";

/** Identity recorded in a session lock file. */
export interface SessionLockOwner {
  /** Owning process id, checked for liveness on acquire. */
  pid: number;
  /** When the lease was taken (epoch ms). */
  acquiredAt: number;
  /** Host surface that took the lease (daemon / cli / tui …), advisory. */
  host?: string;
  /** Daemon discovery url (ws://…, no token) so a second opener can attach to
   * the holder as a subscriber. Absent for non-daemon owners. */
  url?: string;
  /** Daemon auth token for the attach url. Absent when the owner is not a
   * discoverable daemon or runs with --no-auth. */
  token?: string;
}

/** A held writer lease. Call release() on dispose. */
export interface SessionLease {
  readonly sessionId: string;
  readonly path: string;
  readonly owner: SessionLockOwner;
  release(): void;
}

/** Error thrown when a live owner already holds the write lease. Carries the
 * holder's identity so a client can attach to the holding daemon as a
 * subscriber (or open read-only) instead of competing for the write path. */
export class SessionLockedError extends Error {
  readonly code = "SESSION_LOCKED";
  constructor(
    readonly sessionId: string,
    readonly owner: SessionLockOwner,
  ) {
    super(
      `session ${sessionId} is owned by pid ${owner.pid}` +
        (owner.url ? ` (daemon ${owner.url})` : ""),
    );
    this.name = "SessionLockedError";
  }
}

export function sessionLockPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.lock`);
}

/** Whether a pid is a live process. Mirrors the serve-discovery liveness check
 * so a dead owner's lease is reclaimable on every platform. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process → dead. EPERM: exists but not ours → alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read a lock file's owner, or null when absent/corrupt. A corrupt lock is
 * reported as null (treated as reclaimable) rather than throwing, so a damaged
 * lock can never permanently wedge a session. */
export function readSessionLock(id: string): SessionLockOwner | null {
  try {
    const raw = readFileSync(sessionLockPath(id), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionLockOwner>;
    if (typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      acquiredAt: typeof parsed.acquiredAt === "number" ? parsed.acquiredAt : 0,
      ...(parsed.host ? { host: parsed.host } : {}),
      ...(parsed.url ? { url: parsed.url } : {}),
      ...(parsed.token ? { token: parsed.token } : {}),
    };
  } catch {
    return null;
  }
}

/** The live owner of a session's write lease, or null when the session is free
 * (no lock, or the lock's owner is dead). Used by session/list to surface a
 * `liveWriter` flag and by destructive ops to refuse while a writer holds it. */
export function liveSessionLockOwner(id: string): SessionLockOwner | null {
  const owner = readSessionLock(id);
  if (!owner) return null;
  return pidAlive(owner.pid) ? owner : null;
}

function writeOwner(fd: number, owner: SessionLockOwner): void {
  writeSync(fd, JSON.stringify(owner));
}

/**
 * Acquire the single-writer lease for a session. Creates `<id>.lock` with
 * O_EXCL. If the lock already exists:
 *  - owner pid alive  → throws SessionLockedError (the holder's identity rides
 *    along so the caller can redirect / open read-only);
 *  - owner pid dead / lock corrupt → the stale lock is reclaimed (unlinked and
 *    re-created) and the lease is granted.
 *
 * Reclaim races are resolved by O_EXCL: after unlinking a stale lock we retry
 * the exclusive create; whichever process wins the create holds the lease, the
 * loser re-reads and either throws (now a live owner) or retries a reclaim.
 */
export function acquireSessionLock(
  id: string,
  identity: Omit<SessionLockOwner, "pid" | "acquiredAt"> & { pid?: number } = {},
): SessionLease {
  const path = sessionLockPath(id);
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const owner: SessionLockOwner = {
    pid: identity.pid ?? process.pid,
    acquiredAt: Date.now(),
    ...(identity.host ? { host: identity.host } : {}),
    ...(identity.url ? { url: identity.url } : {}),
    ...(identity.token ? { token: identity.token } : {}),
  };

  // Bounded retry so a reclaim race (unlink then re-create) converges.
  for (let attempt = 0; attempt < 5; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, "wx"); // O_CREAT | O_EXCL | O_WRONLY
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lock exists. Three cases:
      //  - owned by a live OTHER process → refuse (cross-process single-writer);
      //  - owned by THIS process → reentrant: same-process concurrency is the
      //    live-session registry's job, so grant a lease sharing the lock;
      //  - owner dead / corrupt → stale, reclaim and retry the exclusive create.
      const existing = liveSessionLockOwner(id);
      if (existing && existing.pid !== owner.pid) {
        throw new SessionLockedError(id, existing);
      }
      if (existing && existing.pid === owner.pid) {
        return {
          sessionId: id,
          path,
          owner: existing,
          // Reentrant handle: do NOT remove a lock this same-pid caller shares
          // with another in-process holder. The last live holder's dispose (or
          // process exit) leaves the file for reclaim.
          release(): void {},
        };
      }
      try {
        unlinkSync(path);
      } catch {
        /* someone else may have reclaimed it first — retry the create */
      }
      continue;
    }
    try {
      writeOwner(fd, owner);
    } finally {
      closeSync(fd);
    }
    return {
      sessionId: id,
      path,
      owner,
      release(): void {
        // Only remove the lock if we still own it — a reclaimer may have taken
        // over if this process was wrongly presumed dead.
        const current = readSessionLock(id);
        if (current && current.pid !== owner.pid) return;
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      },
    };
  }
  // Exhausted retries: a live owner kept winning the race.
  const existing = liveSessionLockOwner(id) ?? { pid: -1, acquiredAt: 0 };
  throw new SessionLockedError(id, existing);
}
