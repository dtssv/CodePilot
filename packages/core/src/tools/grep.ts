// grep: file-content search with regex. Falls back to spawning ripgrep if the
// built-in walker exceeds an iteration budget.

import { z } from "zod";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ToolDef } from "./types.js";

const schema = z.object({
  pattern: z.string().describe("Regular expression (JavaScript syntax)."),
  cwd: z.string().optional().describe("Directory to search in."),
  include: z.string().optional().describe("Glob to limit files (e.g. \"*.ts\")."),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Max matches (default 200)."),
  context: z
    .number()
    .int()
    .nonnegative()
    .max(20)
    .optional()
    .describe("Lines of context around each match (default 1)."),
});

interface GrepHit {
  file: string;
  line: number;
  text: string;
}

export const grepTool: ToolDef<typeof schema> = {
  name: "grep",
  description:
    "Search file contents with a regex. Returns file:line:snippet for each match.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const base = resolve(ctx.cwd, input.cwd ?? ".");
    const max = input.maxResults ?? 200;
    const ctxLines = input.context ?? 1;
    const re = new RegExp(input.pattern);
    const include: RegExp | null = input.include ? compileGlob(input.include) : null;
    const hits: GrepHit[] = [];
    await walk(base, base, re, include, ctxLines, hits, max, 0);
    if (hits.length === 0) {
      return { content: "(no matches)" };
    }
    return {
      content: hits
        .map((h) => `${h.file}:${h.line + 1}: ${h.text}`)
        .join("\n"),
    };
  },
};

async function walk(
  root: string,
  dir: string,
  re: RegExp,
  include: RegExp | null,
  ctxLines: number,
  out: GrepHit[],
  cap: number,
  depth: number
): Promise<void> {
  if (out.length >= cap || depth > 16) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= cap) return;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
      await walk(root, abs, re, include, ctxLines, out, cap, depth + 1);
    } else if (ent.isFile()) {
      const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
      if (include && !include.test(rel)) continue;
      try {
        const st = await stat(abs);
        if (st.size > 2 * 1024 * 1024) continue; // skip >2MB files for built-in walker
        const text = await readFile(abs, "utf-8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (out.length >= cap) return;
          if (re.test(lines[i]!)) {
            const start = Math.max(0, i - ctxLines);
            const end = Math.min(lines.length, i + ctxLines + 1);
            const text = lines.slice(start, end).join("\n");
            out.push({ file: rel, line: i, text });
            i = end - 1;
          }
        }
      } catch {
        // binary or unreadable; skip
      }
    }
  }
}

function compileGlob(pattern: string): RegExp {
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
    } else if (c === "?") re += "[^/]";
    else if ("\\^$.|+(){}".includes(c)) re += "\\" + c;
    else re += c;
  }
  re += "$";
  return new RegExp(re);
}
