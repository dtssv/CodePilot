// grep: file-content search with regex. Falls back to spawning ripgrep if the
// built-in walker exceeds an iteration budget.

import { z } from "zod";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ToolDef } from "./types.js";
import { shouldSkipWalkDir, guardPath } from "./_shared.js";

/** Above this many chars, the full match list spills to an artifact and the
 * inline result keeps a head slice + a pointer. A huge grep result (hundreds
 * of matches with context) otherwise sits verbatim in the transcript and
 * gets re-sent every turn, ballooning tokens and slowing the whole session. */
const ARTIFACT_THRESHOLD = 8_000;
const HEAD_CHARS = 6_000;

const schema = z.object({
  pattern: z.string().describe("Regular expression (JavaScript syntax)."),
  cwd: z.string().optional().describe("Directory to search in."),
  path: z.string().optional().describe("Directory or single file to search (alias of `cwd`)."),
  include: z
    .string()
    .optional()
    .describe("Glob to limit files (e.g. \"*.ts\", \"*.{ts,tsx}\", \"src/**/*.ts\"). A glob without `/` matches the file name at any depth."),
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
    "Regex search over file contents (`file:line: snippet`). Optional `include` glob; " +
    "`context` lines default 1. Prefer over `read_file` for discovery; use `glob` for names.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const target = input.path ?? input.cwd ?? ".";
    const guard = await guardPath(ctx, target, "read");
    if (guard) return guard;
    const base = resolve(ctx.cwd, target);
    const max = input.maxResults ?? 200;
    const ctxLines = input.context ?? 1;
    const re = new RegExp(input.pattern);
    const include = input.include ? compileInclude(input.include) : null;
    const hits: GrepHit[] = [];
    const baseStat = await stat(base).catch(() => null);
    if (!baseStat) return { content: `path not found: ${target}`, isError: true };
    if (baseStat.isFile()) {
      await searchFile(base, relative(ctx.cwd, base) || base, re, ctxLines, hits, max);
    } else {
      await walk(base, base, re, include, ctxLines, hits, max, 0);
    }
    if (hits.length === 0) {
      return { content: "(no matches)" };
    }
    const full = hits.map((h) => `${h.file}:${h.line + 1}: ${h.text}`).join("\n");
    if (full.length > ARTIFACT_THRESHOLD) {
 // Spill the full match list to an artifact; keep a head slice inline so
 // the model sees the first (usually most relevant) matches and can pull
 // the rest with read_artifact instead of re-running the grep.
      const artifactRef = await ctx.artifact(full, `grep:${input.pattern.slice(0, 60)}`);
      const omitted = full.length - HEAD_CHARS;
      const head = full.slice(0, HEAD_CHARS);
      return {
        content:
          `${hits.length} matches (${full.length.toLocaleString()} chars; showing the first ${HEAD_CHARS.toLocaleString()}).\n` +
          `${head}\n\n[... ${omitted.toLocaleString()} chars omitted; full match list in artifact ${artifactRef} — ` +
          `narrow the \`pattern\`/\`include\` or use read_artifact for the rest. Do NOT re-run the same grep ...]`,
        artifactRef,
      };
    }
    return { content: full };
  },
};

async function walk(
  root: string,
  dir: string,
  re: RegExp,
  include: ((rel: string) => boolean) | null,
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
      const rel =
        abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs === root ? "" : abs;
      if (shouldSkipWalkDir(rel || ent.name, ent.name)) continue;
      await walk(root, abs, re, include, ctxLines, out, cap, depth + 1);
    } else if (ent.isFile()) {
      const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
      if (include && !include(rel)) continue;
      await searchFile(abs, rel, re, ctxLines, out, cap);
    }
  }
}

async function searchFile(
  abs: string,
  rel: string,
  re: RegExp,
  ctxLines: number,
  out: GrepHit[],
  cap: number
): Promise<void> {
  try {
    const st = await stat(abs);
    if (st.size > 2 * 1024 * 1024) return; // skip >2MB files for built-in walker
    const text = await readFile(abs, "utf-8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (out.length >= cap) return;
      if (re.test(lines[i]!)) {
        const start = Math.max(0, i - ctxLines);
        const end = Math.min(lines.length, i + ctxLines + 1);
        out.push({ file: rel, line: i, text: lines.slice(start, end).join("\n") });
        i = end - 1;
      }
    }
  } catch {
 // binary or unreadable; skip
  }
}

/** ripgrep `-g` semantics: a glob without `/` matches the basename at any
 * depth; otherwise it matches the path relative to the search root.
 * `{a,b}` alternatives are expanded. */
export function compileInclude(pattern: string): (rel: string) => boolean {
  const res = expandBraces(pattern).map((p) => ({ re: compileGlob(p), basename: !p.includes("/") }));
  return (rel) => {
    const norm = rel.split(sep).join("/");
    const name = norm.slice(norm.lastIndexOf("/") + 1);
    return res.some(({ re, basename }) => re.test(basename ? name : norm));
  };
}

function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const pre = pattern.slice(0, m.index);
  const post = pattern.slice(m.index + m[0].length);
  return m[1]!.split(",").flatMap((alt) => expandBraces(pre + alt + post));
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
