// Session retention + cold compression.
//
// Two housekeeping operations over the sessions directory, both fail-soft and
// safe to run at startup or in the background:
//
//   - Retention: delete non-pinned sessions whose JSONL (live or cold) is older
//     than `sessions.retentionDays` by mtime. 0 (default) never deletes.
//   - Cold compression: a session whose plaintext JSONL has not been touched for
//     `sessions.coldCompressAfterDays` is compressed to a `.jsonl.br` sibling and
//     the plaintext removed, reclaiming disk. It is transparently decompressed
//     ("thawed") back to plaintext before the session is opened for writing.
//
// Codec is brotli via node:zlib — built in, no native dependency, available on
// every supported runtime (unlike node's zstd, which is above the repo's Node
// floor). The source of truth stays JSONL: a session is EITHER live (`.jsonl`,
// no `.jsonl.br`) OR cold (`.jsonl.br`, no `.jsonl`), never both. A failed
// compress or decompress leaves the existing file untouched (no data loss).

import { readFile, writeFile, unlink, readdir, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import type { CodepilotConfig } from "./types.js";
import {
  getSessionsDir,
  sessionPath,
  compressedSessionPath,
  compressSessionText,
  decompressSessionBuffer,
  loadSessionState,
  deleteSession,
} from "./session-utils.js";
import { createLogger } from "./logger.js";

const log = createLogger("session-compress");

const DAY_MS = 24 * 60 * 60 * 1000;
const COLD_SUFFIX = ".jsonl.br";
const LIVE_SUFFIX = ".jsonl";

/** True when a session is cold (a `.jsonl.br` exists for it). Cheap stat. */
export async function isSessionCold(id: string): Promise<boolean> {
  try {
    await stat(compressedSessionPath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a cold session's JSONL text, or null when it is not cold / unreadable.
 * Used by read paths (list/search/index) that want cold content without first
 * thawing the whole session to disk.
 */
export async function readColdSessionText(id: string): Promise<string | null> {
  try {
    const buf = await readFile(compressedSessionPath(id));
    return decompressSessionBuffer(buf);
  } catch {
    return null;
  }
}

/**
 * Freeze a live session: compress its `.jsonl` to `.jsonl.br`, then remove the
 * plaintext. No-op (returns false) when the session is already cold, has no
 * plaintext, or on any error. The compressed file is written and fsync-flushed
 * before the plaintext is unlinked, so a crash mid-freeze never loses the
 * transcript (worst case leaves both, which `thawSession` resolves on next open).
 */
export async function freezeSession(id: string): Promise<boolean> {
  const live = sessionPath(id);
  const cold = compressedSessionPath(id);
  try {
    const text = await readFile(live, "utf-8");
    const compressed = compressSessionText(text);
    // Write to a temp then rename so a reader never sees a partial `.br`.
    const tmp = `${cold}.tmp`;
    await writeFile(tmp, compressed);
    await rename(tmp, cold);
    await unlink(live);
    return true;
  } catch (err) {
    // Clean up a partial temp if present; leave the plaintext intact.
    try {
      await unlink(`${cold}.tmp`);
    } catch {
      /* ignore */
    }
    log.debug(`freeze ${id} skipped: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Thaw a cold session back to a live `.jsonl` so it can be read with the normal
 * plaintext path and, critically, appended to. MUST run before a session is
 * opened for writing. No-op when the session is not cold. On success the
 * `.jsonl.br` is removed; on any error the cold file is left untouched.
 *
 * If BOTH a `.jsonl` and `.jsonl.br` exist (a crash during a prior freeze), the
 * plaintext wins and the stale `.br` is discarded — the plaintext is the newer,
 * append-target source of truth.
 */
export async function thawSession(id: string): Promise<boolean> {
  const live = sessionPath(id);
  const cold = compressedSessionPath(id);
  let coldBuf: Buffer;
  try {
    coldBuf = await readFile(cold);
  } catch {
    return false; // not cold
  }
  // Crash-recovery: a live plaintext already exists → it is the truth; drop the
  // stale compressed copy without overwriting the plaintext.
  try {
    await stat(live);
    await unlink(cold).catch(() => undefined);
    return true;
  } catch {
    /* no live file — proceed to decompress */
  }
  try {
    const text = decompressSessionBuffer(coldBuf);
    const tmp = `${live}.tmp`;
    await writeFile(tmp, text, "utf-8");
    await rename(tmp, live);
    await unlink(cold).catch(() => undefined);
    return true;
  } catch (err) {
    try {
      await unlink(`${live}.tmp`);
    } catch {
      /* ignore */
    }
    log.warn(`thaw ${id} failed, leaving it cold: ${(err as Error).message}`);
    return false;
  }
}

/** The session ids with a JSONL (live or cold) on disk, and the mtime of that
 * file. Pure enumeration; does not read contents. */
async function enumerateSessionFiles(
  dir: string,
): Promise<Array<{ id: string; mtimeMs: number; cold: boolean }>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ id: string; mtimeMs: number; cold: boolean }> = [];
  for (const name of names) {
    let id: string | undefined;
    let cold = false;
    if (name.endsWith(COLD_SUFFIX)) {
      id = name.slice(0, -COLD_SUFFIX.length);
      cold = true;
    } else if (name.endsWith(LIVE_SUFFIX)) {
      id = name.slice(0, -LIVE_SUFFIX.length);
    }
    if (!id) continue;
    try {
      const st = await stat(join(dir, name));
      out.push({ id, mtimeMs: st.mtimeMs, cold });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return out;
}

export interface RetentionSweepResult {
  deleted: string[];
  kept: number;
}

/**
 * Delete non-pinned sessions older than `retentionDays` by mtime. Fail-soft:
 * each session is handled independently; one failure never aborts the sweep.
 * `retentionDays <= 0` is a no-op. Pinned sessions are always exempt. Operates
 * on both live and cold sessions (the cold `.br` mtime is the retention key).
 */
export async function sweepSessionRetention(opts: {
  config?: CodepilotConfig;
  now?: number;
  dir?: string;
}): Promise<RetentionSweepResult> {
  const days = opts.config?.sessions?.retentionDays ?? 0;
  const result: RetentionSweepResult = { deleted: [], kept: 0 };
  if (!days || days <= 0) return result;
  const dir = opts.dir ?? getSessionsDir();
  const now = opts.now ?? Date.now();
  const cutoff = now - days * DAY_MS;
  const files = await enumerateSessionFiles(dir);
  for (const f of files) {
    if (f.mtimeMs >= cutoff) {
      result.kept++;
      continue;
    }
    // Exempt pinned sessions from retention.
    let pinned = false;
    try {
      pinned = (await loadSessionState(f.id)).pinned === true;
    } catch {
      /* unreadable state → treat as unpinned, still subject to retention */
    }
    if (pinned) {
      result.kept++;
      continue;
    }
    try {
      // deleteSession removes the JSONL + sidecars + lock; also unlink the cold
      // variant it does not know about.
      await deleteSession(f.id, { force: true });
      await unlink(compressedSessionPath(f.id)).catch(() => undefined);
      result.deleted.push(f.id);
    } catch (err) {
      log.debug(`retention delete ${f.id} failed: ${(err as Error).message}`);
      result.kept++;
    }
  }
  if (result.deleted.length > 0) {
    log.info(`retention swept ${result.deleted.length} session(s) older than ${days}d`);
  }
  return result;
}

export interface ColdCompressResult {
  compressed: string[];
  skipped: number;
}

/**
 * Compress live sessions not touched for `coldCompressAfterDays` into
 * `.jsonl.br`. Fail-soft and idempotent (already-cold sessions are skipped).
 * Gated on `sessions.coldCompress === true`. Pinned sessions are left live
 * (they are the ones most likely to be reopened). A session with a live-writer
 * lock is skipped — freezing a file being appended would corrupt it.
 */
export async function compressColdSessions(opts: {
  config?: CodepilotConfig;
  now?: number;
  dir?: string;
}): Promise<ColdCompressResult> {
  const result: ColdCompressResult = { compressed: [], skipped: 0 };
  if (opts.config?.sessions?.coldCompress !== true) return result;
  const afterDays = opts.config?.sessions?.coldCompressAfterDays ?? 30;
  const dir = opts.dir ?? getSessionsDir();
  const now = opts.now ?? Date.now();
  const cutoff = now - Math.max(1, afterDays) * DAY_MS;
  const files = await enumerateSessionFiles(dir);
  for (const f of files) {
    if (f.cold) {
      result.skipped++;
      continue; // already compressed
    }
    if (f.mtimeMs >= cutoff) {
      result.skipped++;
      continue; // still warm
    }
    // Skip a session with a live writer lock (it may be appending).
    try {
      await stat(join(dir, `${f.id}.lock`));
      result.skipped++;
      continue;
    } catch {
      /* no lock → safe to freeze */
    }
    // Keep pinned sessions live for quick reopen.
    try {
      if ((await loadSessionState(f.id)).pinned === true) {
        result.skipped++;
        continue;
      }
    } catch {
      /* unreadable state → still eligible */
    }
    const ok = await freezeSession(f.id);
    if (ok) result.compressed.push(f.id);
    else result.skipped++;
  }
  if (result.compressed.length > 0) {
    log.info(`cold-compressed ${result.compressed.length} session(s)`);
  }
  return result;
}
