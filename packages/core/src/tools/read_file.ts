// read_file: read file contents with cat -n style line numbers, binary
// detection, and a spill-to-artifact policy for very large files.

import { z } from "zod";
import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardPath } from "./_shared.js";

const schema = z.object({
  path: z.string().describe("Path to the file (absolute or relative to cwd)."),
  startLine: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("0-based start line offset."),
  maxLines: z
    .number()
    .int()
    .positive()
    .max(50_000)
    .optional()
    .describe("Maximum number of lines to return (default 2000)."),
});

const SPILL_THRESHOLD = 60_000;

/** Lines longer than this are truncated so one pathological minified file
 *  cannot blow up the context. */
const MAX_LINE_CHARS = 2000;

export const readFileTool: ToolDef<typeof schema> = {
  name: "read_file",
  description:
    "Read a text file from disk. Output is numbered `cat -n` style — each line is " +
    "rendered as `<lineNumber>→<content>` — so you can cite `path:line` in edits, " +
    "reports and discussions. Lines longer than 2000 chars are truncated inline.\n\n" +
    "When to use: any time you need to see file contents before editing (editing " +
    "without reading first is forbidden), reviewing code, or checking exact text.\n" +
    "When NOT to use: for discovery (prefer `grep`/`glob`), for directories " +
    "(use `ls`), or to re-read a file already in your context (it has not changed " +
    "unless you or a tool changed it).\n" +
    "Use `startLine`/`maxLines` to window into large files instead of loading them " +
    "whole. Files larger than ~60KB spill to an artifact; the result names the " +
    "`art_<hash>` reference — pull slices with `read_artifact`. Binary files are " +
    "detected and reported, never dumped. Reads outside the sandbox's allowed set " +
    "(e.g. ~/.ssh) are refused.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path, "read");
    if (guard) return guard;
    const p = resolve(ctx.cwd, input.path);
    let st;
    try {
      st = await stat(p);
    } catch (err) {
      return { content: `ENOENT: ${p} (${(err as Error).message})`, isError: true };
    }
    if (st.isDirectory()) {
      return { content: `EISDIR: ${p} is a directory`, isError: true };
    }
    const buf = await readFile(p);
    if (isBinary(buf)) {
      return {
        content:
          `binary file: ${p} (${buf.length} bytes). Not displayed. ` +
          `Use bash (\`file\`, \`xxd\`, \`strings\`) if you need to inspect it.`,
        isError: true,
      };
    }
    const text = buf.toString("utf-8");
    const lines = text.split(/\r?\n/);
    const start = input.startLine ?? 0;
    const max = input.maxLines ?? 2000;
    const slice = lines.slice(start, start + max);
    const numbered = slice
      .map((l, i) => formatLine(start + i + 1, l))
      .join("\n");
    let header = `(${lines.length} lines, ${text.length} bytes`;
    if (start > 0 || start + max < lines.length) {
      header += `; showing lines ${start + 1}-${start + slice.length}`;
    }
    header += ")";
    let content = `${header}\n\n${numbered}`;
    if (lines.length === 1 && lines[0] === "") {
      content = `(empty file: ${p})`;
    }
    let artifactRef: string | undefined;
    if (text.length > SPILL_THRESHOLD) {
      artifactRef = await ctx.artifact(text, `read_file:${input.path}`);
      content =
        `(${lines.length} lines, ${text.length} bytes; full content saved to artifact ${artifactRef})\n\n` +
        numbered;
    }
    return { content, artifactRef };
  },
};

function formatLine(n: number, text: string): string {
  const body =
    text.length > MAX_LINE_CHARS
      ? text.slice(0, MAX_LINE_CHARS) + `… [${text.length - MAX_LINE_CHARS} chars truncated]`
      : text;
  return `${String(n).padStart(6)}\t${body}`;
}

/** Cheap binary sniff: NUL byte in the first 8KB. */
function isBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
