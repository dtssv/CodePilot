// write_file: write text content to a file. Auto-creates parent dirs.

import { z } from "zod";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardDeliveryWrite, guardFreshWrite, guardPath } from "./_shared.js";

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
  append: z
    .boolean()
    .optional()
    .describe(
      "Append `content` to the end of the file instead of overwriting it " +
        "(default false). Use this to build a large file incrementally across " +
        "several calls without re-sending the whole body each time. Appending " +
        "does not require reading the file first (it adds, never replaces).",
    ),
});

export const writeFileTool: ToolDef<typeof schema> = {
  name: "write_file",
  description:
    "Create or overwrite one file on disk. Requires `path` + `content` (the file body). " +
    "Only for persisting text files — never for running shell commands, starting browsers, " +
    "or taking screenshots (use `bash` with `command` for those). Prefer `edit_file` for " +
    "partial edits. Read an existing file before overwriting it. Set `append: true` to add " +
    "to the end instead of overwriting — useful for building a large file across several " +
    "calls without re-sending the whole body. Never write secrets; sandbox blocks " +
    "out-of-workspace paths.",
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
    const preStat = await stat(p)
      .then((s) => ({ mtimeMs: s.mtimeMs, size: s.size }))
      .catch(() => null);
    const existed = preStat !== null;
    const appending = input.append === true;
    // Overwriting an existing file is a mutation: require read-before-write and
    // block a stale overwrite. Appending only ADDS content (never replaces), so
    // it does not need the freshness guard — and requiring a prior read would
    // defeat the point of building a large file incrementally. Creating a new
    // file is always allowed (preStat null → guard passes).
    if (!appending) {
      const fresh = guardFreshWrite(ctx, p, preStat);
      if (fresh) return fresh;
    }
    await writeFile(p, input.content, { encoding: "utf-8", flag: appending ? "a" : "w" });
    try {
      const s = await stat(p);
      ctx.reobserveFile?.(p, { mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      /* best-effort */
    }
    const lines = input.content.length === 0 ? 0 : input.content.split(/\r?\n/).length;
    const verb = appending ? (existed ? "appended to" : "created") : existed ? "overwrote" : "wrote";
    return {
      content: `${verb} ${p} (${input.content.length} bytes, ${lines} lines${appending ? ", append mode" : ""})`,
    };
  },
};
