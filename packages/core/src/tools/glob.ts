// glob: filesystem glob matching. Uses a minimal matcher that supports
// `*`, `**`, `?` and character classes. Avoids extra deps.

import { z } from "zod";
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ToolDef } from "./types.js";

const schema = z.object({
  pattern: z.string().describe("Glob pattern (e.g. \"src/**/*.ts\")."),
  cwd: z.string().optional().describe("Base directory (default: session cwd)."),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Cap on number of matches (default 1000)."),
});

export const globTool: ToolDef<typeof schema> = {
  name: "glob",
  description: "List files matching a glob pattern.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const base = resolve(ctx.cwd, input.cwd ?? ".");
    const max = input.maxResults ?? 1000;
    const matches: string[] = [];
    await walk(base, base, input.pattern, matches, max);
    return {
      content: matches.length === 0
        ? "(no matches)"
        : matches.join("\n"),
    };
  },
};

function compileGlob(pattern: string): RegExp {
  // Translate glob -> regex.
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end < 0) {
        re += "\\[";
      } else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else if ("\\^$.|+(){}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

async function walk(
  root: string,
  dir: string,
  pattern: string,
  out: string[],
  cap: number
): Promise<void> {
  if (out.length >= cap) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const matcher = compileGlob(pattern);
  for (const ent of entries) {
    if (out.length >= cap) return;
    const abs = join(dir, ent.name);
    const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
    if (ent.isDirectory()) {
      if (rel === "node_modules" || rel === ".git" || rel === "dist") continue;
      await walk(root, abs, pattern, out, cap);
      // Also match the directory itself.
      if (matcher.test(rel) || matcher.test(rel + "/")) {
        out.push(rel);
      }
    } else if (ent.isFile()) {
      if (matcher.test(rel)) out.push(rel);
    } else {
      // symlink etc.
      try {
        const st = await stat(abs);
        if (st.isFile() && matcher.test(rel)) out.push(rel);
      } catch {
        /* ignore */
      }
    }
  }
}
