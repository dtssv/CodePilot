// apply_patch: multi-file atomic edits using a unified patch format.
//
// Format (inspired by OpenAI codex's apply_patch):
//   *** Begin Patch
//   *** Add File: <path>
//   <full file content>
//   *** End File
//   *** Delete File: <path>
//   *** Update File: <path>
//   @@<context>
//   -<removed line>
//   +<added line>
//    <unchanged context line>
//   *** End File
//   *** End Patch
//
// All file operations in a single patch are applied atomically: if any
// single hunk fails to apply, NO file is written and the error reports the
// failing file + hunk. This makes apply_patch ideal for cross-file refactors
// where partial application would leave the tree in an inconsistent state.
//
// Update hunks use a context-anchored apply: leading/trailing unchanged
// lines (those starting with a space, or no marker) locate the position,
// then `-` lines must match verbatim and are replaced by `+` lines.

import { z } from "zod";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ToolDef } from "./types.js";
import { guardPath } from "./_shared.js";

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
      while (i < end && rawLines[i] !== "*** End File") {
        content.push(rawLines[i]!);
        i++;
      }
      if (rawLines[i] !== "*** End File") {
        throw new Error(`Add File ${path}: missing \`*** End File\``);
      }
      i++; // consume End File
      ops.push({ kind: "add", path, content: content.join("\n") });
    } else if (line.startsWith("*** Delete File: ")) {
      ops.push({ kind: "delete", path: line.slice("*** Delete File: ".length) });
      i++;
    } else if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length);
      i++;
      const hunks: Hunk[] = [];
      let current: Hunk | null = null;
      while (i < end && rawLines[i] !== "*** End File") {
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
      if (rawLines[i] !== "*** End File") {
        throw new Error(`Update File ${path}: missing \`*** End File\``);
      }
      i++; // consume End File
      ops.push({ kind: "update", path, hunks });
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
  // We locate this block in the file, verify del lines match, then splice
  // in the ctx + add lines.
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
  // Find the search signature as a contiguous block.
  const start = findSubArray(lines, searchSig);
  if (start < 0) {
    // Try whitespace-tolerant match.
    const startTol = findSubArrayTolerant(lines, searchSig);
    if (startTol < 0) {
      throw new Error(
        `hunk did not apply: context/removed lines not found. ` +
          `Expected: ${JSON.stringify(searchSig.slice(0, 3))}…`
      );
    }
    return spliceIn(lines, startTol, searchSig.length, replacement).join("\n");
  }
  return spliceIn(lines, start, searchSig.length, replacement).join("\n");
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

export const applyPatchTool: ToolDef<typeof schema> = {
  name: "apply_patch",
  description:
    "Apply a multi-file patch atomically. Use this for cross-file refactors " +
    "(e.g. renaming a symbol + updating its callers) where partial application " +
    "would leave the tree broken: if ANY hunk fails, NO file is written.\n\n" +
    "FORMAT (CodePilot apply_patch):\n" +
    "```\n" +
    "*** Begin Patch\n" +
    "*** Add File: path/to/new.ts\n" +
    "<full file content>\n" +
    "*** End File\n" +
    "*** Delete File: path/to/old.ts\n" +
    "*** Update File: path/to/existing.ts\n" +
    "@@\n" +
    " <unchanged context line>\n" +
    "-<removed line>\n" +
    "+<added line>\n" +
    "*** End File\n" +
    "*** End Patch\n" +
    "```\n" +
    "Rules:\n" +
    "- `Add File`: full content between `*** Add File:` and `*** End File`.\n" +
    "- `Delete File`: just the directive; the file is removed.\n" +
    "- `Update File`: one or more hunks. Each hunk starts with `@@` (optional " +
    "when there's only one). Inside a hunk: lines starting with ` ` (space) " +
    "or no marker are context, `-` lines are removed, `+` lines are added. " +
    "Context lines anchor the hunk; removed lines must match verbatim.\n" +
    "- All operations in one patch apply atomically.\n" +
    "- You MUST have read any file you update (via read_file) earlier in the " +
    "session — copy context/removed lines verbatim from that output, WITHOUT " +
    "the line-number prefix.",
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
    }

    // 2. Read all files that will be updated (so we can roll back cleanly).
    const originals = new Map<string, string>();
    for (const op of ops) {
      if (op.kind === "update") {
        const p = resolve(ctx.cwd, op.path);
        try {
          originals.set(op.path, await readFile(p, "utf-8"));
        } catch (err) {
          return {
            content: `failed to read ${op.path}: ${(err as Error).message}`,
            isError: true,
          };
        }
      }
    }

    // 3. Compute all new contents (apply hunks) BEFORE writing anything.
    const writes: { path: string; content: string }[] = [];
    const deletes: string[] = [];
    const adds: { path: string; content: string }[] = [];
    try {
      for (const op of ops) {
        if (op.kind === "add") {
          adds.push({ path: op.path, content: op.content ?? "" });
        } else if (op.kind === "delete") {
          deletes.push(op.path);
        } else {
          const original = originals.get(op.path)!;
          let working = original;
          for (let hi = 0; hi < (op.hunks ?? []).length; hi++) {
            try {
              working = applyHunk(working, op.hunks![hi]!);
            } catch (err) {
              throw new Error(
                `${op.path} hunk #${hi + 1}: ${(err as Error).message}`
              );
            }
          }
          writes.push({ path: op.path, content: working });
        }
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
        summary.push(`+ added ${a.path}`);
      }
      for (const w of writes) {
        const p = resolve(ctx.cwd, w.path);
        await writeFile(p, w.content, "utf-8");
        summary.push(`~ updated ${w.path}`);
      }
      for (const d of deletes) {
        const p = resolve(ctx.cwd, d);
        if (existsSync(p)) await rm(p);
        summary.push(`- deleted ${d}`);
      }
    } catch (err) {
      return {
        content: `partial failure: ${summary.join("\n")}\nerror: ${(err as Error).message}`,
        isError: true,
      };
    }

    return {
      content: `applied ${ops.length} file operation(s) atomically:\n${summary.join("\n")}`,
    };
  },
};
