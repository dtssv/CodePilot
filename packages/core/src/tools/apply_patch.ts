// apply_patch: multi-file atomic edits using a unified patch format.
// Ops: Add/Delete/Update File between *** Begin/End Patch. All ops apply
// atomically — if any hunk fails, NO file is written. Update hunks are
// context-anchored: unchanged lines locate the position, `-` lines must match
// verbatim and are replaced by `+` lines.

import { z } from "zod";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ToolDef } from "./types.js";
import { guardDeliveryWrite, guardPath } from "./_shared.js";
import { hashFileContent } from "../workspace/fsObservation.js";

const schema = z.object({
  patch: z
    .string()
    .describe(
      "A unified patch in CodePilot apply_patch format. Begins with " +
        "`*** Begin Patch` and ends with `*** End Patch`. See the tool " +
        "description for the full grammar."
    ),
});

interface FileOp {
  kind: "add" | "delete" | "update";
  path: string;
 /** For `add`: the full file content. */
  content?: string;
 /** For `update`: ordered list of hunks. */
  hunks?: Hunk[];
}

interface Hunk {
 /** Context + changes lines. Each entry: {type: 'ctx'|'del'|'add', text}. */
  lines: { type: "ctx" | "del" | "add"; text: string }[];
}

/** True when `line` starts the next file op (or ends the patch). */
function isPatchSectionEnd(line: string | undefined): boolean {
  if (line === undefined) return true;
  return (
    line === "*** End File" ||
    line === "*** End Patch" ||
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Update File: ") ||
    line.startsWith("*** Delete File: ")
  );
}

/**
 * Consume an optional `*** End File` marker. Models often omit it and jump
 * straight to the next file header or `*** End Patch` — accept both.
 */
function consumeOptionalEndFile(rawLines: string[], i: number, end: number): number {
  if (i < rawLines.length && rawLines[i] === "*** End File") return i + 1;
  // Omitted End File is fine when we're at End Patch or the next file op.
  if (i === end || (i < end && isPatchSectionEnd(rawLines[i]))) return i;
  return i;
}

/** Paths touched by an apply_patch body (headers only — no full parse). */
export function pathsFromApplyPatch(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    for (const prefix of ["*** Add File: ", "*** Update File: ", "*** Delete File: "]) {
      if (line.startsWith(prefix)) {
        const p = line.slice(prefix.length).trim();
        if (p) paths.push(p);
        break;
      }
    }
  }
  return paths;
}

/** Parse the apply_patch format into a list of file operations. */
export function parsePatch(patch: string): FileOp[] {
  const rawLines = patch.split(/\r?\n/);
 // Strip a leading/trailing blank line that copy-paste often introduces.
  while (rawLines.length > 0 && rawLines[0]!.trim() === "") rawLines.shift();
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]!.trim() === "")
    rawLines.pop();

  if (rawLines[0] !== "*** Begin Patch") {
    throw new Error("patch must start with `*** Begin Patch`");
  }
  if (rawLines[rawLines.length - 1] !== "*** End Patch") {
    throw new Error("patch must end with `*** End Patch`");
  }

  const ops: FileOp[] = [];
  let i = 1;
  const end = rawLines.length - 1;
  while (i < end) {
    const line = rawLines[i]!;
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length);
      i++;
      const content: string[] = [];
      while (i < end && !isPatchSectionEnd(rawLines[i])) {
        content.push(rawLines[i]!);
        i++;
      }
      i = consumeOptionalEndFile(rawLines, i, end);
      ops.push({ kind: "add", path, content: content.join("\n") });
    } else if (line.startsWith("*** Delete File: ")) {
      ops.push({ kind: "delete", path: line.slice("*** Delete File: ".length) });
      i++;
    } else if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length);
      i++;
      const hunks: Hunk[] = [];
      let current: Hunk | null = null;
      while (i < end && !isPatchSectionEnd(rawLines[i])) {
        const h = rawLines[i]!;
        if (h.startsWith("@@")) {
 // Start a new hunk. The text after @@ is context (informational).
          current = { lines: [] };
          hunks.push(current);
          i++;
          continue;
        }
        if (!current) {
 // Lines before the first @@ — treat as context for an implicit hunk.
          current = { lines: [] };
          hunks.push(current);
        }
        if (h.startsWith("-")) {
          current.lines.push({ type: "del", text: h.slice(1) });
        } else if (h.startsWith("+")) {
          current.lines.push({ type: "add", text: h.slice(1) });
        } else if (h.startsWith(" ")) {
          current.lines.push({ type: "ctx", text: h.slice(1) });
        } else if (h === "") {
 // Blank line is context.
          current.lines.push({ type: "ctx", text: "" });
        } else {
 // No marker — treat as context (common in hand-written patches).
          current.lines.push({ type: "ctx", text: h });
        }
        i++;
      }
      i = consumeOptionalEndFile(rawLines, i, end);
      ops.push({ kind: "update", path, hunks });
    } else if (line === "*** End File") {
      // Stray End File between ops — ignore.
      i++;
    } else {
      throw new Error(`unexpected line in patch: ${line}`);
    }
  }
  return ops;
}

/** Apply a single hunk to a file's text. Returns the new text or throws. */
function applyHunk(original: string, hunk: Hunk): string {
  const lines = original.split(/\r?\n/);
 // Build a search signature: the sequence of ctx + del lines (in order).
 // We locate this block in the file, then rebuild it keeping the matched
 // SOURCE lines for context (so a fuzzy match never rewrites their bytes —
 // indentation, smart quotes, dashes stay as they are on disk) and applying
 // only the hunk's add/del operations.
  const searchSig: string[] = [];
  const replacement: string[] = [];
  for (const l of hunk.lines) {
    if (l.type === "ctx") {
      searchSig.push(l.text);
      replacement.push(l.text);
    } else if (l.type === "del") {
      searchSig.push(l.text);
    } else {
      replacement.push(l.text);
    }
  }
  if (searchSig.length === 0 && replacement.length > 0) {
 // Pure insertion — append at end.
    return [...lines, ...replacement].join("\n");
  }
 // Find the search signature as a contiguous block: exact, then whitespace-
 // tolerant, then typographic-tolerant (smart quotes / Unicode dashes / exotic
 // spaces + collapsed inner whitespace).
  let start = findSubArray(lines, searchSig);
  if (start < 0) start = findSubArrayTolerant(lines, searchSig);
  if (start < 0) start = findSubArrayTypographic(lines, searchSig);
  if (start < 0) {
    throw new Error(
      `hunk did not apply: context/removed lines not found. ` +
        `Expected: ${JSON.stringify(searchSig.slice(0, 3))}…`
    );
  }
 // Rebuild the matched block from the hunk, but take context lines verbatim
 // from the SOURCE (lines[start + k]) rather than from the patch, so a fuzzy
 // match leaves every unchanged line exactly as it was on disk.
  const rebuilt: string[] = [];
  let k = 0;
  for (const l of hunk.lines) {
    if (l.type === "ctx") {
      rebuilt.push(lines[start + k]!);
      k++;
    } else if (l.type === "del") {
      k++;
    } else {
      rebuilt.push(l.text);
    }
  }
  return spliceIn(lines, start, searchSig.length, rebuilt).join("\n");
}

function findSubArray(hay: string[], needle: string[]): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function findSubArrayTolerant(hay: string[], needle: string[]): number {
  const norm = (s: string) => s.replace(/\s+$/g, "").replace(/^\s+/g, "");
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (norm(hay[i + j]!) !== norm(needle[j]!)) continue outer;
    }
    return i;
  }
  return -1;
}

/** Fold smart/curly quotes → straight, Unicode dashes → hyphen-minus, exotic
 * spaces → plain space, collapse inner whitespace runs, and trim ends, per
 * line. Used only after exact and whitespace-tolerant matches have failed. */
function findSubArrayTypographic(hay: string[], needle: string[]): number {
  const norm = (s: string) =>
    s
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
      .replace(/[\t ]+/g, " ")
      .replace(/^\s+|\s+$/g, "");
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (norm(hay[i + j]!) !== norm(needle[j]!)) continue outer;
    }
    return i;
  }
  return -1;
}

function spliceIn(
  arr: string[],
  start: number,
  deleteCount: number,
  insert: string[]
): string[] {
  const out = arr.slice(0, start);
  out.push(...insert);
  out.push(...arr.slice(start + deleteCount));
  return out;
}

/** Count `+` / `-` lines in update hunks (context ignored). */
function hunkLineStats(hunks: Hunk[] | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks ?? []) {
    for (const l of h.lines) {
      if (l.type === "add") added++;
      else if (l.type === "del") removed++;
    }
  }
  return { added, removed };
}

/** e.g. `+3/-1`, `+5`, `-2`, or empty when both zero. */
function formatLineStats(added: number, removed: number): string {
  if (added <= 0 && removed <= 0) return "";
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  return parts.join("/");
}

/** Line count for add/delete summaries (trailing empty split ignored like editors). */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\r\n/g, "\n").split("\n").length;
}

export const applyPatchTool: ToolDef<typeof schema> = {
  name: "apply_patch",
  description:
    "Atomic multi-file patch (all-or-nothing). Prefer when several files or hunks change together. " +
    "Envelope: `*** Begin Patch` … `*** End Patch` with `*** Add File: path` (create only — existing path refused), " +
    "`*** Delete File: path`, or `*** Update File: path` + `@@` hunks (` `/`-`/`+` lines, no line-number prefixes; " +
    "context must match disk). On hunk failure: adjust context from the error — do not resubmit the same patch. " +
    "Do not mix with edit_file/write_file on the same path in the same fix set (later turns too) — re-patch instead.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    let ops: FileOp[];
    try {
      ops = parsePatch(input.patch);
    } catch (err) {
      return { content: `parse error: ${(err as Error).message}`, isError: true };
    }
    if (ops.length === 0) {
      return { content: "patch contained no file operations", isError: true };
    }

 // 1. Guard all paths up front (fail-fast on a disallowed path).
    for (const op of ops) {
      const guard = await guardPath(ctx, op.path, op.kind === "delete" ? "write" : "write");
      if (guard) return guard;
      const delivery = await guardDeliveryWrite(ctx, op.path);
      if (delivery) return delivery;
    }

 // 2. Read all files that will be updated (so we can roll back cleanly).
    // Update File: no fs_guard — hunks must match live disk (peer apply_patch).
    // Add File: refuse if the path already exists (use Update / write_file).
    const originals = new Map<string, string>();
    for (const op of ops) {
      if (op.kind === "update") {
        try {
          originals.set(op.path, await readFile(resolve(ctx.cwd, op.path), "utf-8"));
        } catch (err) {
          return {
            content: `failed to read ${op.path}: ${(err as Error).message}`,
            isError: true,
          };
        }
      } else if (op.kind === "add") {
        const p = resolve(ctx.cwd, op.path);
        if (existsSync(p)) {
          return {
            content:
              `apply_patch: "Add File ${op.path}" targets a file that already exists. ` +
              `Add File only creates new files. To change it, use an Update File hunk ` +
              `(or write_file) whose context matches the current contents — not a blind overwrite.`,
            isError: true,
          };
        }
      }
    }

 // 3. Compute all new contents (apply hunks) BEFORE writing anything.
    // Same-path Update ops chain onto the evolving buffer — otherwise a second
    // `*** Update File: x` would re-apply against the original and clobber the first.
    const writes: { path: string; content: string; added: number; removed: number }[] = [];
    const deletes: { path: string; removed: number }[] = [];
    const adds: { path: string; content: string; added: number }[] = [];
    const pendingUpdates = new Map<string, { content: string; added: number; removed: number }>();
    try {
      for (const op of ops) {
        if (op.kind === "add") {
          const content = op.content ?? "";
          adds.push({ path: op.path, content, added: countLines(content) });
        } else if (op.kind === "delete") {
          const prior = originals.get(op.path);
          let removed = 0;
          if (prior !== undefined) {
            removed = countLines(prior);
          } else {
            try {
              removed = countLines(await readFile(resolve(ctx.cwd, op.path), "utf-8"));
            } catch {
              removed = 0;
            }
          }
          deletes.push({ path: op.path, removed });
        } else {
          const prev = pendingUpdates.get(op.path);
          let working = prev?.content ?? originals.get(op.path)!;
          let added = prev?.added ?? 0;
          let removed = prev?.removed ?? 0;
          const stats = hunkLineStats(op.hunks);
          added += stats.added;
          removed += stats.removed;
          for (let hi = 0; hi < (op.hunks ?? []).length; hi++) {
            try {
              working = applyHunk(working, op.hunks![hi]!);
            } catch (err) {
              throw new Error(
                `${op.path} hunk #${hi + 1}: ${(err as Error).message}`
              );
            }
          }
          pendingUpdates.set(op.path, { content: working, added, removed });
        }
      }
      for (const [path, u] of pendingUpdates) {
        writes.push({ path, content: u.content, added: u.added, removed: u.removed });
      }
    } catch (err) {
      return { content: `apply failed (no files written): ${(err as Error).message}`, isError: true };
    }

 // 4. Commit: adds → updates → deletes. Order matters for rename-like ops.
    const summary: string[] = [];
    try {
      for (const a of adds) {
        const p = resolve(ctx.cwd, a.path);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, a.content, "utf-8");
        try {
          const s = await stat(p);
          ctx.reobserveFile?.(
            p,
            { mtimeMs: s.mtimeMs, size: s.size },
            hashFileContent(Buffer.from(a.content, "utf-8")),
          );
        } catch {
          /* best-effort */
        }
        const stats = formatLineStats(a.added, 0);
        summary.push(`+ added ${a.path}${stats ? ` (${stats})` : ""}`);
      }
      for (const w of writes) {
        const p = resolve(ctx.cwd, w.path);
        await writeFile(p, w.content, "utf-8");
        try {
          const s = await stat(p);
          ctx.reobserveFile?.(
            p,
            { mtimeMs: s.mtimeMs, size: s.size },
            hashFileContent(Buffer.from(w.content, "utf-8")),
          );
        } catch {
          /* best-effort */
        }
        const stats = formatLineStats(w.added, w.removed);
        summary.push(`~ updated ${w.path}${stats ? ` (${stats})` : ""}`);
      }
      for (const d of deletes) {
        const p = resolve(ctx.cwd, d.path);
        if (existsSync(p)) await rm(p);
        const stats = formatLineStats(0, d.removed);
        summary.push(`- deleted ${d.path}${stats ? ` (${stats})` : ""}`);
      }
    } catch (err) {
      return {
        content: `partial failure: ${summary.join("\n")}\nerror: ${(err as Error).message}`,
        isError: true,
      };
    }

    const touched = [...adds, ...writes].map((f) => resolve(ctx.cwd, f.path));
    const note = (await ctx.postWrite?.(touched, ctx)) ?? "";
    return {
      content: `applied ${ops.length} file operation(s) atomically:\n${summary.join("\n")}${note}`,
    };
  },
};
