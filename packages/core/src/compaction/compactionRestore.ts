// Post-compaction file restore: a summary compaction drops the turns that read
// files, leaving the model to re-read what it was working on. Re-attach the
// most recently touched files (current disk content, bounded) so work resumes
// without a round of re-reads.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { hashFileContent } from "../workspace/fsObservation.js";
import { formatLine } from "../tools/read_file.js";
import type { Event } from "../types.js";

/** Tools whose `path` input means "the model has this file in mind". */
const FILE_TOOLS = new Set(["read_file", "edit_file", "write_file", "notebook_edit"]);

/** Files above this size are never restored (read_file would spill them). */
const MAX_RESTORE_BYTES = 256 * 1024;

export interface RestoreOptions {
  cwd: string;
  maxFiles: number;
  perFileTokens: number;
  totalTokens: number;
  estimateTokens: (text: string) => number;
  /** Returns false for paths the model may not read (sensitive / outside policy). */
  canRead: (absPath: string) => boolean | Promise<boolean>;
}

export interface RestoredFile {
  path: string;
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
 * Render up to `maxFiles` of `paths` as a `<restored_files>` block within the
 * token budgets. Missing, binary, oversized and unreadable files are skipped.
 */
export async function renderRestoredFiles(
  paths: string[],
  opts: RestoreOptions,
): Promise<{ text: string; files: RestoredFile[] }> {
  const sections: string[] = [];
  const files: RestoredFile[] = [];
  let used = 0;
  for (const p of paths) {
    if (files.length >= opts.maxFiles) break;
    if (!(await opts.canRead(p))) continue;
    let buf: Buffer;
    let st;
    try {
      st = await stat(p);
      if (!st.isFile() || st.size > MAX_RESTORE_BYTES) continue;
      buf = await readFile(p);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) continue;
    const lines = buf.toString("utf-8").split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

    const budget = Math.min(opts.perFileTokens, opts.totalTokens - used);
    if (budget <= 0) break;
    const kept: string[] = [];
    let cost = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = formatLine(i + 1, lines[i]!);
      const c = opts.estimateTokens(line) + 1;
      if (cost + c > budget) break;
      kept.push(line);
      cost += c;
    }
    if (kept.length === 0) continue;
    const shown =
      kept.length < lines.length
        ? `${kept.length} of ${lines.length} lines; read_file with startLine=${kept.length} for the rest`
        : `${lines.length} lines`;
    sections.push(`## ${p} (${shown})\n${kept.join("\n")}`);
    files.push({ path: p, mtimeMs: st.mtimeMs, size: st.size, hash: hashFileContent(buf) });
    used += cost;
  }
  if (sections.length === 0) return { text: "", files };
  return {
    text:
      `<restored_files>\nFiles you read or edited before this summary, re-read from disk just now ` +
      `(current content). Use these instead of re-reading; read any other file again before relying on it.\n\n` +
      `${sections.join("\n\n")}\n</restored_files>`,
    files,
  };
}
