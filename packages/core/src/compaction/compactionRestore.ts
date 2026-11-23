// Post-compaction file restore: a summary compaction drops the turns that read
// files. We only list the hot paths (re-embedding bodies would undo the shrink
// and fight the summarizer's "no code dumps" rule); the history archive still
// holds verbatim dropped turns for grep.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Event } from "../types.js";

/** Tools whose `path` input means "the model has this file in mind". */
const FILE_TOOLS = new Set(["read_file", "edit_file", "write_file", "notebook_edit"]);

export interface RestoreOptions {
  cwd: string;
  maxFiles: number;
  /** @deprecated Ignored — bodies are never re-embedded. Kept for call-site compat. */
  perFileTokens?: number;
  /** @deprecated Ignored — bodies are never re-embedded. Kept for call-site compat. */
  totalTokens?: number;
  /** @deprecated Ignored — bodies are never re-embedded. Kept for call-site compat. */
  estimateTokens?: (text: string) => number;
  /** Returns false for paths the model may not read (sensitive / outside policy). */
  canRead: (absPath: string) => boolean | Promise<boolean>;
}

export interface RestoredFile {
  path: string;
  /** No longer populated (bodies not read). Kept for call-site typing. */
  mtimeMs: number;
  size: number;
  hash: string;
}

/**
 * Paths touched in `dropped` (most recent first) whose content is no longer
 * visible: a `read_file` of the same path still in `retained` keeps it out.
 */
export function droppedFilePaths(dropped: Event[], retained: Event[], cwd: string): string[] {
  const abs = (p: string) => (isAbsolute(p) ? resolve(p) : resolve(cwd, p));
  const pathOf = (e: Event): string | null => {
    if (e.type !== "tool_call" || !FILE_TOOLS.has(e.name)) return null;
    const p = (e.input as { path?: unknown } | null)?.path;
    return typeof p === "string" && p.length > 0 ? abs(p) : null;
  };
  const stillVisible = new Set<string>();
  for (const e of retained) {
    if (e.type === "tool_call" && e.name === "read_file") {
      const p = pathOf(e);
      if (p) stillVisible.add(p);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = dropped.length - 1; i >= 0; i--) {
    const p = pathOf(dropped[i]!);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (!stillVisible.has(p)) out.push(p);
  }
  return out;
}

/**
 * Render up to `maxFiles` of `paths` as a paths-only `<restored_files>` block.
 * Does not read or paste file contents — the model should `read_file` / grep
 * the history archive when it needs exact text.
 */
export async function renderRestoredFiles(
  paths: string[],
  opts: RestoreOptions,
): Promise<{ text: string; files: RestoredFile[] }> {
  const lines: string[] = [];
  const files: RestoredFile[] = [];
  for (const p of paths) {
    if (files.length >= opts.maxFiles) break;
    if (!existsSync(p)) continue;
    if (!(await opts.canRead(p))) continue;
    lines.push(`- \`${p}\``);
    files.push({ path: p, mtimeMs: 0, size: 0, hash: "" });
  }
  if (lines.length === 0) return { text: "", files };
  return {
    text:
      `<restored_files>\nFiles you read or edited before this summary (paths only — ` +
      `re-read with read_file, or grep the history archive, before relying on exact text):\n` +
      `${lines.join("\n")}\n</restored_files>`,
    files,
  };
}
