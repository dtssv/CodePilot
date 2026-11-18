// write_file: write text content to a file. Auto-creates parent dirs.

import { z } from "zod";
import { mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardDeliveryWrite, guardFreshWrite, guardPath } from "./_shared.js";
import { hashFileContent } from "../workspace/fsObservation.js";

const schema = z.object({
  path: z.string().describe("Destination path (absolute or cwd-relative)."),
  content: z.string().describe("UTF-8 file body (not a shell command to run)."),
  createDirs: z.boolean().optional().describe("Create parent dirs (default true)."),
  append: z
    .boolean()
    .optional()
    .describe("Append instead of overwrite (default false); no prior read required."),
});

export const writeFileTool: ToolDef<typeof schema> = {
  name: "write_file",
  description:
    "Create/overwrite one text file (`path` + `content`). Partial edits → `edit_file`; " +
    "run processes → `bash`. Prefer reading before overwrite; `append: true` to grow a file. " +
    "Never write secrets; sandbox blocks out-of-workspace paths.",
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
    // Overwriting an existing file: block only when a prior observation is
    // stale. Unobserved overwrites are allowed ; surgical edits
    // should prefer apply_patch/edit_file. Appending only ADDS content, so it
    // skips the freshness guard. Creating a new file is always allowed.
    if (!appending) {
      // Lazy reader: current bytes are read ONLY if the mtime/size gate reports
      // stale, to rescue a false-positive mtime on unchanged content.
      const fresh = await guardFreshWrite(ctx, p, preStat, undefined, {
        readCurrent: () => readFile(p).catch(() => null),
      });
      if (fresh) return fresh;
    }
    await writeFile(p, input.content, { encoding: "utf-8", flag: appending ? "a" : "w" });
    try {
      const s = await stat(p);
      // After an append we don't hold the full file, so only hash on overwrite.
      const hash = appending ? undefined : hashFileContent(Buffer.from(input.content, "utf-8"));
      ctx.reobserveFile?.(p, { mtimeMs: s.mtimeMs, size: s.size }, hash);
    } catch {
      /* best-effort */
    }
    const lines = input.content.length === 0 ? 0 : input.content.split(/\r?\n/).length;
    const verb = appending ? (existed ? "appended to" : "created") : existed ? "overwrote" : "wrote";
    const note = (await ctx.postWrite?.([p], ctx)) ?? "";
    return {
      content: `${verb} ${p} (${input.content.length} bytes, ${lines} lines${appending ? ", append mode" : ""})${note}`,
    };
  },
};
