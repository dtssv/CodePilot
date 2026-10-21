// write_file: write text content to a file. Auto-creates parent dirs.

import { z } from "zod";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardDeliveryWrite, guardPath } from "./_shared.js";

const schema = z.object({
  path: z
    .string()
    .describe("Required. Destination file path (absolute or relative to cwd)."),
  content: z
    .string()
    .describe(
      "Required. UTF-8 text to persist at `path` (source, config, docs). " +
        "Not a shell command — do not put scripts-to-run here.",
    ),
  createDirs: z
    .boolean()
    .optional()
    .describe("Create parent directories (default true)."),
});

export const writeFileTool: ToolDef<typeof schema> = {
  name: "write_file",
  description:
    "Create or overwrite one file on disk. Requires `path` + `content` (the file body). " +
    "Only for persisting text files — never for running shell commands, starting browsers, " +
    "or taking screenshots (use `bash` with `command` for those). Prefer `edit_file` for " +
    "partial edits. Read an existing file before overwriting it. Never write secrets; " +
    "sandbox blocks out-of-workspace paths.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path, "write");
    if (guard) return guard;
    const delivery = await guardDeliveryWrite(ctx, input.path);
    if (delivery) return delivery;
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
