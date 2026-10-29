// File-observation store: read-before-write + staleness (CAS) guard.
//
// Why this exists
// ---------------
// A long-running agent edits files it "remembers" reading. Two failure modes
// cause silent corruption / hallucinated edits:
//   1. Editing a file the agent never actually read this session (it is
//      reasoning from memory of a similar file, or from a folded stub).
//   2. Editing a file that changed on disk *after* the agent read it (another
//      process, a formatter, the user) — the edit is based on stale content.
//
// This store records a lightweight observation (mtime + size) every time a
// file is successfully read, and lets write-tools assert, before mutating:
//   - the path was observed this session (read-before-write), and
//   - the on-disk mtime/size still match what was observed (no stale write).
//
// It is deliberately coarse (mtime+size, not a content hash): cheap, no extra
// I/O beyond a stat the tools already do, and good enough to catch the real
// "changed since I read it" case. A session owns one store; it is passed to
// tools via ToolContext.observeFile / checkFileFresh. Absent in minimal test
// contexts — tools must treat it as optional and degrade to current behaviour.

import type { Stats } from "node:fs";

export interface FileObservation {
  /** Absolute, resolved path. */
  path: string;
  /** mtimeMs at observation time. */
  mtimeMs: number;
  /** Byte size at observation time. */
  size: number;
  /** Wall-clock of the observation (for diagnostics only). */
  observedAt: number;
}

export type FreshnessResult =
  | { ok: true }
  | {
      ok: false;
      /** "unobserved": never read this session. "stale": changed since read. */
      reason: "unobserved" | "stale";
      message: string;
    };

export class FileObservationStore {
  private readonly observations = new Map<string, FileObservation>();

  /** Record that `absPath` was just read, using a fresh stat. */
  observe(absPath: string, stat: Pick<Stats, "mtimeMs" | "size">): void {
    this.observations.set(absPath, {
      path: absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      observedAt: Date.now(),
    });
  }

  /** Whether `absPath` has been observed (read) this session. */
  has(absPath: string): boolean {
    return this.observations.has(absPath);
  }

  /**
   * Assert that a write/edit to `absPath` is safe. `currentStat` is the
   * current on-disk stat, or null when the file does not exist yet.
   *
   * - File does not exist (new file) → allowed; the caller is creating it.
   * - File exists but was never observed → "unobserved" (read-before-write).
   * - File exists and observed, but mtime/size differ → "stale".
   * - File exists, observed, unchanged → ok.
   */
  checkFresh(
    absPath: string,
    currentStat: Pick<Stats, "mtimeMs" | "size"> | null,
  ): FreshnessResult {
    // Creating a brand-new file: nothing to be stale against.
    if (currentStat === null) return { ok: true };

    const obs = this.observations.get(absPath);
    if (!obs) {
      return {
        ok: false,
        reason: "unobserved",
        message:
          `fs_guard: refusing to modify ${absPath} — you have not read it in this session. ` +
          `Call read_file on it first so your edit is based on its actual current contents, ` +
          `not on memory.`,
      };
    }

    // mtimeMs can have sub-ms jitter across filesystems; compare with a small
    // tolerance but treat any size change as definitive.
    const mtimeChanged = Math.abs(currentStat.mtimeMs - obs.mtimeMs) > 1;
    const sizeChanged = currentStat.size !== obs.size;
    if (mtimeChanged || sizeChanged) {
      return {
        ok: false,
        reason: "stale",
        message:
          `fs_guard: ${absPath} changed on disk since you last read it ` +
          `(observed ${obs.size} bytes @ ${new Date(obs.mtimeMs).toISOString()}, ` +
          `now ${currentStat.size} bytes @ ${new Date(currentStat.mtimeMs).toISOString()}). ` +
          `Re-read it with read_file, then redo your edit against the current contents.`,
      };
    }

    return { ok: true };
  }

  /**
   * Re-observe after a successful write so a subsequent edit in the same
   * session sees the just-written state as fresh (not stale against the
   * pre-write observation).
   */
  reobserveAfterWrite(absPath: string, stat: Pick<Stats, "mtimeMs" | "size">): void {
    this.observe(absPath, stat);
  }
}
