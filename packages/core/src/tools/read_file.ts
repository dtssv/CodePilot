// read_file: read file contents with cat -n style line numbers, binary
// detection, and a spill-to-artifact policy for very large files.

import { z } from "zod";
import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardPath } from "./_shared.js";
import { hashFileContent } from "../fsObservation.js";

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
 * cannot blow up the context. */
const MAX_LINE_CHARS = 2000;

/** Default hard ceiling on how many bytes a single read pulls into memory.
 * Deliberately wide (64 MiB) so ordinary source files are never affected; a
 * file above this is refused before its contents are buffered so a giant
 * log/data file can't OOM the process. Overridable via `config.maxReadBytes`. */
const DEFAULT_MAX_READ_BYTES = 64 * 1024 * 1024;

export const readFileTool: ToolDef<typeof schema> = {
  name: "read_file",
  description:
    "Read a text file (`N→line` numbering). Prefer `grep`/`glob` for discovery; don't " +
    "re-read unchanged files. Window large files with `startLine`/`maxLines`; >~60KB " +
    "spills to an artifact (`read_artifact`). Files over the read-size limit (default " +
    "64 MiB) are refused — use bash (`head`/`sed`/`grep`) for those. Required before editing.",
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
    // Size gate BEFORE buffering: refuse a file larger than the limit rather
    // than pulling it entirely into memory. A line window (startLine/maxLines)
    // does not help here — the whole file must still be read to slice it — so
    // the check is on total size, and the message points at IO-bounded tools.
    const maxReadBytes = ctx.config?.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    if (st.size > maxReadBytes) {
      const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
      return {
        content:
          `file too large: ${p} is ${st.size.toLocaleString()} bytes ` +
          `(${mib(st.size)} MiB), over the read limit of ${maxReadBytes.toLocaleString()} bytes ` +
          `(${mib(maxReadBytes)} MiB). A line window does not reduce the read cost — the whole ` +
          `file is buffered to slice it. Use bash instead (e.g. \`head\`/\`sed\`/\`grep\` on the ` +
          `path) to pull only what you need, or raise \`maxReadBytes\` in config.`,
        isError: true,
      };
    }
    const buf = await readFile(p);
    if (isBinary(buf)) {      return {
        content:
          `binary file: ${p} (${buf.length} bytes). Not displayed. ` +
          `Use bash (\`file\`, \`xxd\`, \`strings\`) if you need to inspect it.`,
        isError: true,
      };
    }
    const text = buf.toString("utf-8");
    const lines = text.split(/\r?\n/);
 // A single trailing newline is a line terminator, not an empty last
 // line — drop it so line numbers match `cat -n` exactly.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
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
    // Record the observation so a later edit_file/write_file/apply_patch can
    // assert read-before-write and detect a stale (externally changed) file.
    // The content hash lets a subsequent write survive a jittered mtime when
    // the bytes are actually unchanged.
    ctx.observeFile?.(p, { mtimeMs: st.mtimeMs, size: st.size }, hashFileContent(buf));
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
