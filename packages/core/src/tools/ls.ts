// ls: list a directory (one level deep, with type markers).

import { z } from "zod";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolDef } from "./types.js";

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
  description: "List a single directory (non-recursive).",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const dir = resolve(ctx.cwd, input.path ?? ".");
    const max = input.maxEntries ?? 500;
    const showHidden = input.showHidden ?? false;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      return { content: `cannot read ${dir}: ${(err as Error).message}`, isError: true };
    }
    const sorted = entries
      .filter((e) => showHidden || !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, max);
    const lines: string[] = [];
    for (const e of sorted) {
      let suffix = "";
      try {
        const s = await stat(join(dir, e.name));
        if (e.isDirectory()) suffix = "/";
        else if (s.isSymbolicLink()) suffix = "@";
        else if (e.name.endsWith(".sock")) suffix = "=";
      } catch {
        /* ignore */
      }
      lines.push(`${e.isDirectory() ? "d" : "-"} ${e.name}${suffix}`);
    }
    return { content: lines.join("\n") || "(empty)" };
  },
};
