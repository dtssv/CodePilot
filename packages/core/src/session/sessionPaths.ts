import { join } from "node:path";
import { homedir } from "node:os";

export const SESSIONS_DIR = join(homedir(), ".codepilot", "sessions");

/** Resolved at call time — useful for tests that change HOME. */
export function getSessionsDir(): string {
  return join(homedir(), ".codepilot", "sessions");
}

export function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`);
}

/** Cold-storage path for a session whose plaintext JSONL has been compressed
 * (see sessionCompression.ts). A session is EITHER live (`.jsonl`, no
 * compressed sibling) OR cold (`.jsonl.br`, no `.jsonl`) — never both; the
 * compressed form uses brotli (built into node:zlib, no native dep). */
export function compressedSessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl.br`);
}

/** Human-readable record of the turns compaction removed from the session
 * file. Append-only, so it holds every compacted turn, oldest first. */
export function historyArchivePath(id: string): string {
  return join(SESSIONS_DIR, `${id}.history.md`);
}

export function titleSidecarPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.title`);
}

export function cwdSidecarPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.cwd`);
}

export function stateSidecarPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.state`);
}

/** Normalize cwd for comparison (strip trailing slashes). */
export function normalizeCwd(cwd: string): string {
  const t = cwd.trim();
  if (!t || t === "/") return t || "/";
  return t.replace(/\/+$/, "");
}

export function sameCwd(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a === "(unknown)" || b === "(unknown)") return false;
  return normalizeCwd(a) === normalizeCwd(b);
}