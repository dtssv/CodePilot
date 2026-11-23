// grep: regex file-content search. Default backend is ripgrep (packaged
// `@vscode/ripgrep`, else `rg` on PATH), whose regex dialect is the de-facto
// standard. Config `grep.backend: "walker"` forces the dependency-free JS
// walker; `"rg"` / `"auto"` (default) try ripgrep first and fall back to the
// walker when the binary is missing or fails to launch.

import { z } from "zod";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { ToolDef } from "./types.js";
import {
  shouldSkipWalkDir,
  guardPath,
  rgRuntimeExcludeArgs,
  rgVcsExcludeArgs,
} from "./_shared.js";

/** Walker recursion / file-size limits (visible in result footers when hit). */
const WALKER_MAX_DEPTH = 16;
const WALKER_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Notes accumulated while the JS walker applies hard caps (rendered as a footer). */
export type WalkerLimitNotes = {
  depthCapped: boolean;
  skippedLargeFiles: number;
  hitResultCap: boolean;
};

export function emptyWalkerNotes(): WalkerLimitNotes {
  return { depthCapped: false, skippedLargeFiles: 0, hitResultCap: false };
}

export function formatWalkerLimitFooter(notes: WalkerLimitNotes): string | null {
  const parts: string[] = [];
  if (notes.depthCapped) parts.push(`depth limit ${WALKER_MAX_DEPTH}`);
  if (notes.skippedLargeFiles > 0) {
    parts.push(`skipped ${notes.skippedLargeFiles} files >${WALKER_MAX_FILE_BYTES / (1024 * 1024)}MB`);
  }
  if (notes.hitResultCap) parts.push("result cap reached");
  if (parts.length === 0) return null;
  return `[search limits: ${parts.join("; ")}]`;
}

/** How many chars of the match list to keep inline before spilling the rest to
 * an artifact. Head-only (first matches are usually the most relevant); spill
 * triggers when the full list exceeds this window. A huge grep result otherwise
 * sits verbatim in the transcript and gets re-sent every turn, ballooning
 * tokens and slowing the whole session. */
const HEAD_CHARS = 6_000;

/** Per-line clamp for match text (rg `--max-columns` + walker truncate). */
const MAX_GREP_LINE_CHARS = 2000;

/** Wall-clock cap for a ripgrep child. */
const RG_TIMEOUT_MS = 30_000;

const schema = z.object({
  pattern: z
    .string()
    .describe(
      "Regular expression (ripgrep / Rust regex syntax). Use a leading `(?i)` or " +
        "`caseSensitive: false` for case-insensitive search. Lookaround/backreferences " +
        "need a PCRE2-capable `rg` and are not guaranteed.",
    ),
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
    .describe("Max matches / files / count lines (default 200), depending on output_mode."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Skip this many matches before applying maxResults (pagination)."),
  type: z
    .string()
    .optional()
    .describe("Ripgrep `--type` filter (e.g. ts, py, rust). Prefer over crafting include globs."),
  context: z
    .number()
    .int()
    .nonnegative()
    .max(20)
    .optional()
    .describe("Lines of context around each match (content mode only; default 0)."),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe(
      "`content` (default): `file:line: snippet`. `files_with_matches`: unique paths. " +
        "`count`: `file:N` match counts.",
    ),
  caseSensitive: z
    .boolean()
    .optional()
    .describe("Case-sensitive search (default true). false → ripgrep `--ignore-case`."),
  literal: z
    .boolean()
    .optional()
    .describe("Treat pattern as a fixed string (ripgrep `--fixed-strings`), not a regex."),
  includeIgnored: z
    .boolean()
    .optional()
    .describe(
      "Also search gitignored / hidden / hard-ignored dirs (node_modules, dist, …). Default false.",
    ),
});

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

export type GrepOutputMode = "content" | "files_with_matches" | "count";

export const grepTool: ToolDef<typeof schema> = {
  name: "grep",
  description:
    "Search file contents with ripgrep (`file:line: snippet` by default). Prefer over " +
    "shell `grep`/`rg` and over reading whole files. `output_mode`: content | files_with_matches | count. " +
    "Optional `include` glob; `context` (content only, default 0); `literal` / `caseSensitive: false`. " +
    "Parallelise independent greps/reads in one turn. Use `glob` for names only.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const target = input.path ?? input.cwd ?? ".";
    const guard = await guardPath(ctx, target, "read");
    if (guard) return guard;
    const base = resolve(ctx.cwd, target);
    const max = input.maxResults ?? 200;
    const offset = input.offset ?? 0;
    const mode: GrepOutputMode = input.output_mode ?? "content";
    const ctxLines = mode === "content" ? (input.context ?? 0) : 0;
    const include = input.include ? compileInclude(input.include) : null;
    const caseSensitive = input.caseSensitive !== false;
    const literal = input.literal === true;
    const includeIgnored = input.includeIgnored === true;
    const fileType = input.type?.trim() || undefined;
    // Fetch offset+max (+1) so truncation is only reported when more exist
    // (same sentinel pattern as glob.ts — exact page fill must not false-positive).
    const fetchCap = max + offset + 1;
    const hits: GrepHit[] = [];
    const fileHits: string[] = [];
    const counts: { file: string; count: number }[] = [];
    const walkNotes = emptyWalkerNotes();
    const baseStat = await stat(base).catch(() => null);
    if (!baseStat) return { content: `path not found: ${target}`, isError: true };

    // Default `rg`/`auto`: packaged or PATH ripgrep first (model-facing dialect).
    // `walker` skips that path. Missing/broken binary → JS walker fallback.
    const backend = ctx.config?.grep?.backend ?? "rg";
    const wantRg = backend === "rg" || backend === "auto";
    let usedRg = false;
    if (wantRg) {
      const cwd = baseStat.isDirectory() ? base : dirname(base);
      const rgTarget = baseStat.isDirectory() ? "." : base;
      const rg = await runRipgrep({
        cwd,
        target: rgTarget,
        pattern: input.pattern,
        include: input.include,
        ctxLines,
        cap: fetchCap,
        mode,
        caseSensitive,
        literal,
        includeIgnored,
        type: fileType,
        signal: ctx.signal,
      });
      if (rg && "error" in rg) {
        return { content: rg.error, isError: true };
      }
      if (rg && "hits" in rg) {
        usedRg = true;
        for (const h of rg.hits) hits.push(h);
        for (const f of rg.files ?? []) fileHits.push(f);
        for (const c of rg.counts ?? []) counts.push(c);
      }
    }
    if (!usedRg) {
      let pattern = input.pattern;
      if (!caseSensitive && !/^\(\?[a-z]*i/i.test(pattern)) {
        pattern = `(?i)${pattern}`;
      }
      const compiled = literal
        ? compileLiteralPattern(pattern, caseSensitive)
        : compileGrepPattern(pattern);
      if ("error" in compiled) {
        return { content: compiled.error, isError: true };
      }
      const { re } = compiled;
      const relBase = relative(ctx.cwd, base) || base;
      if (mode === "files_with_matches") {
        if (baseStat.isFile()) {
          await matchWholeFile(base, relBase, re, include, fileHits, fetchCap, walkNotes);
        } else {
          await walkFiles(base, base, re, include, fileHits, fetchCap, 0, includeIgnored, walkNotes);
        }
      } else if (mode === "count") {
        if (baseStat.isFile()) {
          await countFile(base, relBase, re, include, counts, fetchCap, walkNotes);
        } else {
          await walkCounts(base, base, re, include, counts, fetchCap, 0, includeIgnored, walkNotes);
        }
      } else if (baseStat.isFile()) {
        await searchFile(base, relBase, re, ctxLines, hits, fetchCap, walkNotes);
      } else {
        await walk(base, base, re, include, ctxLines, hits, fetchCap, 0, includeIgnored, walkNotes);
      }
    }
    // Apply pagination offset, then report truncation only when the +1 sentinel filled.
    if (offset > 0) {
      hits.splice(0, offset);
      fileHits.splice(0, offset);
      counts.splice(0, offset);
    }
    const truncated =
      mode === "files_with_matches"
        ? fileHits.length > max
        : mode === "count"
          ? counts.length > max
          : hits.length > max;
    if (hits.length > max) hits.length = max;
    if (fileHits.length > max) fileHits.length = max;
    if (counts.length > max) counts.length = max;

    const limitFooter = !usedRg ? formatWalkerLimitFooter(walkNotes) : null;
    const pageBits: string[] = [];
    if (truncated) {
      pageBits.push(`truncated at ${max}; pass offset=${offset + max} for more`);
    }
    if (offset > 0) pageBits.push(`appliedOffset=${offset}`);
    if (fileType) pageBits.push(`type=${fileType}`);
    const pageNote = pageBits.length > 0 ? `[${pageBits.join("; ")}]\n` : "";
    const withFooter = (body: string): string => {
      const headed = pageNote ? pageNote + body : body;
      return limitFooter ? `${headed}\n${limitFooter}` : headed;
    };

    if (mode === "files_with_matches") {
      if (fileHits.length === 0) return { content: withFooter("(no matches)") };
      const spilled = await spillIfLarge(fileHits.join("\n"), fileHits.length, input.pattern, ctx);
      return { ...spilled, content: withFooter(spilled.content) };
    }
    if (mode === "count") {
      if (counts.length === 0) return { content: withFooter("(no matches)") };
      const full = counts.map((c) => `${c.file}:${c.count}`).join("\n");
      const spilled = await spillIfLarge(full, counts.length, input.pattern, ctx);
      return { ...spilled, content: withFooter(spilled.content) };
    }
    if (hits.length === 0) {
      return { content: withFooter("(no matches)") };
    }
    const full = hits.map((h) => `${h.file}:${h.line + 1}: ${h.text}`).join("\n");
    const spilled = await spillIfLarge(full, hits.length, input.pattern, ctx);
    return { ...spilled, content: withFooter(spilled.content) };
  },
};
async function spillIfLarge(
  full: string,
  n: number,
  pattern: string,
  ctx: { artifact: (text: string, label: string) => Promise<string> },
) {
  // Spill only when the body exceeds the inline head window so `omitted` stays
  // non-negative (a lower shared artifact threshold used to trigger early).
  if (full.length > HEAD_CHARS) {
    const artifactRef = await ctx.artifact(full, `grep:${pattern.slice(0, 60)}`);
    const headLen = HEAD_CHARS;
    const omitted = full.length - headLen;
    const head = full.slice(0, headLen);
    return {
      content:
        `${n} matches (${full.length.toLocaleString()} chars; showing the first ${headLen.toLocaleString()}).\n` +
        `${head}\n\n[... ${omitted.toLocaleString()} chars omitted; full match list in artifact ${artifactRef} — ` +
        `narrow the \`pattern\`/\`include\` or use read_artifact for the rest. Do NOT re-run the same grep ...]`,
      artifactRef,
    };
  }
  return { content: full };
}

function compileLiteralPattern(
  pattern: string,
  caseSensitive: boolean,
): { re: RegExp; forRipgrep: string } | { error: string } {
  // Peel a leading (?i) if present so it does not become literal text.
  let body = pattern;
  let flags = caseSensitive ? "" : "i";
  const lead = /^\(\?([a-z]*)\)/i.exec(body);
  if (lead) {
    const enable = (lead[1] ?? "").split("-")[0] ?? "";
    if (enable.includes("i") && !flags.includes("i")) flags += "i";
    body = body.slice(lead[0].length);
  }
  try {
    return { re: new RegExp(escapeRegExp(body), flags), forRipgrep: body };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `invalid literal pattern: ${msg}` };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function matchWholeFile(
  abs: string,
  rel: string,
  re: RegExp,
  include: ((rel: string) => boolean) | null,
  out: string[],
  cap: number,
  notes: WalkerLimitNotes,
): Promise<void> {
  if (out.length >= cap) {
    notes.hitResultCap = true;
    return;
  }
  if (include && !include(rel)) return;
  try {
    const st = await stat(abs);
    if (st.size > WALKER_MAX_FILE_BYTES) {
      notes.skippedLargeFiles++;
      return;
    }
    const text = await readFile(abs, "utf-8");
    if (re.test(text)) {
      out.push(rel);
      if (out.length >= cap) notes.hitResultCap = true;
    }
  } catch {
    /* skip */
  }
}

async function walkFiles(
  root: string,
  dir: string,
  re: RegExp,
  include: ((rel: string) => boolean) | null,
  out: string[],
  cap: number,
  depth: number,
  includeIgnored = false,
  notes: WalkerLimitNotes = emptyWalkerNotes(),
): Promise<void> {
  if (out.length >= cap) {
    notes.hitResultCap = true;
    return;
  }
  if (depth > WALKER_MAX_DEPTH) {
    notes.depthCapped = true;
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= cap) {
      notes.hitResultCap = true;
      return;
    }
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      const rel =
        abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs === root ? "" : abs;
      if (shouldSkipWalkDir(rel || ent.name, ent.name, includeIgnored)) continue;
      await walkFiles(root, abs, re, include, out, cap, depth + 1, includeIgnored, notes);
    } else if (ent.isFile()) {
      const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
      await matchWholeFile(abs, rel, re, include, out, cap, notes);
    }
  }
}

async function walkCounts(
  root: string,
  dir: string,
  re: RegExp,
  include: ((rel: string) => boolean) | null,
  out: { file: string; count: number }[],
  cap: number,
  depth: number,
  includeIgnored = false,
  notes: WalkerLimitNotes = emptyWalkerNotes(),
): Promise<void> {
  if (out.length >= cap) {
    notes.hitResultCap = true;
    return;
  }
  if (depth > WALKER_MAX_DEPTH) {
    notes.depthCapped = true;
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= cap) {
      notes.hitResultCap = true;
      return;
    }
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      const rel =
        abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs === root ? "" : abs;
      if (shouldSkipWalkDir(rel || ent.name, ent.name, includeIgnored)) continue;
      await walkCounts(root, abs, re, include, out, cap, depth + 1, includeIgnored, notes);
    } else if (ent.isFile()) {
      const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
      await countFile(abs, rel, re, include, out, cap, notes);
    }
  }
}

async function countFile(
  abs: string,
  rel: string,
  re: RegExp,
  include: ((rel: string) => boolean) | null,
  out: { file: string; count: number }[],
  cap: number,
  notes: WalkerLimitNotes,
): Promise<void> {
  if (out.length >= cap) {
    notes.hitResultCap = true;
    return;
  }
  if (include && !include(rel)) return;
  try {
    const st = await stat(abs);
    if (st.size > WALKER_MAX_FILE_BYTES) {
      notes.skippedLargeFiles++;
      return;
    }
    const text = await readFile(abs, "utf-8");
    const lines = text.split(/\r?\n/);
    let n = 0;
    for (const line of lines) {
      // Reset lastIndex for global-ish patterns; our regexes are not /g by default.
      if (re.test(line)) n++;
    }
    if (n > 0) {
      out.push({ file: rel, count: n });
      if (out.length >= cap) notes.hitResultCap = true;
    }
  } catch {
    /* skip */
  }
}

async function walk(
  root: string,
  dir: string,
  re: RegExp,
  include: ((rel: string) => boolean) | null,
  ctxLines: number,
  out: GrepHit[],
  cap: number,
  depth: number,
  includeIgnored = false,
  notes: WalkerLimitNotes = emptyWalkerNotes(),
): Promise<void> {
  if (out.length >= cap) {
    notes.hitResultCap = true;
    return;
  }
  if (depth > WALKER_MAX_DEPTH) {
    notes.depthCapped = true;
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= cap) {
      notes.hitResultCap = true;
      return;
    }
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      const rel =
        abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs === root ? "" : abs;
      if (shouldSkipWalkDir(rel || ent.name, ent.name, includeIgnored)) continue;
      await walk(root, abs, re, include, ctxLines, out, cap, depth + 1, includeIgnored, notes);
    } else if (ent.isFile()) {
      const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
      if (include && !include(rel)) continue;
      await searchFile(abs, rel, re, ctxLines, out, cap, notes);
    }
  }
}

/** Cached absolute path to the ripgrep binary, or `"rg"` to use PATH, or `null` if
 * probing already proved nothing usable exists. */
let cachedRgBinary: string | null | undefined;

/**
 * Resolve the ripgrep binary: packaged `@vscode/ripgrep` first, then a bare
 * `rg` on PATH. Result is cached for the process lifetime.
 */
export async function resolveRgBinary(): Promise<string | null> {
  if (cachedRgBinary !== undefined) return cachedRgBinary;
  try {
    const mod = await import("@vscode/ripgrep");
    const p = typeof mod.rgPath === "string" ? mod.rgPath : null;
    if (p) {
      cachedRgBinary = p;
      return p;
    }
  } catch {
    // optional / wrong-platform package — fall through to PATH
  }
  cachedRgBinary = "rg";
  return cachedRgBinary;
}

/** Reset the cached binary path (tests). */
export function resetRgBinaryCache(): void {
  cachedRgBinary = undefined;
}

function isInvalidRgPattern(stderr: string): boolean {
  return /regex|regular expression|syntax error|parse error|invalid/i.test(stderr);
}

type RipgrepOutcome =
  | { hits: GrepHit[]; files?: string[]; counts?: { file: string; count: number }[] }
  | { error: string }
  | null;

type RipgrepOpts = {
  cwd: string;
  target: string;
  pattern: string;
  include: string | undefined;
  ctxLines: number;
  cap: number;
  mode: GrepOutputMode;
  caseSensitive: boolean;
  literal: boolean;
  includeIgnored?: boolean;
  type?: string;
  signal?: AbortSignal;
};

/**
 * Search with ripgrep. Returns `{ hits }` / `{ files }` / `{ counts }` depending
 * on mode, `{ error }` for a bad pattern, or `null` when rg is unavailable.
 */
async function runRipgrep(opts: RipgrepOpts): Promise<RipgrepOutcome> {
  const { cwd, target, pattern, include, ctxLines, cap, mode, caseSensitive, literal, type } = opts;
  const bin = await resolveRgBinary();
  if (!bin) return null;

  // Do NOT pass `--max-count` for content mode: in ripgrep that is a *per-file*
  // cap, so N files × cap floods stdout before parseRipgrep slices to `cap`.
  // Instead stream until we have enough match lines, then kill the child.
  // `--no-config`: host RIPGREP_CONFIG_PATH / rg.conf can inject `--pre=<cmd>`
  // (arbitrary code). Always pass this.
  const args = [
    "--no-config",
    "--with-filename",
    "--no-heading",
    "--color=never",
    "--max-filesize",
    "2M",
    // Clamp pathological minified lines to the walker's MAX_LINE_CHARS.
    "--max-columns",
    String(MAX_GREP_LINE_CHARS),
    // Keep a truncated preview instead of dropping the whole match line.
    "--max-columns-preview",
  ];
  if (mode === "files_with_matches") {
    args.push("--files-with-matches");
  } else if (mode === "count") {
    args.push("--count");
  } else {
    args.push("--line-number");
    if (ctxLines > 0) args.push("--context", String(ctxLines));
  }
  if (!caseSensitive) args.push("--ignore-case");
  if (literal) args.push("--fixed-strings");
  if (type) args.push("--type", type);
  // Always search hidden (non-ignored) paths like `.github/`. `includeIgnored`
  // still adds `--no-ignore` for gitignored / hard-ignored trees.
  args.push("--hidden");
  if (opts.includeIgnored) args.push("--no-ignore");
  // Always exclude VCS metadata and CodePilot runtime dirs. Critical with
  // `--hidden` / `--no-ignore`.
  args.push(...rgVcsExcludeArgs(), ...rgRuntimeExcludeArgs());
  for (const g of include ? expandBraces(include) : []) args.push("--glob", g);
  // Pattern and path behind `--` so a leading-dash value cannot be a flag.
  args.push("--regexp", pattern, "--", target);

  return new Promise<RipgrepOutcome>((resolveHits) => {
    let child;
    try {
      child = spawn(bin, args, { cwd });
    } catch {
      resolveHits(null);
      return;
    }
    let settled = false;
    const finish = (v: RipgrepOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolveHits(v);
    };
    const killChild = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 3_000);
    };
    const onAbort = (): void => {
      killChild();
      finish({ error: "grep aborted" });
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        killChild();
        finish({ error: "grep aborted" });
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      killChild();
      finish({
        error: `grep timed out after ${RG_TIMEOUT_MS}ms (pattern=${JSON.stringify(pattern)})`,
      });
    }, RG_TIMEOUT_MS);

    let out = "";
    let stderr = "";
    let bytes = 0;
    const SOFT_CAP = 8 * 1024 * 1024;
    // Content-mode budget ≈ global cap × clamped line × context window, so we
    // stop rg once we have enough for parseRipgrep to fill `cap` hits.
    const contentBudget =
      mode === "content"
        ? Math.min(
            SOFT_CAP,
            cap * (MAX_GREP_LINE_CHARS + 96) * (ctxLines * 2 + 1) + 8192,
          )
        : SOFT_CAP;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (b: string) => {
      bytes += b.length;
      out += b;
      if (bytes > contentBudget) child.kill();
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (b: string) => (stderr += b));
    child.on("error", () => finish(null)); // binary missing / not executable
    child.on("close", (code) => {
      // rg exits 1 for "no matches" (not an error); >1 is a real failure.
      if (code !== null && code > 1) {
        const detail = stderr.trim();
        if (detail && isInvalidRgPattern(detail)) {
          finish({
            error:
              `invalid pattern: ${detail}\n` +
              `grep uses ripgrep (Rust regex) syntax. Leading \`(?i)\` is fine for case-insensitive ` +
              `search; or set \`caseSensitive: false\`. Received: ${JSON.stringify(pattern)}`,
          });
          return;
        }
        // Launch/IO failure → walker fallback when possible.
        finish(null);
        return;
      }
      if (mode === "files_with_matches") {
        const files = out
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((f) => relativeToBase(f, cwd))
          .slice(0, cap);
        finish({ hits: [], files });
        return;
      }
      if (mode === "count") {
        const counts: { file: string; count: number }[] = [];
        for (const line of out.split("\n")) {
          if (!line.trim()) continue;
          const m = /^(.*):(\d+)\s*$/.exec(line);
          if (!m) continue;
          const n = Number(m[2]);
          if (n <= 0) continue;
          counts.push({ file: relativeToBase(m[1]!, cwd), count: n });
          if (counts.length >= cap) break;
        }
        finish({ hits: [], counts });
        return;
      }
      finish({ hits: parseRipgrep(out, cwd, ctxLines, cap) });
    });
  });
}

/** Parse ripgrep `--context` output into {@link GrepHit}s relative to `base`.
 * Match lines are `path:line:text`; context lines are `path-line-text`; `--`
 * separates hit groups. Each match + its surrounding context collapses into one
 * hit, mirroring the walker (context lines are already supplied by rg). */
export function parseRipgrep(out: string, base: string, ctxLines: number, cap: number): GrepHit[] {
  const hits: GrepHit[] = [];
  if (out.length === 0) return hits;
  let entries: { file: string; line: number; raw: string; isMatch: boolean }[] = [];
  for (const rawLine of out.split("\n")) {
    if (rawLine === "") continue;
    if (rawLine === "--") {
      finalizeGroup(entries, hits, base, ctxLines);
      entries = [];
      if (hits.length >= cap) break;
      continue;
    }
    const parsed = parseRgLine(rawLine);
    if (parsed) entries.push(parsed);
  }
  if (hits.length < cap) finalizeGroup(entries, hits, base, ctxLines);
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
  return {
    file: m[1]!,
    line: Number(m[2]!) - 1,
    raw: clampGrepLine(m[3]!),
    isMatch: mMatch !== null,
  };
}

/** Turn a group of rg lines into GrepHit(s). rg merges overlapping context
 * windows, so one `--`-delimited group can hold several matches; each match
 * becomes its own hit carrying `ctxLines` of context, and a match already
 * inside the previous hit's window is skipped — the walker's exact behaviour. */
function finalizeGroup(
  entries: { file: string; line: number; raw: string; isMatch: boolean }[],
  hits: GrepHit[],
  base: string,
  ctxLines: number,
): void {
  let windowEnd = -1;
  let windowFile = "";
  for (const m of entries) {
    if (!m.isMatch) continue;
    if (m.file === windowFile && m.line < windowEnd) continue;
    const lo = m.line - ctxLines;
    const hi = m.line + ctxLines;
    const text = entries
      .filter((e) => e.file === m.file && e.line >= lo && e.line <= hi)
      .map((e) => e.raw)
      .join("\n");
    hits.push({ file: relativeToBase(m.file, base), line: m.line, text });
    windowFile = m.file;
    windowEnd = hi + 1;
  }
}

/** rg may print absolute or base-relative paths; normalize to base-relative. */
function relativeToBase(file: string, base: string): string {
  if (file.startsWith(base + sep)) return file.slice(base.length + 1);
  const r = relative(base, file);
  let out = r && !r.startsWith("..") ? r : file;
  if (out.startsWith("./")) out = out.slice(2);
  return out;
}

function clampGrepLine(text: string): string {
  if (text.length <= MAX_GREP_LINE_CHARS) return text;
  return (
    text.slice(0, MAX_GREP_LINE_CHARS) +
    `… [${text.length - MAX_GREP_LINE_CHARS} chars truncated]`
  );
}

async function searchFile(
  abs: string,
  rel: string,
  re: RegExp,
  ctxLines: number,
  out: GrepHit[],
  cap: number,
  notes: WalkerLimitNotes,
): Promise<void> {
  try {
    const st = await stat(abs);
    if (st.size > WALKER_MAX_FILE_BYTES) {
      notes.skippedLargeFiles++;
      return;
    }
    const text = await readFile(abs, "utf-8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (out.length >= cap) {
        notes.hitResultCap = true;
        return;
      }
      if (re.test(lines[i]!)) {
        const start = Math.max(0, i - ctxLines);
        const end = Math.min(lines.length, i + ctxLines + 1);
        out.push({
          file: rel,
          line: i,
          text: lines.slice(start, end).map(clampGrepLine).join("\n"),
        });
        if (out.length >= cap) notes.hitResultCap = true;
        i = end - 1;
      }
    }
  } catch {
 // binary or unreadable; skip
  }
}

/**
 * Compile a grep pattern for the **walker fallback** (JavaScript `RegExp`).
 *
 * Primary search uses ripgrep and accepts `(?i)` natively. When falling back
 * to the walker, peel a single leading `(?flags)` group into JS constructor
 * flags — otherwise `new RegExp("(?i)x")` throws "Invalid group".
 */
export function compileGrepPattern(
  pattern: string,
): { re: RegExp; forRipgrep: string } | { error: string } {
  let body = pattern;
  let flags = "";
  // Only a leading group — mid-pattern `(?i)` stays invalid and surfaces below.
  const lead = /^\(\?([a-z]*)\)/i.exec(body);
  if (lead) {
    const raw = lead[1] ?? "";
    // Ignore disable syntax like `(?i-m)` / unknown letters; keep i/m/s/u/y.
    const enable = raw.split("-")[0] ?? "";
    for (const c of enable) {
      if ("imsuy".includes(c) && !flags.includes(c)) flags += c;
    }
    body = body.slice(lead[0].length);
  }
  try {
    const re = new RegExp(body, flags);
    const rgFlags = [...flags].filter((c) => "ims".includes(c)).join("");
    const forRipgrep = rgFlags.length > 0 ? `(?${rgFlags})${body}` : body;
    return { re, forRipgrep };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error:
        `invalid pattern: ${msg}\n` +
        `Walker fallback uses JavaScript RegExp; leading \`(?i)\`/\`(?m)\`/\`(?s)\` are mapped to ` +
        `JS flags. Prefer ripgrep syntax under the default \`rg\` backend. Received: ${JSON.stringify(pattern)}`,
    };
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
