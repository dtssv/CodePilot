// grep: regex file-content search. The default backend is a dependency-free
// built-in file walker (honours the shared ignore list, skips >2MB files, caps
// matches). An optional ripgrep backend (config `grep.backend`) shells out to
// `rg` when it is on PATH — much faster on a large tree — and falls back to the
// walker when ripgrep is absent or fails. No native binary is bundled.

import { z } from "zod";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { ToolDef } from "./types.js";
import { shouldSkipWalkDir, guardPath, ARTIFACT_THRESHOLD } from "./_shared.js";

/** How many chars of the match list to keep inline before spilling the rest to
 * an artifact. Head-only (first matches are usually the most relevant); the
 * spill threshold itself is the shared {@link ARTIFACT_THRESHOLD}. A huge grep
 * result otherwise sits verbatim in the transcript and gets re-sent every turn,
 * ballooning tokens and slowing the whole session. */
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

export interface GrepHit {
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

    // Backend selection: "rg"/"auto" try ripgrep (fast native scan) when it is
    // on PATH; "auto" and the rg-missing/failed case fall back to the walker.
    const backend = ctx.config?.grep?.backend ?? "walker";
    const wantRg = backend === "rg" || backend === "auto";
    if (wantRg && baseStat.isDirectory()) {
      const rg = await runRipgrep(base, input.pattern, input.include, ctxLines, max);
      if (rg) {
        for (const h of rg) hits.push(h);
      } else {
        // ripgrep unavailable or errored → built-in walker.
        await walk(base, base, re, include, ctxLines, hits, max, 0);
      }
    } else if (baseStat.isFile()) {
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

/**
 * Search `base` with ripgrep, parsing rg's `file:line:text` output into hits,
 * or null when rg is unavailable so the caller falls back to the walker. Context
 * lines collapse into each hit's text; rg's ignore rules stand in for the walker.
 */
async function runRipgrep(
  base: string,
  pattern: string,
  include: string | undefined,
  ctxLines: number,
  cap: number,
): Promise<GrepHit[] | null> {
  const args = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--max-filesize",
    "2M",
    "--max-count",
    String(cap),
  ];
  if (ctxLines > 0) args.push("--context", String(ctxLines));
  for (const g of include ? expandBraces(include) : []) args.push("--glob", g);
  args.push("--regexp", pattern, base);

  return new Promise<GrepHit[] | null>((resolveHits) => {
    let child;
    try {
      child = spawn("rg", args, { cwd: base });
    } catch {
      resolveHits(null);
      return;
    }
    let out = "";
    let stderr = "";
    let bytes = 0;
    const SOFT_CAP = 8 * 1024 * 1024;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (b: string) => {
      bytes += b.length;
      if (bytes > SOFT_CAP) {
        out += b;
        child.kill();
        return;
      }
      out += b;
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (b: string) => (stderr += b));
    child.on("error", () => resolveHits(null)); // rg not on PATH
    child.on("close", (code) => {
      // rg exits 1 for "no matches" (not an error); >1 is a real failure.
      if (code !== null && code > 1) {
        resolveHits(stderr.length > 0 ? null : []);
        return;
      }
      resolveHits(parseRipgrep(out, base, ctxLines, cap));
    });
  });
}

/** Parse ripgrep `--context` output into {@link GrepHit}s relative to `base`.
 * Match lines are `path:line:text`; context lines are `path-line-text`; `--`
 * separates hit groups. Each match + its surrounding context collapses into one
 * hit, mirroring the walker (context lines are already supplied by rg). */
export function parseRipgrep(out: string, base: string, _ctxLines: number, cap: number): GrepHit[] {
  const hits: GrepHit[] = [];
  if (out.length === 0) return hits;
  let entries: { file: string; line: number; raw: string; isMatch: boolean }[] = [];
  for (const rawLine of out.split("\n")) {
    if (rawLine === "") continue;
    if (rawLine === "--") {
      finalizeGroup(entries, hits, base);
      entries = [];
      if (hits.length >= cap) break;
      continue;
    }
    const parsed = parseRgLine(rawLine);
    if (parsed) entries.push(parsed);
  }
  if (hits.length < cap) finalizeGroup(entries, hits, base);
  return hits.slice(0, cap);
}

/** One rg output line: `path:line:text` (match) or `path-line-text` (context). */
function parseRgLine(
  line: string,
): { file: string; line: number; raw: string; isMatch: boolean } | null {
  // Match line: first `:` after a line number. rg prints `file:lineno:text`.
  const mMatch = /^(.*?):(\d+):(.*)$/.exec(line);
  const mCtx = /^(.*?)-(\d+)-(.*)$/.exec(line);
  const m = mMatch ?? mCtx;
  if (!m) return null;
  return { file: m[1]!, line: Number(m[2]!) - 1, raw: m[3]!, isMatch: mMatch !== null };
}

/** Turn a group of rg lines into GrepHit(s). With `--context 0` rg emits no
 * context lines and no `--` separators, so each match line is its own hit; with
 * context, a group is one match plus its surrounding `-` context lines, which
 * collapse into a single hit's text (mirroring the walker). */
function finalizeGroup(
  entries: { file: string; line: number; raw: string; isMatch: boolean }[],
  hits: GrepHit[],
  base: string,
): void {
  if (entries.length === 0) return;
  const hasContext = entries.some((e) => !e.isMatch);
  if (!hasContext) {
    // No context lines: one hit per match line.
    for (const e of entries) {
      hits.push({ file: relativeToBase(e.file, base), line: e.line, text: e.raw });
    }
    return;
  }
  const match = entries.find((e) => e.isMatch) ?? entries[0]!;
  hits.push({
    file: relativeToBase(match.file, base),
    line: match.line,
    text: entries.map((e) => e.raw).join("\n"),
  });
}

/** rg may print absolute or base-relative paths; normalize to base-relative. */
function relativeToBase(file: string, base: string): string {
  if (file.startsWith(base + sep)) return file.slice(base.length + 1);
  const r = relative(base, file);
  return r && !r.startsWith("..") ? r : file;
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
