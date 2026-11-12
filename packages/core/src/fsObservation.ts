// File-observation store: read-before-write + staleness guard.
// Records mtime+size (+ content hash) on read; write-tools assert the path was
// observed and the on-disk state still matches. mtime+size is the primary check;
// a content hash clears false positives (formatter rewrite, `touch`). Optional.

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";

/** Large files only hash a head+tail sample (plus size) to stay cheap; smaller
 * files hash in full. The boundary is well above typical source files. */
const FULL_HASH_LIMIT = 256 * 1024;
/** Head/tail sample size for large-file hashing. */
const SAMPLE_BYTES = 64 * 1024;

/**
 * Fast content hash for the stale-write fallback. Full SHA-1 up to
 * `FULL_HASH_LIMIT`; larger files hash size + head + tail sample. Equal hashes
 * mean "very likely identical", used only to rescue a false-positive mtime.
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
   * Assert a write/edit to `absPath` is safe. New file → allowed; unobserved →
   * "unobserved"; mtime/size mismatch → "stale" unless a matching
   * `currentContentHash` proves bytes unchanged (false-positive mtime).
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
   * Re-observe after a successful write so a subsequent edit sees the
   * just-written state as fresh. Carries an optional content hash.
   */
  reobserveAfterWrite(
    absPath: string,
    stat: Pick<Stats, "mtimeMs" | "size">,
    contentHash?: string,
  ): void {
    this.observe(absPath, stat, contentHash);
  }
}
