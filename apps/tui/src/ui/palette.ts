/**
 * Fuzzy matching for the command palette.
 *
 * A query matches a command when it fuzzy-matches (subsequence) the name OR
 * any word in the description. Ranking:
 * 1. exact name match
 * 2. name startsWith query
 * 3. name substring
 * 4. name subsequence
 * 5. description substring
 * Ties break by the command's original list order (built-ins first).
 */
import type { CommandInfo } from "./commands.js";

export interface RankedCommand {
  command: CommandInfo;
 /** Lower is better. */
  score: number;
}

export function fuzzyScore(command: CommandInfo, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 100; // empty query: list everything in declared order
  const name = command.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 10 + (name.length - q.length) * 0.1;
  const sub = name.indexOf(q);
  if (sub >= 0) return 20 + sub;
  if (isSubsequence(q, name)) return 40 + name.length * 0.1;
  const desc = command.description.toLowerCase();
  const dsub = desc.indexOf(q);
  if (dsub >= 0) return 60 + dsub * 0.1;
  return null;
}

export function filterCommands(
  commands: readonly CommandInfo[],
  query: string,
  limit = 12,
): CommandInfo[] {
  const ranked: RankedCommand[] = [];
  for (const c of commands) {
    const score = fuzzyScore(c, query);
    if (score !== null) ranked.push({ command: c, score });
  }
  ranked.sort((a, b) => a.score - b.score);
  return ranked.slice(0, limit).map((r) => r.command);
}

/** Longest shared prefix of `names` (case-sensitive as given). */
export function commonPrefix(names: readonly string[]): string {
  if (names.length === 0) return "";
  let prefix = names[0]!;
  for (let i = 1; i < names.length; i++) {
    const s = names[i]!;
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) j++;
    prefix = prefix.slice(0, j);
    if (prefix.length === 0) return "";
  }
  return prefix;
}

export interface TabCompleteResult {
 /** Full input after completion, e.g. `/connect`. */
  nextInput: string;
 /** Selection index to keep in the filtered list. */
  nextSelected: number;
 /** When true the palette can close (unique full name completed). */
  closePalette: boolean;
}

/**
 * Shell-style Tab completion for slash commands.
 *
 * - Unique match (e.g. query `conn` → `connect`): fill `/connect`.
 * - Several matches with a longer shared prefix: extend the query toward it.
 * - Query already equals a full command name: cycle to the next filtered hit.
 * - Otherwise: complete the currently selected row's name.
 */
export function tabCompleteCommand(
  commands: readonly CommandInfo[],
  query: string,
  selected: number,
): TabCompleteResult | null {
  const filtered = filterCommands(commands, query);
  if (filtered.length === 0) return null;

  const q = query.trim().toLowerCase();
  const names = filtered.map((c) => c.name);
  const sel = Math.min(Math.max(0, selected), filtered.length - 1);

 // Already a full command name → cycle to the next candidate.
  const exactIdx = names.findIndex((n) => n.toLowerCase() === q);
  if (exactIdx >= 0 && filtered.length > 1) {
    const next = (exactIdx + 1) % filtered.length;
    const name = names[next]!;
    return { nextInput: `/${name}`, nextSelected: next, closePalette: false };
  }
  if (exactIdx >= 0 && filtered.length === 1) {
    return { nextInput: `/${names[0]}`, nextSelected: 0, closePalette: true };
  }

 // Prefer prefix matches for common-prefix extension (ignore desc-only hits).
  const prefixHits = names.filter((n) => n.toLowerCase().startsWith(q));
  if (prefixHits.length > 1) {
    const shared = commonPrefix(prefixHits.map((n) => n.toLowerCase()));
    if (shared.length > q.length) {
      return {
        nextInput: `/${shared}`,
        nextSelected: 0,
        closePalette: false,
      };
    }
 // Shared prefix already typed — complete the highlighted row.
    const name = names[sel]!;
    return {
      nextInput: `/${name}`,
      nextSelected: sel,
      closePalette: filtered.length === 1,
    };
  }

 // Unique prefix hit or fuzzy-only list: take selected (usually rank #0).
  const name = names[sel]!;
  const uniquePrefix = prefixHits.length === 1 && prefixHits[0]!.toLowerCase() === name.toLowerCase();
  return {
    nextInput: `/${name}`,
    nextSelected: sel,
    closePalette: filtered.length === 1 || uniquePrefix,
  };
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}
