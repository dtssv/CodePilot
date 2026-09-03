// read_file: read file contents, with line offsets and a spill-to-artifact policy.

import { z } from "zod";
import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDef } from "./types.js";

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

export const readFileTool: ToolDef<typeof schema> = {
  name: "read_file",
  description:
    "Read a text file. Large outputs spill to an artifact (reference returned in tool_result).",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
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
    const text = buf.toString("utf-8");
    const lines = text.split(/\r?\n/);
    const start = input.startLine ?? 0;
    const max = input.maxLines ?? 2000;
    const slice = lines.slice(start, start + max);
    let content = slice.join("\n");
    let artifactRef: string | undefined;
    if (text.length > SPILL_THRESHOLD) {
      artifactRef = await ctx.artifact(text, `read_file:${input.path}`);
      content = `(${lines.length} lines, ${text.length} bytes; full content saved to artifact ${artifactRef})\n\n${content}`;
    } else {
      content = `(${lines.length} lines, ${text.length} bytes)\n\n${content}`;
    }
    return { content, artifactRef };
  },
};
