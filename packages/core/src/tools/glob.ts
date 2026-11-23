// glob: filesystem glob matching. Prefers ripgrep `--files` (same binary as
// grep) for .gitignore + modified sort; falls back to a small JS walker.

import { z } from "zod";
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ToolDef } from "./types.js";
import {
  shouldSkipWalkDir,
  guardPath,
  rgRuntimeExcludeArgs,
  rgVcsExcludeArgs,
} from "./_shared.js";
import { resolveRgBinary } from "./grep.js";

/** Wall-clock cap for ripgrep `--files` (aligned with grep). */
const RG_TIMEOUT_MS = 30_000;

const schema = z.object({
  pattern: z.string().describe("Glob pattern (e.g. \"src/**/*.ts\")."),
  cwd: z.string().optional().describe("Base directory (default: session cwd)."),
  path: z
    .string()
    .optional()
    .describe("Base directory (alias of `cwd`, same as grep)."),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Cap on number of matches (default 250)."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Skip this many matches before applying maxResults (pagination)."),
  type: z
    .string()
    .optional()
    .describe("Ripgrep `--type` filter (e.g. ts, py). Combined with pattern when using rg."),
  includeIgnored: z
    .boolean()
    .optional()
    .describe(
      "Also include gitignored / hard-ignored dirs (node_modules, dist, …). Default false.",
    ),
});

export const globTool: ToolDef<typeof schema> = {
  name: "glob",
  description:
    "Find files by glob (e.g. `src/**/*.ts`). Prefer over shell `find`. " +
    "Uses ripgrep when available (respects .gitignore, sorted by modified); " +
    "otherwise a JS walker that skips node_modules/.git/dist. " +
    "Use `grep` for contents, `ls` for one directory. " +
    "Safe to call in parallel with `grep`/`read_file`.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const baseIn = input.path ?? input.cwd ?? ".";
    const guard = await guardPath(ctx, baseIn, "read");
    if (guard) return guard;
    const base = resolve(ctx.cwd, baseIn);
    const max = input.maxResults ?? 250;
    const offset = input.offset ?? 0;
    const includeIgnored = input.includeIgnored === true;
    const fileType = input.type?.trim() || undefined;
    // Fetch offset+max (+1) so truncation is only reported when more exist.
    const fetchCap = max + offset + 1;
    const viaRg = await runRgFiles(
      base,
      input.pattern,
      fetchCap,
      includeIgnored,
      ctx.signal,
      fileType,
    );
    const matches = viaRg ?? (await walkCollect(base, input.pattern, fetchCap, includeIgnored));
    if (matches.length === 0) return { content: "(no matches)" };
    const paged = offset > 0 ? matches.slice(offset) : matches;
    const capped = paged.length > max;
    const shown = capped ? paged.slice(0, max) : paged;
    const body = shown.join("\n");
    const pageNote =
      offset > 0 || fileType
        ? `[appliedOffset=${offset}; appliedLimit=${max}` +
          (fileType ? `; type=${fileType}` : "") +
          `]\n`
        : "";
    return {
      content: capped
        ? `${pageNote}${body}\n\n[truncated at ${max} results; narrow the pattern or raise maxResults]`
        : `${pageNote}${body}`,
    };
  },
};

/** rg --files --glob --sort=modified. Returns null when rg is unavailable. */
async function runRgFiles(
  cwd: string,
  pattern: string,
  cap: number,
  includeIgnored: boolean,
  signal?: AbortSignal,
  type?: string,
): Promise<string[] | null> {
  const bin = await resolveRgBinary();
  if (!bin) return null;
  // `--no-config`: block host RIPGREP_CONFIG_PATH / `--pre` injection.
  const args = [
    "--no-config",
    "--files",
    "--color=never",
    "--sort",
    "modified",
    "--glob",
    pattern,
  ];
  if (type) args.push("--type", type);
  // Match grep: always search hidden non-ignored paths (e.g. `.github/`).
  args.push("--hidden");
  if (includeIgnored) args.push("--no-ignore");
  // Always exclude VCS + CodePilot runtime dirs.
  args.push(...rgVcsExcludeArgs(), ...rgRuntimeExcludeArgs());
  return new Promise((resolveHits) => {
    let child;
    try {
      child = spawn(bin, args, { cwd });
    } catch {
      resolveHits(null);
      return;
    }
    let settled = false;
    const finish = (v: string[] | null): void => {
      if (settled) return;
      settled = true;
      resolveHits(v);
    };
    const hits: string[] = [];
    let buf = "";
    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      finish(hits.length > 0 ? hits : null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      finish(hits.length > 0 ? hits : null);
    }, RG_TIMEOUT_MS);
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        hits.push(line);
        if (hits.length >= cap) {
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          finish(hits);
          return;
        }
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      finish(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (buf.trim()) hits.push(buf.trim());
      finish(hits);
    });
  });
}

function compileGlob(pattern: string): RegExp {
  // Translate glob → regex (`*`, `**`, `?`, character classes).
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i++;
        }
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

async function walkCollect(
  root: string,
  pattern: string,
  cap: number,
  includeIgnored: boolean,
): Promise<string[]> {
  const matches: string[] = [];
  const matcher = compileGlob(pattern);
  await walk(root, root, matcher, matches, cap, includeIgnored);
  return matches;
}

async function walk(
  root: string,
  dir: string,
  matcher: RegExp,
  out: string[],
  cap: number,
  includeIgnored: boolean,
): Promise<void> {
  if (out.length >= cap) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= cap) return;
    const abs = join(dir, ent.name);
    const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
    if (ent.isDirectory()) {
      if (shouldSkipWalkDir(rel || ent.name, ent.name, includeIgnored)) continue;
      await walk(root, abs, matcher, out, cap, includeIgnored);
      // Files only — matching directories confuses models expecting paths to read.
    } else if (ent.isFile()) {
      if (matcher.test(rel)) out.push(rel);
    } else if (ent.isSymbolicLink()) {
      try {
        const st = await stat(abs);
        if (st.isFile() && matcher.test(rel)) out.push(rel);
      } catch {
        /* ignore */
      }
    }
  }
}
