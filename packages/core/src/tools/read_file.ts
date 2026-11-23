// read_file: read file contents with cat -n style line numbers, binary
// detection, and a spill-to-artifact policy for very large files.

import { z } from "zod";
import { createReadStream } from "node:fs";
import { open, stat, readFile, readdir } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import type { ToolDef } from "./types.js";
import { guardPath } from "./_shared.js";
import { hashFileContent } from "../workspace/fsObservation.js";
import { stripUtf8Bom } from "./utf8Bom.js";

const schema = z.object({
  path: z.string().describe("Path to the file (absolute or relative to cwd)."),
  startLine: z
    .number()
    .int()
    .optional()
    .describe(
      "0-based start line offset. Negative = from end (e.g. -20 starts 20 lines before EOF).",
    ),
  maxLines: z
    .number()
    .int()
    .positive()
    .max(50_000)
    .optional()
    .describe("Maximum number of lines to return (default 2000)."),
});

/** Spill full file text to an artifact when the *source* exceeds this. */
const SPILL_THRESHOLD = 60_000;

/** Hard cap on UTF-8 bytes returned inline (numbered window). Accumulate
 * complete lines only — never slice mid-line. */
const INLINE_OUTPUT_BUDGET_BYTES = 50 * 1024;

/** Above this size, prefer a streaming line walk instead of buffering the
 * whole file just to slice a window. */
const STREAM_THRESHOLD_BYTES = 1_048_576; // 1 MiB

/** Lines longer than this are truncated so one pathological minified file
 * cannot blow up the context. */
const MAX_LINE_CHARS = 2000;

/** Default hard ceiling on how many bytes a single read pulls into memory.
 * Deliberately wide (64 MiB) so ordinary source files are never affected; a
 * file above this is refused before its contents are buffered so a giant
 * log/data file can't OOM the process. Overridable via `config.maxReadBytes`. */
const DEFAULT_MAX_READ_BYTES = 64 * 1024 * 1024;

/** Stub returned when the same path+window is still fresh on disk. */
export const FILE_UNCHANGED_STUB =
  "File unchanged since last read; reuse the earlier tool_result.";

export const readFileTool: ToolDef<typeof schema> = {
  name: "read_file",
  description:
    "Read a text file (`N→line` numbering). Required for source — shell `cat`/`head`/`for…cat` " +
    "is refused. Discover with `grep`/`glob` first. Same path + `startLine`/`maxLines` while the " +
    "file is unchanged returns a short stub (reuse the earlier result). Parallelise independent " +
    "reads in one turn. Window with `startLine`/`maxLines` (negative `startLine` = tail); " +
    "large files stream the window; oversized inline output is capped / spilled (`read_artifact`). " +
    "Over the read-size limit (default 64 MiB) → refuse.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path, "read");
    if (guard) return guard;
    const p = resolve(ctx.cwd, input.path);
    const denied = devicePathDenied(p);
    if (denied) {
      return { content: denied, isError: true };
    }
    let st;
    try {
      st = await stat(p);
    } catch (err) {
      const hint = await suggestSiblingPaths(p);
      return {
        content:
          `ENOENT: ${p} (${(err as Error).message})` +
          (hint ? `\n${hint}` : ""),
        isError: true,
      };
    }
    if (st.isDirectory()) {
      return {
        content:
          `EISDIR: ${p} is a directory. Use \`ls\` for one directory or \`glob\` to find files.`,
        isError: true,
      };
    }
    const max = input.maxLines ?? 2000;
    // Negative startLine resolves against total line count below (tail window).
    let start = input.startLine ?? 0;
    const readWindow = { startLine: start, maxLines: max };
    // Same path+window still fresh → skip the disk read and keep tokens down.
    if (ctx.isUnchangedRead?.(p, readWindow, { mtimeMs: st.mtimeMs, size: st.size })) {
      return { content: `${FILE_UNCHANGED_STUB} (${p})` };
    }
    const maxReadBytes = ctx.config?.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    // Enforce the byte ceiling for both stream and buffered paths.
    if (st.size > maxReadBytes) {
      const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
      return {
        content:
          `file too large: ${p} is ${st.size.toLocaleString()} bytes ` +
          `(${mib(st.size)} MiB), over the read limit of ${maxReadBytes.toLocaleString()} bytes ` +
          `(${mib(maxReadBytes)} MiB). Use a tighter \`startLine\`/\`maxLines\` window, bash ` +
          `(\`sed -n\`), or raise \`maxReadBytes\`.`,
        isError: true,
      };
    }
    const useStream = st.size > STREAM_THRESHOLD_BYTES;
    let slice: string[];
    let totalLines: number | null;
    let textForHash: string | Buffer;
    let fullTextForArtifact: string | undefined;

    if (useStream) {
      if (await sniffBinary(p)) {
        return {
          content:
            `binary file: ${p} (${st.size} bytes). Not displayed. ` +
            `For images use \`read_image\`; otherwise inspect with bash (\`file\`, \`xxd\`, \`strings\`).`,
          isError: true,
        };
      }
      const enc = await sniffEncoding(p);
      if (enc === "utf16") {
        return {
          content: `UTF-16 encoded file: ${p}. Convert to UTF-8 before reading with read_file.`,
          isError: true,
        };
      }
      let countedTotal: number | null = null;
      if (start < 0) {
        countedTotal = await countFileLines(p);
        start = Math.max(0, countedTotal + start);
      }
      const streamed = await readLineWindow(p, start, max);
      slice = streamed.lines;
      // Strip a leading BOM from the first returned line when start===0.
      if (start === 0 && slice.length > 0 && slice[0]!.charCodeAt(0) === 0xfeff) {
        slice[0] = slice[0]!.slice(1);
      }
      totalLines = countedTotal ?? streamed.totalLines;
      textForHash = Buffer.from(slice.join("\n"), "utf-8");
    } else {
      const buf = await readFile(p);
      if (isBinary(buf)) {
        return {
          content:
            `binary file: ${p} (${buf.length} bytes). Not displayed. ` +
            `For images use \`read_image\`; otherwise inspect with bash (\`file\`, \`xxd\`, \`strings\`).`,
          isError: true,
        };
      }
      if (isUtf16Bom(buf)) {
        return {
          content: `UTF-16 encoded file: ${p}. Convert to UTF-8 before reading with read_file.`,
          isError: true,
        };
      }
      const text = stripUtf8Bom(buf.toString("utf-8")).text;
      const lines = text.split(/\r?\n/);
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      if (start < 0) start = Math.max(0, lines.length + start);
      slice = lines.slice(start, start + max);
      totalLines = lines.length;
      textForHash = buf;
      if (text.length > SPILL_THRESHOLD) fullTextForArtifact = text;
    }

    if (totalLines !== null && start >= totalLines && start > 0) {
      return {
        content:
          `startLine ${start} is past end of file (${totalLines} line${totalLines === 1 ? "" : "s"}). ` +
          `Use startLine 0..${Math.max(0, totalLines - 1)}.`,
        isError: true,
      };
    }
    if (start > 0 && slice.length === 0) {
      return {
        content:
          `startLine ${start} produced an empty window` +
          (totalLines !== null ? ` (${totalLines} lines total)` : "") +
          `. Lower startLine.`,
        isError: true,
      };
    }

    const numberedLines = slice.map((l, i) => formatLine(start + i + 1, l));
    const numbered = numberedLines.join("\n");
    if (totalLines === 1 && slice.length === 1 && slice[0] === "" && start === 0) {
      ctx.observeFile?.(
        p,
        { mtimeMs: st.mtimeMs, size: st.size },
        hashFileContent(typeof textForHash === "string" ? Buffer.from(textForHash) : textForHash),
        readWindow,
      );
      return { content: `(empty file: ${p})` };
    }

    let header =
      totalLines !== null
        ? `(${totalLines} lines, ${st.size} bytes`
        : `(≥${start + slice.length} lines shown, ${st.size} bytes`;
    if (start > 0 || (totalLines !== null && start + max < totalLines) || totalLines === null) {
      header += `; showing lines ${start + 1}-${start + slice.length}`;
    }
    if (totalLines !== null && start + slice.length < totalLines) {
      header += `; next startLine=${start + slice.length}`;
    }
    header += ")";

    let artifactRef: string | undefined;
    if (fullTextForArtifact) {
      artifactRef = await ctx.artifact(fullTextForArtifact, `read_file:${input.path}`);
      header =
        `(${totalLines} lines, ${st.size} bytes; full content saved to artifact ${artifactRef}` +
        `; showing lines ${start + 1}-${start + slice.length}` +
        (start + slice.length < totalLines! ? `; next startLine=${start + slice.length}` : "") +
        `)`;
    }

    const { body, truncated: truncatedInline } = truncateNumberedByBytes(
      numberedLines,
      INLINE_OUTPUT_BUDGET_BYTES,
    );
    if (truncatedInline && !artifactRef) {
      artifactRef = await ctx.artifact(numbered, `read_file_window:${input.path}`);
    }

    let content = `${header}\n\n${body}`;
    if (truncatedInline) {
      content +=
        `\n\n[... inline output capped at ${INLINE_OUTPUT_BUDGET_BYTES.toLocaleString()} bytes` +
        (artifactRef
          ? `; full window in artifact ${artifactRef} — use read_artifact or raise startLine`
          : `; raise startLine / lower maxLines`) +
        ` ...]`;
    }

    ctx.observeFile?.(
      p,
      { mtimeMs: st.mtimeMs, size: st.size },
      hashFileContent(typeof textForHash === "string" ? Buffer.from(textForHash) : textForHash),
      readWindow,
    );
    return { content, artifactRef };
  },
};

export function formatLine(n: number, text: string): string {
  const body =
    text.length > MAX_LINE_CHARS
      ? text.slice(0, MAX_LINE_CHARS) + `… [${text.length - MAX_LINE_CHARS} chars truncated]`
      : text;
  // No padStart: padded line numbers inflate prompt-cache miss / token cost
  // without a readability win for the model.
  return `${n}\t${body}`;
}

/** Keep whole numbered lines under a UTF-8 byte budget. */
export function truncateNumberedByBytes(
  numberedLines: string[],
  budgetBytes: number,
): { body: string; truncated: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (const line of numberedLines) {
    const add = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
    if (used + add > budgetBytes) {
      return { body: kept.join("\n"), truncated: true };
    }
    kept.push(line);
    used += add;
  }
  return { body: kept.join("\n"), truncated: false };
}

/** Refuse device/proc paths that hang or never EOF. */
function devicePathDenied(absPath: string): string | null {
  const n = absPath.replace(/\\/g, "/");
  if (
    n === "/dev/zero" ||
    n === "/dev/random" ||
    n === "/dev/urandom" ||
    n === "/dev/full" ||
    /^\/dev\/fd\//.test(n) ||
    /^\/proc\/\d+\/fd\//.test(n)
  ) {
    return `refusing to read device/special path: ${absPath}`;
  }
  return null;
}

function isUtf16Bom(buf: Buffer): boolean {
  return (
    (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) ||
    (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
  );
}

async function sniffEncoding(path: string): Promise<"utf8" | "utf16" | "unknown"> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead >= 2 && isUtf16Bom(buf.subarray(0, bytesRead))) return "utf16";
    return "utf8";
  } finally {
    await fh.close();
  }
}

/** Cheap binary sniff: NUL byte in the first 8KB. */
function isBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Read the first 8KB and apply the same NUL sniff as the buffered path. */
async function sniffBinary(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    return isBinary(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** Count lines in a file via streaming (for negative startLine / tail windows). */
async function countFileLines(path: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let count = 0;
    let sawContent = false;
    let partial = false;
    const stream = createReadStream(path, { encoding: "utf-8", highWaterMark: 64 * 1024 });
    stream.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      if (text.length > 0) sawContent = true;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") {
          count++;
          partial = false;
        } else {
          partial = true;
        }
      }
    });
    stream.on("end", () => {
      if (partial || (sawContent && count === 0)) count++;
      // Match buffered split: trailing newline does not create an extra empty line.
      // count of `\n` equals line count when file ends with newline; if partial tail,
      // we already +1. Empty file → 1 empty line (matches buffered pop logic → 1).
      if (!sawContent) count = 1;
      resolvePromise(count);
    });
    stream.on("error", reject);
  });
}

/**
 * Stream a line window without buffering the whole file. The per-line buffer is
 * capped at `MAX_LINE_CHARS + 1`, so a pathological single-line dump cannot
 * grow past that cap in memory. Stops once the requested window is filled
 * (does not scan the rest for a total line count).
 */
async function readLineWindow(
  path: string,
  start: number,
  max: number,
): Promise<{ lines: string[]; totalLines: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const lines: string[] = [];
    let index = 0;
    let settled = false;
    // One char past the truncation point is enough to prove overflow.
    const lineBufferCap = MAX_LINE_CHARS + 1;
    let lineBuffer = "";
    const stream = createReadStream(path, { encoding: "utf-8", highWaterMark: 64 * 1024 });

    const done = (totalLines: number | null): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolvePromise({ lines, totalLines });
    };

    const appendToLineBuffer = (segment: string): void => {
      if (lineBuffer.length >= lineBufferCap) return;
      lineBuffer += segment;
      if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap);
    };

    const flushLine = (): void => {
      // Strip a trailing CR from CRLF so numbering matches buffered split(/\r?\n/).
      const raw = lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer;
      lineBuffer = "";
      if (index >= start && lines.length < max) {
        lines.push(raw);
      }
      index++;
      if (lines.length >= max && index > start + max) {
        done(null);
      }
    };

    stream.on("data", (chunk: string | Buffer) => {
      if (settled) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      let startPos = 0;
      let newlinePos: number;
      while ((newlinePos = text.indexOf("\n", startPos)) !== -1) {
        appendToLineBuffer(text.slice(startPos, newlinePos));
        flushLine();
        if (settled) return;
        startPos = newlinePos + 1;
      }
      appendToLineBuffer(text.slice(startPos));
    });
    stream.on("end", () => {
      if (settled) return;
      if (lineBuffer.length > 0 || index === 0) flushLine();
      if (!settled) done(index);
    });
    stream.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** ENOENT hint: suggest similarly named siblings in the parent dir. */
async function suggestSiblingPaths(absPath: string): Promise<string | null> {
  const parent = dirname(absPath);
  const want = basename(absPath).toLowerCase();
  if (!want) return null;
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return null;
  }
  const scored = names
    .map((n) => ({ n, d: editDistance(want, n.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(want.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5);
  if (scored.length === 0) return null;
  return `Did you mean: ${scored.map((x) => join(parent, x.n)).join(", ")}?`;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 8) return 99;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}
