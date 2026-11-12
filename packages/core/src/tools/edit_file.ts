// edit_file: search/replace edits with fallback match strategies (exact,
// whitespace-tolerant, typographic-tolerant, unique-line, regex) and an
// optional transactional multi-edit mode.

import { z } from "zod";
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardDeliveryWrite, guardFreshWrite, guardPath } from "./_shared.js";
import { hashFileContent } from "../fsObservation.js";

/** Detect the dominant line ending so we can restore it after editing. */
export function detectLineEnding(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

const singleEdit = z.object({
  search: z.string().describe("Exact text to find."),
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
    search: z.string().optional().describe("Exact text to find (single-edit mode)."),
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
  const global = args.global_replace ?? false;

  if (args.regex) {
    const re = new RegExp(args.search, global ? "g" : "");
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

 // 1. Exact match.
  {
    const occ = countOccurrences(original, args.search);
    if (occ > 0) {
      if (!global && occ > 1) {
        return {
          ok: false,
          strategy: "exact",
          occurrences: occ,
          message: `ambiguous: ${occ} occurrences (pass global_replace=true to replace all)`,
        };
      }
      return {
        ok: true,
        strategy: "exact",
        occurrences: global ? occ : 1,
        message: splitReplace(original, args.search, args.replace, global),
      };
    }
  }

 // 2. Trimmed-line match.
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
      if (!global && blocks.length > 1) {
        return {
          ok: false,
          strategy: "trimmed-lines",
          occurrences: blocks.length,
          message: `ambiguous after whitespace trim (${blocks.length} blocks)`,
        };
      }
      return {
        ok: true,
        strategy: "trimmed-lines",
        occurrences: blocks.length,
        message: applyBlockReplacements(original, args.replace, blocks),
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

  return {
    ok: false,
    strategy: "none",
    occurrences: 0,
    message: "search text not found",
  };
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

function splitReplace(
  original: string,
  search: string,
  replace: string,
  globalReplace: boolean
): string {
  if (globalReplace) {
    return original.split(search).join(replace);
  }
  const idx = original.indexOf(search);
  return original.slice(0, idx) + replace + original.slice(idx + search.length);
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
  const lines = original.split(/\r?\n/);
 // Apply in reverse so indices stay stable.
  const sorted = [...blocks].sort((a, b) => b.start - a.start);
  for (const b of sorted) {
    lines.splice(b.start, b.end - b.start, ...replacement.split(/\r?\n/));
  }
  return lines.join("\n");
}

/** Line-count delta between two texts, for the result summary. */
function lineDelta(before: string, after: string): { added: number; removed: number } {
  const a = before.length === 0 ? 0 : before.split(/\r?\n/).length;
  const b = after.length === 0 ? 0 : after.split(/\r?\n/).length;
  return b >= a ? { added: b - a, removed: 0 } : { added: 0, removed: a - b };
}

export const editFileTool: ToolDef<typeof schema> = {
  name: "edit_file",
  description:
    "Search/replace edit on one file (prefer over `write_file`). Understand the target " +
    "behavior (specs, images, failing tests, surrounding code) before editing. Single: " +
    "`search`/`replace`; multi: `edits: [{search, replace}]` applied atomically in order. " +
    "Matches exact → trimmed-line → typographic (smart quotes / dashes / spaces) → unique " +
    "line → optional `regex`. Ambiguous matches fail unless `global_replace`. Copy search " +
    "text from `read_file` without line-number prefixes. Must have read the file earlier in " +
    "this session.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path, "write");
    if (guard) return guard;
    const delivery = await guardDeliveryWrite(ctx, input.path);
    if (delivery) return delivery;
    const p = resolve(ctx.cwd, input.path);
    let original: string;
    let preStat: { mtimeMs: number; size: number } | null = null;
    try {
      const st = await stat(p);
      preStat = { mtimeMs: st.mtimeMs, size: st.size };
      original = await readFile(p, "utf-8");
    } catch (err) {
      return {
        content: `failed to read ${p}: ${(err as Error).message}`,
        isError: true,
      };
    }

    // Read-before-write + staleness guard: edit_file always targets an
    // existing file, so an unobserved or externally-changed file is blocked.
    // We already hold the current content, so pass it for the content-equality
    // fallback (a jittered mtime on unchanged bytes does not block the edit).
    const fresh = await guardFreshWrite(ctx, p, preStat, original);
    if (fresh) return fresh;

    // Preserve the file's dominant line ending — the edit strategies are a
    // mix (some keep original \r\n, some normalise to \n), so normalise the
    // result to LF first, then restore the detected ending uniformly.
    const eol = detectLineEnding(original);

    const edits =
      input.edits && input.edits.length > 0
        ? input.edits
        : [{ search: input.search!, replace: input.replace ?? "", global_replace: input.global_replace, regex: input.regex }];

 // Apply in order against a working copy; transactional — any failure
 // aborts without touching disk.
    let working = original;
    const applied: string[] = [];
    // Per-edit outcomes to stream as `edit_delta` AFTER a successful write (not
    // during the loop — the batch is transactional, so emitting mid-loop would
    // narrate edits that a later failure rolls back).
    const deltas: { strategy: string; occurrences: number }[] = [];
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]!;
      const outcome = applyEdit(working, {
        search: e.search,
        replace: e.replace,
        global_replace: e.global_replace,
        regex: e.regex,
      });
      if (!outcome.ok) {
        const prefix = edits.length > 1 ? `edit #${i + 1} ` : "";
        return {
          content:
            `edit_file failed (${prefix}${outcome.strategy}): ${outcome.message}. ` +
            `No changes were written.`,
          isError: true,
        };
      }
      working = outcome.message;
      deltas.push({ strategy: outcome.strategy, occurrences: outcome.occurrences });
      applied.push(
        `#${i + 1} ${outcome.strategy} (${outcome.occurrences} occurrence${outcome.occurrences === 1 ? "" : "s"})`
      );
    }

    const normalized = working.replace(/\r\n/g, "\n");
    const written = eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
    await writeFile(p, written, "utf-8");
    // Re-observe so a follow-up edit this session isn't flagged stale against
    // our own write. Carry the written content's hash for the fallback.
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
    // Stream each applied edit now that the write succeeded. Informational,
    // UI-only (ctx.emitEvent bypasses the provider transcript). Best-effort.
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
          /* best-effort; never fail the edit on a UI event */
        }
      }
    }
    const delta = lineDelta(original, working);
    const deltaStr =
      delta.added > 0 ? `+${delta.added} lines` : delta.removed > 0 ? `-${delta.removed} lines` : "same line count";
    return {
      content: `applied ${applied.length} edit(s) to ${p} (${deltaStr})\n${applied.join("\n")}`,
    };
  },
};
