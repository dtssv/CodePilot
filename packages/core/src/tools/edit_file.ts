// edit_file: search/replace edits with fallback match strategies (exact,
// whitespace-tolerant, typographic-tolerant, unique-line, regex) and an
// optional transactional multi-edit mode.

import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardDeliveryWrite, guardPath } from "./_shared.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { withWriteLocks } from "./writeLock.js";
import { restoreUtf8Bom, stripUtf8Bom } from "./utf8Bom.js";
import { hashFileContent } from "../workspace/fsObservation.js";

/** Dominant line ending in `text` (`\r\n` when CRLF is more common, else `\n`). */
export function detectLineEnding(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

/** One logical line plus the ending bytes that followed it (empty if EOF). */
export interface LineWithEol {
  body: string;
  eol: string;
}

/** Split `text` into lines while retaining each line's original CR/LF/CRLF bytes. */
export function splitLinesWithEol(text: string): LineWithEol[] {
  const parts: LineWithEol[] = [];
  const re = /\r\n|\n|\r/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    parts.push({ body: text.slice(last, m.index), eol: m[0]! });
    last = m.index + m[0]!.length;
  }
  if (last < text.length || parts.length === 0) {
    parts.push({ body: text.slice(last), eol: "" });
  }
  return parts;
}

function joinLinesWithEol(lines: LineWithEol[]): string {
  return lines.map((l) => l.body + l.eol).join("");
}

const singleEdit = z.object({
  search: z
    .string()
    .min(1)
    .describe("Exact text to find (must be non-empty)."),
  replace: z.string().describe("Replacement text."),
  global_replace: z
    .boolean()
    .optional()
    .describe("Replace every occurrence (default false)."),
  regex: z
    .boolean()
    .optional()
    .describe("Interpret `search` as a regular expression (default false)."),
});

const schema = z
  .object({
    path: z.string().describe("File path to edit."),
    search: z
      .string()
      .min(1)
      .optional()
      .describe("Exact text to find (single-edit mode; must be non-empty when set)."),
    replace: z.string().optional().describe("Replacement text (single-edit mode)."),
    global_replace: z
      .boolean()
      .optional()
      .describe("Replace every occurrence (default false)."),
    regex: z
      .boolean()
      .optional()
      .describe("Interpret `search` as a regular expression (default false)."),
    edits: z
      .array(singleEdit)
      .optional()
      .describe(
        "Multi-edit mode: an ordered list of search/replace pairs applied " +
          "atomically. Mutually exclusive with the top-level search/replace."
      ),
  })
  .refine(
    (v) => (v.edits && v.edits.length > 0) !== (v.search !== undefined),
    { message: "provide either `edits` or top-level `search`/`replace`, not both" }
  );

export interface EditOutcome {
  ok: boolean;
  strategy: string;
  occurrences: number;
  message: string;
}

/** Pure: given the current file text and inputs, produce the new text. */
export function applyEdit(
  original: string,
  args: { search: string; replace: string; global_replace?: boolean; regex?: boolean }
): EditOutcome {
  if (args.search === "") {
    return {
      ok: false,
      strategy: "validate",
      occurrences: 0,
      message: "search must not be empty",
    };
  }
  // Refuse no-op edits that would only rewrite the file.
  if (!args.regex && args.search === args.replace) {
    return {
      ok: false,
      strategy: "validate",
      occurrences: 0,
      message: "search and replace are identical — no changes to apply",
    };
  }
  const global = args.global_replace ?? false;

  if (args.regex) {
    let re: RegExp;
    try {
      re = new RegExp(args.search, global ? "g" : "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        strategy: "regex",
        occurrences: 0,
        message: `invalid regex: ${msg}`,
      };
    }
    if (!global) {
      const m = re.exec(original);
      if (!m) return { ok: false, strategy: "regex", occurrences: 0, message: "no match" };
      return {
        ok: true,
        strategy: "regex",
        occurrences: 1,
        message: original.replace(re, args.replace),
      };
    }
    const matches = original.match(new RegExp(args.search, "g"));
    const occ = matches?.length ?? 0;
    if (occ === 0) return { ok: false, strategy: "regex", occurrences: 0, message: "no match" };
    return {
      ok: true,
      strategy: "regex",
      occurrences: occ,
      message: original.replace(re, args.replace),
    };
  }

 // 1. Exact match on an LF view so CRLF / mixed endings still match model
 // search strings, then splice back into the original bytes per region.
  {
    const viaView = replaceViaLfView(original, args.search, args.replace, global);
    if (viaView) return viaView;
  }

 // 2. Trimmed-line match — hint only, never write.
  // Matching stays exact: collapsing leading/trailing whitespace mis-edits
  // indent-sensitive languages. Surface the candidate so the model can fix
  // the search string (same spirit as an ambiguous miss).
  {
    const normSearch = normaliseLines(args.search);
    const normSearchLines = normSearch.split("\n");
    const lines = original.split(/\r?\n/);
    const blocks: { start: number; end: number }[] = [];
    for (let i = 0; i + normSearchLines.length <= lines.length; i++) {
      const window = lines.slice(i, i + normSearchLines.length).map(normaliseLine);
      if (window.join("\n") === normSearch) {
        blocks.push({ start: i, end: i + normSearchLines.length });
        if (!global) break;
      }
    }
    if (blocks.length > 0) {
      return {
        ok: false,
        strategy: "trimmed-lines",
        occurrences: blocks.length,
        message:
          blocks.length > 1
            ? `ambiguous after whitespace trim (${blocks.length} blocks); tighten search to exact indentation`
            : `whitespace-trimmed match at line ${blocks[0]!.start + 1} not applied ` +
              `(indent-sensitive); resubmit search with the file's exact indentation`,
      };
    }
  }

 // 3. Typographic-tolerant line match: fold smart quotes / Unicode dashes /
 // exotic spaces and collapse inner whitespace, per line. Located by the
 // normalized form; the ORIGINAL source lines are what get replaced.
  {
    const normSearchLines = args.search.split(/\r?\n/).map(normaliseTypography);
    const lines = original.split(/\r?\n/);
    const blocks: { start: number; end: number }[] = [];
    for (let i = 0; i + normSearchLines.length <= lines.length; i++) {
      const window = lines.slice(i, i + normSearchLines.length).map(normaliseTypography);
      if (window.join("\n") === normSearchLines.join("\n")) {
        blocks.push({ start: i, end: i + normSearchLines.length });
        if (!global) break;
      }
    }
    if (blocks.length > 0) {
      if (!global && blocks.length > 1) {
        return {
          ok: false,
          strategy: "typographic",
          occurrences: blocks.length,
          message: `ambiguous after typography normalization (${blocks.length} blocks)`,
        };
      }
      return {
        ok: true,
        strategy: "typographic",
        occurrences: blocks.length,
        message: applyBlockReplacements(original, args.replace, blocks),
      };
    }
  }

 // 4. Single-line unique search.
  if (!args.search.includes("\n")) {
    const lines = original.split(/\r?\n/);
    const idx = lines.findIndex((l) => l === args.search);
    if (idx >= 0) {
 // Confirm uniqueness.
      const occ = lines.filter((l) => l === args.search).length;
      if (occ === 1 || global) {
        return {
          ok: true,
          strategy: "single-line",
          occurrences: occ,
          message: applyBlockReplacements(
            original,
            args.replace,
            [{ start: idx, end: idx + 1 }]
          ),
        };
      }
      return {
        ok: false,
        strategy: "single-line",
        occurrences: occ,
        message: `ambiguous: ${occ} identical lines`,
      };
    }
  }

  let message = "search text not found";
  if (args.replace && original.includes(args.replace)) {
    message +=
      "; replace text is already in the file, so this edit may already be applied";
  } else {
    const closest = closestSnippet(original, args.search);
    if (closest) {
      message += `; closest match:\n${closest}`;
    }
  }
  return {
    ok: false,
    strategy: "none",
    occurrences: 0,
    message,
  };
}

/** Best-effort nearby fragment for a failed exact search (≤12 lines, 200 chars). */
export function closestSnippet(original: string, search: string): string | null {
  const searchLines = search.split(/\r?\n/).slice(0, 12);
  if (searchLines.length === 0 || searchLines.every((l) => l === "")) return null;
  const lines = original.split(/\r?\n/);
  const window = searchLines.length;
  if (window > lines.length) return null;
  let bestScore = 0;
  let bestStart = 0;
  for (let i = 0; i + window <= lines.length; i++) {
    let score = 0;
    for (let j = 0; j < window; j++) {
      const a = normaliseLine(lines[i + j]!);
      const b = normaliseLine(searchLines[j]!);
      if (a === b) score += 2;
      else if (b.length > 0 && (a.includes(b) || b.includes(a))) score += 1;
      else {
        // Token overlap for near-misses ("hello wrld" ≈ "hello world").
        for (const tok of b.split(/\s+/)) {
          if (tok.length > 2 && a.includes(tok)) score += 1;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }
  // Require at least one soft match so we don't echo an unrelated window.
  if (bestScore < 1) return null;
  return lines
    .slice(bestStart, bestStart + window)
    .map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l))
    .join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (pos <= haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

/**
 * Match `search` against a CRLF→LF view of `source`, map hit offsets back to
 * the original buffer, and rebuild each replaced span so untouched regions keep
 * their original CR/LF/CRLF bytes. Returns null when there is no match.
 */
export function replaceViaLfView(
  source: string,
  search: string,
  replace: string,
  globalReplace: boolean,
): EditOutcome | null {
  const view = source.replace(/\r\n/g, "\n");
  const searchLf = search.replace(/\r\n/g, "\n");
  const replaceLf = replace.replace(/\r\n/g, "\n");
  if (searchLf.length === 0) return null;

  // For each LF index, how many extra `\r` bytes precede it in `source`.
  const removed: number[] = [];
  for (const m of source.matchAll(/\r\n/g)) {
    removed.push(m.index! - removed.length);
  }
  const toSource = (lfOffset: number): number =>
    lfOffset + removed.filter((at) => at < lfOffset).length;

  const hits: { start: number; end: number }[] = [];
  let pos = 0;
  while (pos <= view.length) {
    const idx = view.indexOf(searchLf, pos);
    if (idx < 0) break;
    hits.push({ start: toSource(idx), end: toSource(idx + searchLf.length) });
    if (!globalReplace) break;
    pos = idx + searchLf.length;
  }
  if (hits.length === 0) return null;
  if (!globalReplace && countOccurrences(view, searchLf) > 1) {
    return {
      ok: false,
      strategy: "exact",
      occurrences: countOccurrences(view, searchLf),
      message: `ambiguous: ${countOccurrences(view, searchLf)} occurrences (pass global_replace=true to replace all)`,
    };
  }

  const fileEol = detectLineEnding(source);
  let out = source;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i]!;
    const region = source.slice(h.start, h.end);
    const spliced = withRegionEndings(region, replaceLf, detectLineEnding(region) || fileEol);
    out = out.slice(0, h.start) + spliced + out.slice(h.end);
  }
  return {
    ok: true,
    strategy: "exact",
    occurrences: hits.length,
    message: out,
  };
}

/**
 * Join `replacement` (LF-separated) using line-ending bytes from `region` so
 * unchanged context lines inside a match keep their original endings.
 */
export function withRegionEndings(region: string, replacement: string, fallback: string): string {
  const before = splitLinesWithEol(region);
  const afterBodies = replacement.split("\n");
  const endings = before.map((l) => l.eol);
  return afterBodies
    .map((line, index) => {
      if (index === afterBodies.length - 1) return line;
      return line + (endings[index] && endings[index]!.length > 0 ? endings[index]! : fallback);
    })
    .join("");
}

function normaliseLine(s: string): string {
  return s.replace(/\s+$/g, "").replace(/^\s+/g, "");
}

function normaliseLines(s: string): string {
  return s.split(/\r?\n/).map(normaliseLine).join("\n");
}

/**
 * Typographic-tolerant match tier: fold smart quotes, Unicode dashes, and
 * exotic spaces to ASCII, collapse inner whitespace. Matching locates by this
 * normalized form, but the replacement splices into the ORIGINAL source lines
 * — no source chars change except the replaced block. */
function normaliseTypography(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\t ]+/g, " ")
    .replace(/^\s+|\s+$/g, "");
}

function applyBlockReplacements(
  original: string,
  replacement: string,
  blocks: { start: number; end: number }[]
): string {
  const lines = splitLinesWithEol(original);
  // Apply in reverse so indices stay stable.
  const sorted = [...blocks].sort((a, b) => b.start - a.start);
  for (const b of sorted) {
    const region = lines.slice(b.start, b.end);
    const fallbackEol =
      region.find((l) => l.eol.length > 0)?.eol ?? detectLineEnding(original);
    const bodies = replacement.split(/\r?\n/);
    const next: LineWithEol[] = bodies.map((body, i) => {
      const fromRegion = region[i]?.eol;
      // Last replacement line: keep empty eol when the region had a final
      // partial line (no trailing newline); otherwise reuse region/fallback.
      if (i === bodies.length - 1) {
        if (region.length > 0 && region[region.length - 1]!.eol === "" && i >= region.length - 1) {
          return { body, eol: "" };
        }
        return { body, eol: fromRegion ?? fallbackEol };
      }
      return { body, eol: fromRegion && fromRegion.length > 0 ? fromRegion : fallbackEol };
    });
    lines.splice(b.start, b.end - b.start, ...next);
  }
  return joinLinesWithEol(lines);
}

/** Line-count delta between two texts, for the result summary. */
function lineDelta(before: string, after: string): { added: number; removed: number } {
  const a = before.length === 0 ? 0 : before.split(/\r?\n/).length;
  const b = after.length === 0 ? 0 : after.split(/\r?\n/).length;
  return b >= a ? { added: b - a, removed: 0 } : { added: 0, removed: a - b };
}

function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Map line-index blocks to byte ranges on `original` (split on \\r?\\n). */
function lineBlocksToByteRanges(
  original: string,
  blocks: { start: number; end: number }[],
): { start: number; end: number }[] {
  const lines = splitLinesWithEol(original);
  const starts: number[] = [];
  let off = 0;
  for (const line of lines) {
    starts.push(off);
    off += line.body.length + line.eol.length;
  }
  return blocks.map((b) => {
    const start = starts[b.start] ?? original.length;
    const last = Math.max(b.start, b.end - 1);
    const endLine = lines[last];
    const end = endLine
      ? (starts[last] ?? 0) + endLine.body.length + endLine.eol.length
      : start;
    return { start, end };
  });
}

/**
 * Locate replaceable byte ranges on `original` for one edit (same strategies
 * as {@link applyEdit}). Returns null when the strategy would not write.
 */
export function locateEditRanges(
  original: string,
  args: { search: string; replace: string; global_replace?: boolean; regex?: boolean },
):
  | { ok: true; strategy: string; occurrences: number; ranges: { start: number; end: number }[]; replace: string }
  | { ok: false; strategy: string; occurrences: number; message: string } {
  const probe = applyEdit(original, args);
  if (!probe.ok) {
    return {
      ok: false,
      strategy: probe.strategy,
      occurrences: probe.occurrences,
      message: probe.message,
    };
  }
  const global = args.global_replace ?? false;
  const replace = args.replace;

  if (args.regex) {
    const re = new RegExp(args.search, global ? "g" : "");
    const ranges: { start: number; end: number }[] = [];
    if (!global) {
      const m = re.exec(original);
      if (m && m.index !== undefined) {
        ranges.push({ start: m.index, end: m.index + m[0].length });
      }
    } else {
      for (const m of original.matchAll(new RegExp(args.search, "g"))) {
        if (m.index !== undefined) {
          ranges.push({ start: m.index, end: m.index + m[0].length });
        }
      }
    }
    return { ok: true, strategy: "regex", occurrences: ranges.length, ranges, replace };
  }

  {
    const view = original.replace(/\r\n/g, "\n");
    const searchLf = args.search.replace(/\r\n/g, "\n");
    if (searchLf.length > 0 && view.includes(searchLf)) {
      const removed: number[] = [];
      for (const m of original.matchAll(/\r\n/g)) {
        removed.push(m.index! - removed.length);
      }
      const toSource = (lfOffset: number): number =>
        lfOffset + removed.filter((at) => at < lfOffset).length;
      const ranges: { start: number; end: number }[] = [];
      let pos = 0;
      while (pos <= view.length) {
        const idx = view.indexOf(searchLf, pos);
        if (idx < 0) break;
        ranges.push({ start: toSource(idx), end: toSource(idx + searchLf.length) });
        if (!global) break;
        pos = idx + searchLf.length;
      }
      if (ranges.length > 0 && probe.strategy === "exact") {
        return { ok: true, strategy: "exact", occurrences: ranges.length, ranges, replace };
      }
    }
  }

  if (probe.strategy === "typographic" || probe.strategy === "single-line") {
    const lines = original.split(/\r?\n/);
    const blocks: { start: number; end: number }[] = [];
    if (probe.strategy === "single-line" && !args.search.includes("\n")) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === args.search) {
          blocks.push({ start: i, end: i + 1 });
          if (!global) break;
        }
      }
    } else {
      const normSearchLines = args.search.split(/\r?\n/).map(normaliseTypography);
      for (let i = 0; i + normSearchLines.length <= lines.length; i++) {
        const window = lines.slice(i, i + normSearchLines.length).map(normaliseTypography);
        if (window.join("\n") === normSearchLines.join("\n")) {
          blocks.push({ start: i, end: i + normSearchLines.length });
          if (!global) break;
        }
      }
    }
    if (blocks.length > 0) {
      return {
        ok: true,
        strategy: probe.strategy,
        occurrences: blocks.length,
        ranges: lineBlocksToByteRanges(original, blocks),
        replace,
      };
    }
  }

  // Fallback: single applyEdit result — treat whole-file replace as one span
  // only when search is unique under indexOf on LF view (should be rare).
  return {
    ok: false,
    strategy: probe.strategy,
    occurrences: probe.occurrences,
    message: `cannot locate non-overlapping ranges for strategy "${probe.strategy}"`,
  };
}

/**
 * Apply many edits against the **original** text (not a working copy). All
 * searches locate on `original`; overlapping ranges fail. Single-edit path
 * delegates to {@link applyEdit}.
 */
export function applyEditsOnOriginal(
  original: string,
  edits: Array<{ search: string; replace: string; global_replace?: boolean; regex?: boolean }>,
): {
  ok: boolean;
  message: string;
  strategy: string;
  occurrences: number;
  applied: { strategy: string; occurrences: number }[];
  result?: string;
} {
  if (edits.length === 0) {
    return { ok: false, message: "no edits", strategy: "validate", occurrences: 0, applied: [] };
  }
  if (edits.length === 1) {
    const outcome = applyEdit(original, edits[0]!);
    return {
      ok: outcome.ok,
      message: outcome.message,
      strategy: outcome.strategy,
      occurrences: outcome.occurrences,
      applied: outcome.ok
        ? [{ strategy: outcome.strategy, occurrences: outcome.occurrences }]
        : [],
      result: outcome.ok ? outcome.message : undefined,
    };
  }

  const planned: Array<{
    strategy: string;
    occurrences: number;
    ranges: { start: number; end: number }[];
    replace: string;
    editIndex: number;
  }> = [];

  for (let i = 0; i < edits.length; i++) {
    const loc = locateEditRanges(original, edits[i]!);
    if (!loc.ok) {
      return {
        ok: false,
        message: `edit #${i + 1} ${loc.strategy}: ${loc.message}`,
        strategy: loc.strategy,
        occurrences: loc.occurrences,
        applied: [],
      };
    }
    planned.push({ ...loc, editIndex: i });
  }

  // Flatten + sort ranges: O(n log n) adjacent check across distinct edits.
  {
    const flat: { start: number; end: number; editIndex: number }[] = [];
    for (const p of planned) {
      for (const r of p.ranges) flat.push({ start: r.start, end: r.end, editIndex: p.editIndex });
    }
    flat.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < flat.length; i++) {
      const prev = flat[i - 1]!;
      const cur = flat[i]!;
      if (prev.editIndex === cur.editIndex) continue;
      if (rangesOverlap(prev, cur)) {
        const a = Math.min(prev.editIndex, cur.editIndex) + 1;
        const b = Math.max(prev.editIndex, cur.editIndex) + 1;
        return {
          ok: false,
          message:
            `edit #${a} overlaps edit #${b} ` +
            `(regions must be disjoint on the original file)`,
          strategy: "overlap",
          occurrences: 0,
          applied: [],
        };
      }
    }
  }

  type Splice = { start: number; end: number; replace: string; editIndex: number };
  const splices: Splice[] = [];
  for (const p of planned) {
    const edit = edits[p.editIndex]!;
    for (const r of p.ranges) {
      const region = original.slice(r.start, r.end);
      const fileEol = detectLineEnding(original);
      let text: string;
      if (edit.regex === true) {
        // Expand $1 / $& against this match only (range is one regex hit).
        try {
          text = region.replace(new RegExp(edit.search), edit.replace);
        } catch {
          text = edit.replace;
        }
      } else {
        text = withRegionEndings(
          region,
          p.replace.replace(/\r\n/g, "\n"),
          detectLineEnding(region) || fileEol,
        );
      }
      splices.push({ start: r.start, end: r.end, replace: text, editIndex: p.editIndex });
    }
  }
  splices.sort((a, b) => b.start - a.start);

  let out = original;
  for (const s of splices) {
    out = out.slice(0, s.start) + s.replace + out.slice(s.end);
  }

  return {
    ok: true,
    message: out,
    strategy: "multi",
    occurrences: splices.length,
    applied: planned.map((p) => ({ strategy: p.strategy, occurrences: p.occurrences })),
    result: out,
  };
}

export const editFileTool: ToolDef<typeof schema> = {
  name: "edit_file",
  description:
    "Search/replace on one file (prefer over write_file). Single: search/replace; " +
    "multi: edits:[{search,replace}] applied atomically in order against the **original** file " +
    "(no overlapping regions) — batch related edits in one call. " +
    "`search` must match disk: copy from read_file without `N|`/`N:` line-number prefixes; " +
    "use the smallest unique string that cannot match elsewhere. " +
    "On miss/ambiguous: fix from the error (tighten context or set global_replace) — do not resubmit the same search.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path, "write");
    if (guard) return guard;
    const delivery = await guardDeliveryWrite(ctx, input.path);
    if (delivery) return delivery;
    const p = resolve(ctx.cwd, input.path);
    // Lock covers read→match→write so parallel workers cannot interleave.
    return withWriteLocks([p], async () => {
      let rawOriginal: string;
      let readStat: { mtimeMs: number; size: number };
      try {
        rawOriginal = await readFile(p, "utf-8");
        const st0 = await stat(p);
        readStat = { mtimeMs: st0.mtimeMs, size: st0.size };
      } catch (err) {
        return {
          content: `failed to read ${p}: ${(err as Error).message}`,
          isError: true,
        };
      }
      // Strip BOM for matching (model snippets from read_file rarely include it);
      // restore on write so UTF-8 BOM files stay BOM files.
      const { text: original, hadBom } = stripUtf8Bom(rawOriginal);

      // No fs_guard / requireObserved here: surgical edits gate on `search`
      // matching live disk. Blind full-replace (`write_file`) keeps the guard.

      const edits =
        input.edits && input.edits.length > 0
          ? input.edits
          : [{ search: input.search!, replace: input.replace ?? "", global_replace: input.global_replace, regex: input.regex }];

      // All edits locate against the **original** (no overlapping regions).
      const batch = applyEditsOnOriginal(original, edits);
      if (!batch.ok || batch.result === undefined) {
        return {
          content: `edit_file failed (${batch.strategy}): ${batch.message}. No changes were written.`,
          isError: true,
        };
      }
      const working = batch.result;
      const deltas = batch.applied;
      const applied = deltas.map(
        (d, i) =>
          `#${i + 1} ${d.strategy} (${d.occurrences} occurrence${d.occurrences === 1 ? "" : "s"})`,
      );

      if (working === original) {
        return {
          content: `edit_file: no changes to apply on ${p} (content already matched).`,
          isError: true,
        };
      }

      // Concurrent external modify while we held the plan (linter/user).
      try {
        const stNow = await stat(p);
        if (
          Math.abs(stNow.mtimeMs - readStat.mtimeMs) > 1 ||
          stNow.size !== readStat.size
        ) {
          const again = await readFile(p, "utf-8");
          if (again !== rawOriginal) {
            return {
              content:
                `edit_file failed: ${p} was modified on disk while applying the edit ` +
                `(FILE_UNEXPECTEDLY_MODIFIED). Re-read and retry.`,
              isError: true,
            };
          }
        }
      } catch {
        /* if re-stat fails, still attempt write */
      }

      const written = restoreUtf8Bom(working, hadBom);
      await atomicWriteFile(p, written, "utf-8");
      try {
        const st = await stat(p);
        ctx.reobserveFile?.(
          p,
          { mtimeMs: st.mtimeMs, size: st.size },
          hashFileContent(Buffer.from(written, "utf-8")),
        );
      } catch {
        /* best-effort */
      }
      if (ctx.emitEvent) {
        for (let i = 0; i < deltas.length; i++) {
          try {
            await ctx.emitEvent({
              type: "edit_delta",
              path: p,
              index: i,
              total: deltas.length,
              strategy: deltas[i]!.strategy,
              occurrences: deltas[i]!.occurrences,
            });
          } catch {
            /* best-effort */
          }
        }
      }
      const delta = lineDelta(original, working);
      const deltaStr =
        delta.added > 0 ? `+${delta.added} lines` : delta.removed > 0 ? `-${delta.removed} lines` : "same line count";
      const note = (await ctx.postWrite?.([p], ctx)) ?? "";
      // Diff is for permission preview / UI only — keep tool_result to a short summary.
      return {
        content:
          `applied ${applied.length} edit(s) to ${p} (${deltaStr})\n${applied.join("\n")}${note}`,
      };
    });
  },
};
