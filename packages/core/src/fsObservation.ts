// File-observation store: read-before-write + staleness (CAS) guard.
//
// Read-before-write gate: records mtime+size (+ content hash) whenever a file
// is read, and lets write-tools assert (a) the path was observed this session
// and (b) the on-disk state still matches — preventing edits from stale
// memory or from files changed by another process since the last read.
// mtime+size is the primary check (cheap, no extra I/O); a content hash is the
// fallback that clears a false positive when a formatter rewrites identical
// bytes or `touch` bumps mtime. Optional in ToolContext — tools degrade to
// current behaviour when absent.

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";

/** Large files only hash a head+tail sample (plus size) to stay cheap; smaller
 * files hash in full. The boundary is well above typical source files. */
const FULL_HASH_LIMIT = 256 * 1024;
/** Head/tail sample size for large-file hashing. */
const SAMPLE_BYTES = 64 * 1024;

/**
 * Fast content hash for the stale-write fallback. Full SHA-1 for files up to
 * `FULL_HASH_LIMIT`; for larger files a hash of size + head + tail sample, so a
 * real edit anywhere near the ends (the common case) is still caught while the
 * cost stays bounded. Equal hashes mean "very likely identical", used only to
 * rescue a false-positive mtime — never to declare a file changed.
 */
export function hashFileContent(buf: Buffer): string {
  const h = createHash("sha1");
  if (buf.length <= FULL_HASH_LIMIT) {
    h.update(buf);
    return `f:${h.digest("hex")}`;
  }
  h.update(String(buf.length));
  h.update(buf.subarray(0, SAMPLE_BYTES));
  h.update(buf.subarray(buf.length - SAMPLE_BYTES));
  return `s:${h.digest("hex")}`;
}

export interface FileObservation {
  /** Absolute, resolved path. */
  path: string;
  /** mtimeMs at observation time. */
  mtimeMs: number;
  /** Byte size at observation time. */
  size: number;
  /** Content hash at observation time (hashFileContent), when the reader
   * supplied it. Used only to rescue a false-positive mtime; absent on older
   * observations, in which case the mtime/size decision stands. */
  contentHash?: string;
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

  /** Record that `absPath` was just read, using a fresh stat. An optional
   * `contentHash` (from hashFileContent on the bytes just read) enables the
   * content-equality fallback in checkFresh. */
  observe(
    absPath: string,
    stat: Pick<Stats, "mtimeMs" | "size">,
    contentHash?: string,
  ): void {
    this.observations.set(absPath, {
      path: absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      contentHash,
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
   * - File exists and observed, but mtime/size differ → normally "stale", BUT
   *   if both the observation and `currentContentHash` are present and equal,
   *   the content is unchanged (false-positive mtime) → ok.
   * - File exists, observed, unchanged → ok.
   *
   * `currentContentHash` (from hashFileContent on the current on-disk bytes) is
   * optional: tools may supply it so a jittered mtime does not block an edit to
   * identical content. When omitted, the mtime/size decision stands.
   */
  checkFresh(
    absPath: string,
    currentStat: Pick<Stats, "mtimeMs" | "size"> | null,
    currentContentHash?: string,
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
      // Content-equality fallback: if we recorded a hash at read time and the
      // current content hashes the same, the mtime moved but the bytes did not
      // (formatter rewrite, touch, FS mtime precision) — allow the edit.
      if (
        obs.contentHash !== undefined &&
        currentContentHash !== undefined &&
        obs.contentHash === currentContentHash
      ) {
        return { ok: true };
      }
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
   * pre-write observation). Carries an optional content hash of the bytes just
   * written.
   */
  reobserveAfterWrite(
    absPath: string,
    stat: Pick<Stats, "mtimeMs" | "size">,
    contentHash?: string,
  ): void {
    this.observe(absPath, stat, contentHash);
  }
}
