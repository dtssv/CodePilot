// write_file: write text content to a file. Auto-creates parent dirs.

import { z } from "zod";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardPath } from "./_shared.js";

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
    "Write text to a file, creating parent directories as needed. Overwrites the " +
    "whole file when it exists.\n\n" +
    "When to use: creating a NEW file, or a near-complete rewrite of an existing " +
    "one.\n" +
    "When NOT to use: modifying an existing file — use `edit_file` instead. A " +
    "full-file overwrite risks silently dropping regions you did not intend to " +
    "touch, and it erases the review trail (the diff becomes 'everything " +
    "changed'). If the file exists, you MUST have read it earlier in the session " +
    "before overwriting.\n" +
    "Never write secrets (keys, tokens, passwords) into files. Writes outside the " +
    "workspace are refused by the sandbox.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path, "write");
    if (guard) return guard;
    const p = resolve(ctx.cwd, input.path);
    if (input.createDirs !== false) {
      await mkdir(dirname(p), { recursive: true });
    }
    const existed = await stat(p)
      .then(() => true)
      .catch(() => false);
    await writeFile(p, input.content, "utf-8");
    const lines = input.content.length === 0 ? 0 : input.content.split(/\r?\n/).length;
    return {
      content: existed
        ? `overwrote ${p} (${input.content.length} bytes, ${lines} lines)`
        : `wrote ${p} (${input.content.length} bytes, ${lines} lines)`,
    };
  },
};
