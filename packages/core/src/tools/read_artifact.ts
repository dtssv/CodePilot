// read_artifact: load the full content of an artifact previously written via
// the artifact spill mechanism (referenced by `art_<hash>`).

import { z } from "zod";
import type { ToolDef } from "./types.js";
import { truncateNumberedByBytes } from "./read_file.js";

/** Same inline UTF-8 budget as read_file — escape hatches must not dump unbounded blobs. */
const INLINE_OUTPUT_BUDGET_BYTES = 50 * 1024;
/** Match read_file: one pathological minified/JSON line cannot blow the window alone. */
const MAX_LINE_CHARS = 2000;

const schema = z.object({
  ref: z.string().describe("Artifact reference (e.g. \"art_<hash>\")."),
  startLine: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("0-based line offset."),
  maxLines: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .optional()
    .describe("Max lines to return (default 5000)."),
});

export const readArtifactTool: ToolDef<typeof schema> = {
  name: "read_artifact",
  description:
    "Read spilled tool output by `art_<hash>` ref; window with `startLine`/`maxLines`. " +
    "Prefer this over re-running the producer when a folded stub still carries the ref. " +
    "Inline output is byte-capped like `read_file`; raise `startLine` for the next slice. " +
    "Session-scoped — re-run the producer if the ref is gone.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    try {
      const text = await ctx.readArtifact(input.ref);
      const lines = text.split(/\r?\n/);
      const start = input.startLine ?? 0;
      const max = input.maxLines ?? 5000;
      const window = lines.slice(start, start + max).map((line) =>
        line.length > MAX_LINE_CHARS
          ? line.slice(0, MAX_LINE_CHARS) + `… [${line.length - MAX_LINE_CHARS} chars truncated]`
          : line,
      );
      const lineTruncated = lines.length > start + max;
      // No cat -n prefixes — byte budget matches raw content (same helper as read_file).
      const { body, truncated: byteTruncated } = truncateNumberedByBytes(
        window,
        INLINE_OUTPUT_BUDGET_BYTES,
      );
      const kept = byteTruncated ? body.split("\n").length : window.length;
      const notes: string[] = [];
      if (byteTruncated) {
        notes.push(
          `truncated at ${INLINE_OUTPUT_BUDGET_BYTES} bytes; next startLine=${start + kept}`,
        );
      } else if (lineTruncated) {
        notes.push(
          `truncated, ${lines.length - (start + max)} more lines; next startLine=${start + max}`,
        );
      }
      return {
        content: notes.length > 0 ? `${body}\n\n[${notes.join("; ")}]` : body,
      };
    } catch (err) {
      return { content: `read_artifact failed: ${(err as Error).message}`, isError: true };
    }
  },
};
