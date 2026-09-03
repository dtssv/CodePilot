// edit_file: search/replace edits with multiple fallback strategies.
// Strategies (in order):
//   1. Exact string match.
//   2. Trimmed whitespace-tolerant match (ignore leading/trailing whitespace per line).
//   3. Line-block match (allow trailing/leading context lines to differ).
//   4. Unique-line match when search is a single line that appears exactly once.
//   5. Regex literal search using `re` (optional explicit flag).

import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDef } from "./types.js";

const schema = z.object({
  path: z.string().describe("File path to edit."),
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

export const editFileTool: ToolDef<typeof schema> = {
  name: "edit_file",
  description:
    "Apply a search/replace edit to a file. Tries exact match first, then trimmed-line match, then single-line unique match. Pass `regex: true` to use a regular expression.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
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
    const outcome = applyEdit(original, {
      search: input.search,
      replace: input.replace,
      global_replace: input.global_replace,
      regex: input.regex,
    });
    if (!outcome.ok) {
      return {
        content: `edit_file failed (${outcome.strategy}): ${outcome.message}`,
        isError: true,
      };
    }
    await writeFile(p, outcome.message, "utf-8");
    return {
      content: `applied ${outcome.strategy} edit (${outcome.occurrences} occurrence${
        outcome.occurrences === 1 ? "" : "s"
      }) to ${p}`,
    };
  },
};
