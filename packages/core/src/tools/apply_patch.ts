// apply_patch: multi-file edits using a unified patch format.
// Ops: Add/Delete/Update File between *** Begin/End Patch. The compute phase
// is all-or-nothing (if any hunk fails, NO file is written). Commit writes
// sequentially (adds → updates → deletes) without rollback.
// Update hunks are context-anchored: unchanged lines locate the position,
// `-` lines must match verbatim and are replaced by `+` lines.

import { z } from "zod";
import { readFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ToolDef } from "./types.js";
import { guardDeliveryWrite, guardPath } from "./_shared.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { withWriteLocks } from "./writeLock.js";
import { restoreUtf8Bom, stripUtf8Bom } from "./utf8Bom.js";
import { hashFileContent } from "../workspace/fsObservation.js";
import {
  closestSnippet,
  detectLineEnding,
  splitLinesWithEol,
  type LineWithEol,
} from "./edit_file.js";

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
  /** For `update` with `*** Move to:` — write result to this path and delete `path`. */
  moveTo?: string;
 /** For `add`: the full file content. */
  content?: string;
 /** For `update`: ordered list of hunks. */
  hunks?: Hunk[];
}

interface Hunk {
 /** Context + changes lines. Each entry: {type: 'ctx'|'del'|'add', text}. */
  lines: { type: "ctx" | "del" | "add"; text: string }[];
  /** Optional single-line anchor from `@@ <text>` (change_context). */
  changeContext?: string;
  /** Prefer matching from EOF (`*** End of File` seek). */
  eof?: boolean;
}

/** True when `line` starts the next file op (or ends the patch).
 * Note: `*** End of File` is a *hunk* seek marker, not a section end — only
 * `*** End File` closes a file op. */
function isPatchSectionEnd(line: string | undefined): boolean {
  if (line === undefined) return true;
  return (
    line === "*** End File" ||
    line === "*** End Patch" ||
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Update File: ") ||
    line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Move to: ")
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
    for (const prefix of [
      "*** Add File: ",
      "*** Update File: ",
      "*** Delete File: ",
      "*** Move to: ",
    ]) {
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
      let moveTo: string | undefined;
      if (i < end && rawLines[i]!.startsWith("*** Move to: ")) {
        moveTo = rawLines[i]!.slice("*** Move to: ".length).trim();
        i++;
      }
      const hunks: Hunk[] = [];
      let current: Hunk | null = null;
      while (i < end && !isPatchSectionEnd(rawLines[i])) {
        const h = rawLines[i]!;
        if (h === "*** End of File") {
          // Start a new hunk that prefers matching from EOF.
          current = { lines: [], eof: true };
          hunks.push(current);
          i++;
          continue;
        }
        if (h.startsWith("@@")) {
          // Start a new hunk. Text after `@@` is a single-line change_context
          // anchor; used when the full ctx+del block is ambiguous.
          const anchor = h.slice(2).trim();
          current = { lines: [], changeContext: anchor || undefined };
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
          current.lines.push({ type: "ctx", text: "" });
        } else {
          current.lines.push({ type: "ctx", text: h });
        }
        i++;
      }
      i = consumeOptionalEndFile(rawLines, i, end);
      ops.push({ kind: "update", path, moveTo, hunks });
    } else if (line === "*** End File") {
      // Stray End File between ops — ignore.
      i++;
    } else {
      throw new Error(`unexpected line in patch: ${line}`);
    }
  }
  return ops;
}

/**
 * Splice `insert` bodies into `lines` at `start`, deleting `deleteCount`
 * entries. Untouched lines keep their original CR/LF/CRLF bytes; new lines use
 * the replaced region's EOL when present, else the file's dominant EOL.
 */
function spliceLinesWithEol(
  lines: LineWithEol[],
  start: number,
  deleteCount: number,
  insert: string[],
  fileEol: string,
): string {
  const region = lines.slice(start, start + deleteCount);
  const fallbackEol =
    region.find((l) => l.eol.length > 0)?.eol ??
    lines[start - 1]?.eol ??
    fileEol;
  const next: LineWithEol[] = insert.map((body, i) => {
    if (i === insert.length - 1) {
      if (region.length > 0 && region[region.length - 1]!.eol === "" && i >= region.length - 1) {
        return { body, eol: "" };
      }
      if (deleteCount === 0 && start >= lines.length) {
        // Append at EOF: mid-lines already got fallbackEol; last line has no
        // trailing newline unless the file previously ended with one (handled
        // by the caller ensuring the prior last line has an eol).
        return { body, eol: "" };
      }
      if (deleteCount === 0 && start < lines.length) {
        return { body, eol: fileEol };
      }
      return { body, eol: fallbackEol };
    }
    return { body, eol: fallbackEol };
  });
  const out = [...lines.slice(0, start), ...next, ...lines.slice(start + deleteCount)];
  return out.map((l) => l.body + l.eol).join("");
}

/** Apply a single hunk to a file's text. Returns the new text or throws. */
export function applyHunk(original: string, hunk: Hunk): string {
  const lines = splitLinesWithEol(original);
  const bodies = lines.map((l) => l.body);
  const fileEol = detectLineEnding(original);
  // Optional @@ change_context: narrow the search window to after that line.
  let searchFrom = 0;
  if (hunk.changeContext && hunk.changeContext.length > 0) {
    const anchor = findChangeContext(bodies, hunk.changeContext, hunk.eof === true);
    if (anchor < 0) {
      throw new Error(
        `hunk did not apply: @@ context not found: ${JSON.stringify(hunk.changeContext)}`,
      );
    }
    searchFrom = anchor + 1;
  }

  // Build a search signature: the sequence of ctx + del lines (in order).
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
    // Pure insertion — append at end (or after @@ anchor).
    if (hunk.changeContext) {
      return spliceLinesWithEol(lines, searchFrom, 0, replacement, fileEol);
    }
    const withNl = [...lines];
    const last = withNl[withNl.length - 1];
    if (last && last.eol === "" && (last.body.length > 0 || withNl.length > 1)) {
      // Ensure a newline before appending so new lines are separate.
      withNl[withNl.length - 1] = { body: last.body, eol: fileEol };
    }
    return spliceLinesWithEol(withNl, withNl.length, 0, replacement, fileEol);
  }

  const hay = bodies.slice(searchFrom);
  let located = findUniqueSubArray(hay, searchSig, hunk.eof === true);
  if (located.tier === "miss") {
    located = findUniqueSubArrayTolerant(hay, searchSig, hunk.eof === true);
  }
  if (located.tier === "miss") {
    located = findUniqueSubArrayTypographic(hay, searchSig, hunk.eof === true);
  }
  if (located.tier === "miss" || located.index < 0) {
    // Same closest-window hint as edit_file — avoids an extra read_file round-trip.
    const closest = closestSnippet(hay.join("\n"), searchSig.join("\n"));
    throw new Error(
      `hunk did not apply: context/removed lines not found. ` +
        `Expected: ${JSON.stringify(searchSig.slice(0, 3))}…` +
        (closest ? `\nClosest in file:\n${closest}` : ""),
    );
  }
  if (located.tier === "ambiguous") {
    throw new Error(
      `hunk did not apply: ambiguous match (${located.count} occurrences). ` +
        `Add more context lines or an @@ anchor so the hunk matches exactly once.`,
    );
  }
  const start = located.index + searchFrom;

  // Prefer original ctx line bodies (preserves whitespace the tolerant tier
  // may have folded); use patch `+` lines as-is for additions.
  const rebuilt: string[] = [];
  let k = 0;
  for (const l of hunk.lines) {
    if (l.type === "ctx") {
      rebuilt.push(bodies[start + k]!);
      k++;
    } else if (l.type === "del") {
      k++;
    } else {
      rebuilt.push(l.text);
    }
  }
  return spliceLinesWithEol(lines, start, searchSig.length, rebuilt, fileEol);
}

/** Locate a single-line @@ change_context anchor. */
function findChangeContext(hay: string[], needle: string, fromEnd: boolean): number {
  const norm = (s: string) => s.replace(/^\s+|\s+$/g, "");
  const target = norm(needle);
  if (fromEnd) {
    for (let i = hay.length - 1; i >= 0; i--) {
      if (norm(hay[i]!) === target || hay[i]!.includes(needle)) return i;
    }
  } else {
    for (let i = 0; i < hay.length; i++) {
      if (norm(hay[i]!) === target || hay[i]!.includes(needle)) return i;
    }
  }
  return -1;
}

type LocateResult = {
  index: number;
  tier: "exact" | "tolerant" | "typographic" | "ambiguous" | "miss";
  count: number;
};

/** Collect every start index where `needle` matches under `matchAt`. */
function locateAll(
  hay: string[],
  needle: string[],
  matchAt: (i: number) => boolean,
  fromEnd: boolean,
): number[] {
  if (needle.length === 0) return [0];
  const hits: number[] = [];
  if (fromEnd) {
    for (let i = hay.length - needle.length; i >= 0; i--) {
      if (matchAt(i)) hits.push(i);
    }
  } else {
    for (let i = 0; i <= hay.length - needle.length; i++) {
      if (matchAt(i)) hits.push(i);
    }
  }
  return hits;
}

function uniqueFromHits(
  hits: number[],
  tier: LocateResult["tier"],
): LocateResult {
  if (hits.length === 0) return { index: -1, tier: "miss", count: 0 };
  if (hits.length > 1) {
    return { index: hits[0]!, tier: "ambiguous", count: hits.length };
  }
  return { index: hits[0]!, tier, count: 1 };
}

function findUniqueSubArray(hay: string[], needle: string[], fromEnd = false): LocateResult {
  const matchAt = (i: number): boolean => {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) return false;
    }
    return true;
  };
  return uniqueFromHits(locateAll(hay, needle, matchAt, fromEnd), "exact");
}

function findUniqueSubArrayTolerant(
  hay: string[],
  needle: string[],
  fromEnd = false,
): LocateResult {
  const norm = (s: string) => s.replace(/^\s+|\s+$/g, "");
  const matchAt = (i: number): boolean => {
    for (let j = 0; j < needle.length; j++) {
      if (norm(hay[i + j]!) !== norm(needle[j]!)) return false;
    }
    return true;
  };
  return uniqueFromHits(locateAll(hay, needle, matchAt, fromEnd), "tolerant");
}

/** Fold smart/curly quotes → straight, Unicode dashes → hyphen-minus, exotic
 * spaces → plain space, collapse inner whitespace runs, and trim ends, per
 * line. Used only after exact and whitespace-tolerant matches have failed. */
function findUniqueSubArrayTypographic(
  hay: string[],
  needle: string[],
  fromEnd = false,
): LocateResult {
  const norm = (s: string) =>
    s
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
      .replace(/[\t ]+/g, " ")
      .replace(/^\s+|\s+$/g, "");
  const matchAt = (i: number): boolean => {
    for (let j = 0; j < needle.length; j++) {
      if (norm(hay[i + j]!) !== norm(needle[j]!)) return false;
    }
    return true;
  };
  return uniqueFromHits(locateAll(hay, needle, matchAt, fromEnd), "typographic");
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
    "Multi-file patch: hunks are computed against current file contents first " +
    "(no writes if any hunk fails); commit then writes files sequentially " +
    "(not rolled back mid-commit). Prefer when several files or hunks change together. " +
    "Envelope: `*** Begin Patch` … `*** End Patch` with `*** Add File: path` (create only — existing path refused), " +
    "`*** Delete File: path`, or `*** Update File: path` (+ optional `*** Move to: newpath`) + `@@` hunks " +
    "(` `/`-`/`+` lines; `@@ anchor` narrows location; `*** End of File` seeks from EOF). " +
    "On hunk failure: adjust context from the error — do not resubmit the same patch. " +
    "Do not mix with edit_file/write_file on the same path in the same fix set — re-patch instead.",
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
      const guard = await guardPath(ctx, op.path, "write");
      if (guard) return guard;
      const delivery = await guardDeliveryWrite(ctx, op.path);
      if (delivery) return delivery;
      if (op.moveTo) {
        const g2 = await guardPath(ctx, op.moveTo, "write");
        if (g2) return g2;
        const d2 = await guardDeliveryWrite(ctx, op.moveTo);
        if (d2) return d2;
      }
    }

    // Lock every path the patch will touch (incl. move destinations) for the
    // read→compute→commit window so parallel workers cannot interleave.
    const lockPaths: string[] = [];
    for (const op of ops) {
      lockPaths.push(resolve(ctx.cwd, op.path));
      if (op.moveTo) lockPaths.push(resolve(ctx.cwd, op.moveTo));
    }

    return withWriteLocks(lockPaths, async () => {
    // 2. Read all files that will be updated (so we can roll back cleanly).
    const originals = new Map<string, string>();
    const originalHadBom = new Map<string, boolean>();
    for (const op of ops) {
      if (op.kind === "update") {
        try {
          const raw = await readFile(resolve(ctx.cwd, op.path), "utf-8");
          const stripped = stripUtf8Bom(raw);
          originals.set(op.path, stripped.text);
          originalHadBom.set(op.path, stripped.hadBom);
        } catch (err) {
          return {
            content: `failed to read ${op.path}: ${(err as Error).message}`,
            isError: true,
          };
        }
        if (op.moveTo) {
          const dest = resolve(ctx.cwd, op.moveTo);
          if (existsSync(dest)) {
            return {
              content:
                `apply_patch: Move to ${op.moveTo} already exists. ` +
                `Remove/rename the destination first, or pick a new path.`,
              isError: true,
            };
          }
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
    const writes: {
      path: string;
      content: string;
      added: number;
      removed: number;
      fromPath?: string;
    }[] = [];
    const deletes: { path: string; removed: number }[] = [];
    const adds: { path: string; content: string; added: number }[] = [];
    // Keyed by source path; moveTo is recorded separately at flush.
    const pendingUpdates = new Map<
      string,
      { content: string; added: number; removed: number; moveTo?: string }
    >();
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
              throw new Error(`${op.path} hunk #${hi + 1}: ${(err as Error).message}`);
            }
          }
          pendingUpdates.set(op.path, {
            content: working,
            added,
            removed,
            moveTo: op.moveTo ?? prev?.moveTo,
          });
        }
      }
      for (const [path, u] of pendingUpdates) {
        const content = restoreUtf8Bom(u.content, originalHadBom.get(path) === true);
        if (u.moveTo) {
          writes.push({
            path: u.moveTo,
            content,
            added: u.added,
            removed: u.removed,
            fromPath: path,
          });
          deletes.push({ path, removed: 0 });
        } else {
          writes.push({ path, content, added: u.added, removed: u.removed });
        }
      }
    } catch (err) {
      return { content: `apply failed (no files written): ${(err as Error).message}`, isError: true };
    }

    // 4. Commit: adds → updates/moves → deletes.
    const summary: string[] = [];
    const commitTotal = adds.length + writes.length + deletes.filter((d) => !writes.some((w) => w.fromPath === d.path)).length;
    let commitIndex = 0;
    const emitFileDelta = async (
      absPath: string,
      strategy: string,
      occurrences: number,
    ): Promise<void> => {
      if (!ctx.emitEvent) return;
      try {
        await ctx.emitEvent({
          type: "edit_delta",
          path: absPath,
          index: commitIndex,
          total: Math.max(commitTotal, 1),
          strategy,
          occurrences,
        });
      } catch {
        /* best-effort UI */
      }
      commitIndex++;
    };
    try {
      for (const a of adds) {
        const p = resolve(ctx.cwd, a.path);
        await mkdir(dirname(p), { recursive: true });
        await atomicWriteFile(p, a.content, "utf-8");
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
        await emitFileDelta(p, "add", a.added);
      }
      for (const w of writes) {
        const p = resolve(ctx.cwd, w.path);
        await mkdir(dirname(p), { recursive: true });
        await atomicWriteFile(p, w.content, "utf-8");
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
        if (w.fromPath) {
          summary.push(
            `~ moved ${w.fromPath} → ${w.path}${stats ? ` (${stats})` : ""}`,
          );
          await emitFileDelta(p, "move", w.added + w.removed);
        } else {
          summary.push(`~ updated ${w.path}${stats ? ` (${stats})` : ""}`);
          await emitFileDelta(p, "update", w.added + w.removed);
        }
      }
      for (const d of deletes) {
        const p = resolve(ctx.cwd, d.path);
        if (existsSync(p)) await rm(p);
        // Skip summarizing pure rename sources that already appear as "moved".
        if (writes.some((w) => w.fromPath === d.path)) continue;
        const stats = formatLineStats(0, d.removed);
        summary.push(`- deleted ${d.path}${stats ? ` (${stats})` : ""}`);
        await emitFileDelta(p, "delete", d.removed);
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
      content: `applied ${ops.length} file operation(s):\n${summary.join("\n")}${note}`,
    };
    });
  },
};
