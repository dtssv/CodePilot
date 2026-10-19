/**
 * Persistent prompt history for the TUI.
 *
 * Storage: one JSON line per entry at ~/.codepilot/tui-history.jsonl:
 * {"text":"…","cwd":"…","at":1739000000000}
 *
 * Design choices:
 * - Append-only JSONL: a crash mid-write corrupts at most the last line,
 * which we skip on load. No locking needed for a single TUI instance.
 * - Load is sync and capped (newest N entries) so startup stays instant.
 * - Duplicates are de-duped on write (move-to-end semantics).
 * - Entries from every cwd are kept; navigation shows newest first
 * regardless of project — muscle memory beats scoping here.
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HistoryEntry {
  text: string;
  cwd: string;
  at: number;
}

const MAX_LOADED = 1000;
const MAX_PERSISTED = 2000;

export function defaultHistoryPath(home: string = homedir()): string {
  return join(home, ".codepilot", "tui-history.jsonl");
}

/** Load history newest-first. Corrupt lines are skipped silently. */
export function loadHistory(path: string = defaultHistoryPath()): HistoryEntry[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const v = JSON.parse(t) as HistoryEntry;
      if (typeof v.text === "string" && v.text !== "") out.push(v);
    } catch {
 /* skip corrupt line */
    }
  }
 // Oldest-first in file → reverse to newest-first; cap.
  out.reverse();
  return out.slice(0, MAX_LOADED);
}

/** Append one entry. Best-effort: any I/O failure is swallowed — losing
 * history must never break the prompt loop. */
export function appendHistory(
  entry: HistoryEntry,
  path: string = defaultHistoryPath(),
): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
 /* best-effort */
  }
}

/** Rewrite the file keeping only the newest MAX_PERSISTED entries. Called
 * on exit; atomic via write+rename so a crash can't lose the whole file. */
export function compactHistory(path: string = defaultHistoryPath()): void {
  try {
    const entries = loadHistory(path).slice(0, MAX_PERSISTED);
    const body = entries
      .reverse() // oldest-first again for append-friendly files
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tmp = path + ".tmp";
    writeFileSync(tmp, body === "" ? "" : body + "\n", "utf-8");
    renameSync(tmp, path);
  } catch {
 /* best-effort */
  }
}

/**
 * Fuzzy-filter history for the Ctrl+R reverse-search. A query matches when
 * its characters appear in order in the entry text (subsequence match);
 * results are ranked: substring-prefix hits first, then other substring
 * hits, then subsequence hits, newest first within each tier.
 */
export function searchHistory(
  entries: readonly HistoryEntry[],
  query: string,
  limit = 20,
): HistoryEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return entries.slice(0, limit);
  const prefix: HistoryEntry[] = [];
  const substr: HistoryEntry[] = [];
  const subseq: HistoryEntry[] = [];
  for (const e of entries) {
    const text = e.text.toLowerCase();
    if (text.startsWith(q)) prefix.push(e);
    else if (text.includes(q)) substr.push(e);
    else if (isSubsequence(q, text)) subseq.push(e);
  }
  return [...prefix, ...substr, ...subseq].slice(0, limit);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}
