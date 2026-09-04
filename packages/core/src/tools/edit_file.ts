// edit_file: search/replace edits with multiple fallback strategies and an
// optional multi-edit (transactional) mode.
// Match strategies (in order):
//   1. Exact string match.
//   2. Trimmed whitespace-tolerant match (ignore leading/trailing whitespace per line).
//   3. Unique-line match when search is a single line that appears exactly once.
//   4. Regex literal search using `re` (optional explicit flag).
//
// Multi-edit mode (`edits: [...]`) applies several edits in order and is
// transactional: if any edit fails, the file is left untouched and the
// error names the failing edit index and strategy.

import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardPath } from "./_shared.js";

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

  // 3. Single-line unique search.
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
    "Apply search/replace edits to a single file. ALWAYS prefer this over `write_file` " +
    "for changes — search/replace produces a small, reviewable diff and cannot clobber " +
    "unrelated lines.\n\n" +
    "Two modes: (a) single edit via top-level `search`/`replace`; (b) multi-edit via " +
    "`edits: [{search, replace, ...}]` — several edits applied in order, atomically " +
    "(if any edit fails, nothing is written; the error names the failing index). " +
    "Prefer multi-edit when changing several spots in one file: it saves round-trips.\n\n" +
    "Match strategies, tried in order: (1) exact string, (2) trimmed-line (ignores " +
    "leading/trailing whitespace per line), (3) unique single-line, (4) regex when " +
    "`regex: true`. If the search text occurs more than once without " +
    "`global_replace`, the call fails with 'ambiguous' — widen the search with " +
    "surrounding context lines (copy them verbatim from `read_file` output, WITHOUT " +
    "the line-number prefix) or set `global_replace: true`.\n\n" +
    "You MUST have read the file (read_file) earlier in this session before editing " +
    "it. Use `write_file` only for new files or near-complete rewrites.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path, "write");
    if (guard) return guard;
    const p = resolve(ctx.cwd, input.path);
    let original: string;
    try {
      original = await readFile(p, "utf-8");
    } catch (err) {
      return {
        content: `failed to read ${p}: ${(err as Error).message}`,
        isError: true,
      };
    }

    const edits =
      input.edits && input.edits.length > 0
        ? input.edits
        : [{ search: input.search!, replace: input.replace ?? "", global_replace: input.global_replace, regex: input.regex }];

    // Apply in order against a working copy; transactional — any failure
    // aborts without touching disk.
    let working = original;
    const applied: string[] = [];
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
      applied.push(
        `#${i + 1} ${outcome.strategy} (${outcome.occurrences} occurrence${outcome.occurrences === 1 ? "" : "s"})`
      );
    }

    await writeFile(p, working, "utf-8");
    const delta = lineDelta(original, working);
    const deltaStr =
      delta.added > 0 ? `+${delta.added} lines` : delta.removed > 0 ? `-${delta.removed} lines` : "same line count";
    return {
      content: `applied ${applied.length} edit(s) to ${p} (${deltaStr})\n${applied.join("\n")}`,
    };
  },
};
