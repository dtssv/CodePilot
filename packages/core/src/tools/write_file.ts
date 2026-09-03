// write_file: write text content to a file. Auto-creates parent dirs.

import { z } from "zod";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolDef } from "./types.js";

const schema = z.object({
  path: z.string().describe("File path (absolute or relative to cwd)."),
  content: z.string().describe("Full text content to write."),
  createDirs: z
    .boolean()
    .optional()
    .describe("Create parent directories (default true)."),
});

export const writeFileTool: ToolDef<typeof schema> = {
  name: "write_file",
  description:
    "Write text to a file (overwrites if exists). Creates parent dirs on demand.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    const p = resolve(ctx.cwd, input.path);
    if (input.createDirs !== false) {
      await mkdir(dirname(p), { recursive: true });
    }
    const existed = await stat(p)
      .then(() => true)
      .catch(() => false);
    await writeFile(p, input.content, "utf-8");
    return {
      content: existed
        ? `overwrote ${p} (${input.content.length} bytes)`
        : `wrote ${p} (${input.content.length} bytes)`,
    };
  },
};
