// ls: list a directory (one level deep, with type markers).

import { z } from "zod";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDef } from "./types.js";
import { guardPath } from "./_shared.js";

const schema = z.object({
  path: z
    .string()
    .optional()
    .describe("Directory to list (default: session cwd)."),
  maxEntries: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .describe("Cap on entries returned (default 500)."),
  showHidden: z.boolean().optional().describe("Include dotfiles (default false)."),
});

export const lsTool: ToolDef<typeof schema> = {
  name: "ls",
  description:
    "List one directory level (`d name/`, `- file`, `@` symlink). Use `glob` for recursive trees.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const guard = await guardPath(ctx, input.path ?? ".", "read");
    if (guard) return guard;
    const dir = resolve(ctx.cwd, input.path ?? ".");
    const max = input.maxEntries ?? 500;
    const showHidden = input.showHidden ?? false;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      return { content: `cannot read ${dir}: ${(err as Error).message}`, isError: true };
    }
    const BYTE_BUDGET = 32 * 1024;
    const filtered = entries
      .filter((e) => showHidden || !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
    const lines: string[] = [];
    let used = 0;
    let truncatedByBytes = false;
    for (const e of filtered.slice(0, max)) {
      const kind = e.isSymbolicLink() ? "l" : e.isDirectory() ? "d" : "-";
      let suffix = "";
      if (e.isSymbolicLink()) suffix = "@";
      else if (e.isDirectory()) suffix = "/";
      else if (e.name.endsWith(".sock")) suffix = "=";
      const line = `${kind} ${e.name}${suffix}`;
      const add = Buffer.byteLength(line, "utf-8") + (lines.length > 0 ? 1 : 0);
      if (used + add > BYTE_BUDGET) {
        truncatedByBytes = true;
        break;
      }
      lines.push(line);
      used += add;
    }
    const body = lines.join("\n") || "(empty)";
    const notes: string[] = [];
    if (filtered.length > max) {
      notes.push(`[truncated at ${max} entries; ${filtered.length - max} more not shown]`);
    }
    if (truncatedByBytes) {
      notes.push(`[truncated at ${BYTE_BUDGET} byte budget]`);
    }
    return {
      content: notes.length > 0 ? `${body}\n\n${notes.join("\n")}` : body,
    };
  },
};
