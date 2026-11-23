// write_file: write text content to a file. Auto-creates parent dirs.

import { z } from "zod";
import { mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardDeliveryWrite, guardFreshWrite, guardPath } from "./_shared.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { withWriteLocks } from "./writeLock.js";
import { restoreUtf8Bom, stripUtf8Bom } from "./utf8Bom.js";
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
    "Create/overwrite one text file (`path` + `content`). Overwriting an existing file " +
    "requires a prior `read_file` in this session (blocks blind clobber). New files and " +
    "`append: true` do not. Partial edits → `edit_file`; processes → `bash`. " +
    "Never write secrets; sandbox blocks out-of-workspace paths.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path, "write");
    if (guard) return guard;
    const delivery = await guardDeliveryWrite(ctx, input.path);
    if (delivery) return delivery;
    const p = resolve(ctx.cwd, input.path);
    return withWriteLocks([p], async () => {
      if (input.createDirs !== false) {
        await mkdir(dirname(p), { recursive: true });
      }
      const preStat = await stat(p)
        .then((s) => ({ mtimeMs: s.mtimeMs, size: s.size }))
        .catch(() => null);
      const existed = preStat !== null;
      const appending = input.append === true;
      // Overwrite of an existing file: require a prior read (or our own write)
      // this session, and refuse when that observation is stale. Append and
      // create-new skip the gate — append only adds bytes; create has no prior.
      if (!appending) {
        const fresh = await guardFreshWrite(ctx, p, preStat, undefined, {
          requireObserved: true,
          readCurrent: () => readFile(p).catch(() => null),
        });
        if (fresh) return fresh;
      }
      // Preserve an existing UTF-8 BOM on overwrite when the model body omits it
      // (common after read_file). Append never injects a mid-file BOM.
      let toWrite = input.content;
      let prevText = "";
      if (!appending && existed) {
        prevText = await readFile(p, "utf-8").catch(() => "");
        const priorBom = stripUtf8Bom(prevText).hadBom;
        const body = stripUtf8Bom(input.content);
        toWrite = restoreUtf8Bom(body.text, priorBom || body.hadBom);
      }
      if (appending) {
        // Append cannot use temp+rename without rewriting the whole file.
        await writeFile(p, toWrite, { encoding: "utf-8", flag: "a" });
      } else {
        await atomicWriteFile(p, toWrite, "utf-8");
      }
      try {
        const s = await stat(p);
        // After an append we don't hold the full file, so only hash on overwrite.
        const hash = appending ? undefined : hashFileContent(Buffer.from(toWrite, "utf-8"));
        ctx.reobserveFile?.(p, { mtimeMs: s.mtimeMs, size: s.size }, hash);
      } catch {
        /* best-effort */
      }
      const lines = input.content.length === 0 ? 0 : input.content.split(/\r?\n/).length;
      const verb = appending ? (existed ? "appended to" : "created") : existed ? "overwrote" : "wrote";
      const note = (await ctx.postWrite?.([p], ctx)) ?? "";
      // Diff stays on the permission preview / UI — do not re-send into
      // tool_result; every edit would otherwise cost ~40 lines.
      return {
        content: `${verb} ${p} (${Buffer.byteLength(toWrite, "utf-8")} bytes, ${lines} lines${appending ? ", append mode" : ""})${note}`,
      };
    });
  },
};
