// Memory: read & write project + user durable notes.
//
// Project: `~/.codepilot/projects/<hash>/MEMORY.md`; user: `~/.codepilot/MEMORY.md`.
// Four canonical sections (Project context, Rules, Architecture decisions,
// Discovered durable knowledge); parser also tolerates arbitrary `## <title>`.

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { MemorySink, MemoryWriteOpts } from "./tools/memory_write.js";
import { projectStatePath } from "./projectState.js";
import {
  resolveMemoryTopic,
  writeAutoMemoryNote,
  withMemoryWriteLock,
  type AutoMemoryConfig,
} from "./autoMemory.js";
import { redactSecrets, type RedactionPattern } from "./redact.js";
import { resolveRepoRoot } from "./worktree.js";

/** Legacy / shareable name still *read* from the workspace tree. */
export const PROJECT_MEMORY_NAME = "CODEPILOT.md";
/** Also recognised as project memory (AGENTS.md). */
export const AGENTS_MEMORY_NAME = "AGENTS.md";

/**
 * Instruction-file candidates read at each directory level, in precedence order
 * (first = highest). Override/local variants win over the formal file of the
 * same family; identical content is read only once.
 */
export const MEMORY_CANDIDATE_NAMES = [
  PROJECT_MEMORY_NAME,
  "AGENTS.override.md",
  AGENTS_MEMORY_NAME,
  "CLAUDE.local.md",
  "CLAUDE.md",
] as const;
/** Agent-written project memory filename under the project-state root. */
export const PROJECT_STATE_MEMORY_NAME = "MEMORY.md";
export const USER_MEMORY_PATH = join(homedir(), ".codepilot", "MEMORY.md");

/** Where `memory_write(scope=project)` persists — not the workspace. */
export function projectMemoryPath(cwd: string): string {
  return projectStatePath(cwd, PROJECT_STATE_MEMORY_NAME);
}

/** Canonical sections for CODEPILOT.md / MEMORY.md. */
export const MEMORY_SECTIONS = [
  "Project context",
  "Rules",
  "Architecture decisions",
  "Discovered durable knowledge",
] as const;

export type MemorySection = (typeof MEMORY_SECTIONS)[number];

export interface MemoryContents {
  project?: string;
  user?: string;
  /** Progressive index (~/.codepilot/memory/<hash>/MEMORY.md) — bullets + topic paths. */
  progressive?: string;
}

/** A single section's contents, parsed from a memory file. */
export interface ParsedMemory {
 /** Map of section name → body. Always contains all MEMORY_SECTIONS keys. */
  sections: Record<MemorySection, string>;
 /** Sections outside the canonical four (legacy / ad-hoc). */
  extras: Array<{ title: string; body: string }>;
 /** True if the original file lacked any `## <title>` headers. */
  unstructured: boolean;
 /** Raw text for callers that want to fall back to the full file. */
  raw: string;
}

/** Read project + user memory files. Missing files yield undefined.
 * Project scope is the per-project state file (not `<cwd>/CODEPILOT.md`). */
export async function readMemory(cwd: string): Promise<MemoryContents> {
  const out: MemoryContents = {};
  try {
    out.project = await readFile(projectMemoryPath(cwd), "utf-8");
  } catch {
 /* missing */
  }
  try {
    out.user = await readFile(USER_MEMORY_PATH, "utf-8");
  } catch {
 /* missing */
  }
  return out;
}

/**
 * Hierarchical project memory: walk from `cwd` upward collecting instruction
 * files (nearest first, annotated with source), stopping at the git toplevel
 * (or home with `walkToHome`). `@path` tokens expand inline, up to 4 hops.
 */
export async function readLayeredProjectMemory(
  cwd: string,
  opts?: { walkToHome?: boolean },
): Promise<string | undefined> {
  const layers: string[] = [];
  const home = homedir();
  let start = resolve(cwd);
  try {
    // Match git's `--show-toplevel`, which reports the canonical (real) path;
    // without this the ceiling comparison fails under symlinked temp roots.
    start = realpathSync(start);
  } catch {
    /* cwd may not exist yet — fall back to the resolved path */
  }
  const ceiling = opts?.walkToHome ? home : (await resolveRepoRoot(start)) ?? start;
  // Content already injected (trimmed) — dedup across names and levels.
  const seen = new Set<string>();
  let dir = start;
  for (let depth = 0; depth < 32; depth++) {
    for (const name of MEMORY_CANDIDATE_NAMES) {
      try {
        const content = await readFile(join(dir, name), "utf-8");
        const trimmed = content.trim();
        if (trimmed.length === 0 || seen.has(trimmed)) continue;
        seen.add(trimmed);
        // Expand @import tokens (relative to this file's directory).
        const expanded = await expandImports(content, dir, 0);
        layers.push(`<!-- from ${join(dir, name)} -->\n${expanded.trim()}`);
      } catch {
        /* missing at this level */
      }
    }
    // Stop once we have processed the ceiling directory (git toplevel, or
    // home when walkToHome). Below the ceiling we always continue upward.
    if (dir === ceiling || dir === home) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  if (layers.length === 0) return undefined;
  return layers.join("\n\n---\n\n");
}

/** Max recursion depth for @import expansion. */
const MAX_IMPORT_DEPTH = 4;
/** Regex matching `@path/to/file` tokens at the start of a line or after whitespace. */
const IMPORT_RE = /(?:^|\s)@([^\s@][^\s]*?)(?=\s|$)/gm;

/**
 * Expand `@path` imports in a memory file's text, relative to `baseDir`.
 * Recursion capped at MAX_IMPORT_DEPTH; a visited set guards cycles. Missing
 * files are left as-is so the model sees the literal `@path`.
 */
async function expandImports(text: string, baseDir: string, depth: number): Promise<string> {
  if (depth >= MAX_IMPORT_DEPTH) return text;
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(IMPORT_RE)) {
    const matchStart = m.index ?? 0;
 // Keep the text before the @token (including its leading whitespace).
    out.push(text.slice(last, matchStart));
    const rawPath = m[1]!;
 // Resolve ~ to home, otherwise relative to baseDir.
    const resolved = rawPath.startsWith("~")
      ? join(homedir(), rawPath.slice(1))
      : resolve(baseDir, rawPath);
    try {
      const imported = await readFile(resolved, "utf-8");
 // Recurse, relative to the imported file's directory.
      const sub = await expandImports(imported, dirname(resolved), depth + 1);
      out.push(`<!-- @import ${rawPath} from ${resolved} -->\n${sub.trim()}`);
    } catch {
 // Missing import — leave the literal token so the model can see it.
      out.push(`@${rawPath}`);
    }
    last = (m.index ?? 0) + m[0]!.length;
  }
  out.push(text.slice(last));
  return out.join("");
}

/** Parse a memory file's markdown into sections. Tolerant of legacy content. */
export function parseMemory(raw: string | undefined): ParsedMemory {
  const empty: ParsedMemory = {
    sections: {
      "Project context": "",
      "Rules": "",
      "Architecture decisions": "",
      "Discovered durable knowledge": "",
    },
    extras: [],
    unstructured: false,
    raw: raw ?? "",
  };
  if (!raw || !raw.trim()) return empty;
  const lines = raw.split(/\r?\n/);
  const headerRe = /^##\s+(.+?)\s*$/;
  const headerIndex: Array<{ title: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(headerRe);
    if (m) headerIndex.push({ title: m[1]!, line: i });
  }
  if (headerIndex.length === 0) {
 // Treat the whole file as "Project context".
    return {
      sections: { ...empty.sections, "Project context": raw.trim() },
      extras: [],
      unstructured: true,
      raw,
    };
  }
  const sections: Record<MemorySection, string> = { ...empty.sections };
  const extras: Array<{ title: string; body: string }> = [];
  for (let i = 0; i < headerIndex.length; i++) {
    const start = headerIndex[i]!.line + 1;
    const end = i + 1 < headerIndex.length ? headerIndex[i + 1]!.line : lines.length;
    const body = lines.slice(start, end).join("\n").trim();
    const title = headerIndex[i]!.title.trim();
    const matched = MEMORY_SECTIONS.find((s) => s.toLowerCase() === title.toLowerCase());
    if (matched) {
      sections[matched] = body;
    } else {
      extras.push({ title, body });
    }
  }
 // Capture any preamble above the first `##` heading.
  const preamble = lines.slice(0, headerIndex[0]!.line).join("\n").trim();
  if (preamble) {
    extras.unshift({ title: "_preamble", body: preamble });
  }
  return { sections, extras, unstructured: false, raw };
}

/** Heading titles that mark a user-authored "compact instructions" block in a
 * project memory file (CODEPILOT.md / AGENTS.md / CLAUDE.md). Matched
 * case-insensitively; every matching section's body is collected. */
const COMPACT_INSTRUCTION_TITLES = [
  "compact instructions",
  "compaction instructions",
  "summary instructions",
  "压缩指令",
  "压缩说明",
];

/**
 * Extract the user's "compact instructions" from layered project memory.
 * Returns the concatenated bodies (deduped) of every `## Compact Instructions`-style
 * section, or undefined when none is present.
 */
export async function readCompactInstructions(
  cwd: string,
  opts?: { walkToHome?: boolean },
): Promise<string | undefined> {
  const raw = await readLayeredProjectMemory(cwd, opts);
  return extractCompactInstructions(raw);
}

/** Pull `## Compact Instructions` bodies out of already-loaded memory markdown.
 * Split out from {@link readCompactInstructions} so it can be unit-tested and
 * reused on cached memory without re-reading the filesystem. */
export function extractCompactInstructions(raw: string | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const found: string[] = [];
  const seen = new Set<string>();
  // A layered file concatenates several documents with `---` separators; parse
  // the whole thing — `parseMemory` collects non-canonical `##` sections into
  // `extras`, which is exactly where a Compact Instructions block lands.
  const { extras } = parseMemory(raw);
  for (const { title, body } of extras) {
    if (!COMPACT_INSTRUCTION_TITLES.includes(title.trim().toLowerCase())) continue;
    // A layered document concatenates files with `---` separators and annotates
    // each with a `<!-- from <path> -->` comment. When a `## Compact
    // Instructions` section is the last one in its file, its body runs up to the
    // next file's `##` header, swallowing the separator + comment — strip those
    // trailing lines so only the instruction text remains.
    const trimmed = body
      .replace(/\n*(?:^|\n)\s*---\s*(?:\n|$)[\s\S]*$/m, "")
      .replace(/\n*<!--[\s\S]*?-->\s*$/g, "")
      .trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    found.push(trimmed);
  }
  return found.length > 0 ? found.join("\n\n") : undefined;
}

/** Best-effort mapping from a free-text title to a canonical section. */
export function classifySection(title: string, content: string): MemorySection {
  const t = `${title}\n${content}`.toLowerCase();
  if (/\b(rule|always|never|must|约束|规则|禁止)\b/.test(t)) return "Rules";
  if (/\b(architecture|design|decision|chose|chose|架构|设计|选择)\b/.test(t)) return "Architecture decisions";
  if (/\b(discovered|invariant|fact|known|knowledge|发现|事实)\b/.test(t)) return "Discovered durable knowledge";
  return "Project context";
}

/** File-backed sink. Honours the `section` argument.
 * Project entries go to `~/.codepilot/projects/<hash>/MEMORY.md`.
 * Also mirrors into progressive index + topic files under
 * `~/.codepilot/memory/<hash>/` (unless auto-memory is disabled). */
export class FileMemorySink implements MemorySink {
  constructor(
    private readonly cwd: string,
    private readonly opts?: {
      autoMemory?: AutoMemoryConfig | false;
      /** Deployment redaction patterns applied on top of the built-in floor. */
      redactPatterns?: readonly RedactionPattern[];
    },
  ) {}

  async write(
    scope: "project" | "user",
    title: string,
    content: string,
    section?: string,
    writeOpts?: MemoryWriteOpts,
  ): Promise<string> {
    const path =
      scope === "project" ? projectMemoryPath(this.cwd) : USER_MEMORY_PATH;
    const target = canonicaliseSection(section) ?? classifySection(title, content);
    const stamp = new Date().toISOString().slice(0, 10);
    // Redact secrets before anything reaches disk — a credential the agent put
    // in a note would otherwise be replayed into every future session's prompt.
    const extra = this.opts?.redactPatterns;
    title = redactSecrets(title, extra);
    const body = redactSecrets(content.trim(), extra);
    // Serialize the read-parse-mutate-write on MEMORY.md so two concurrent
    // memory_write calls in one turn can't clobber each other's section edit
    // (same reasoning as withMemoryWriteLock in autoMemory).
    await withMemoryWriteLock(path, async () => {
      let existing = "";
      try {
        existing = await readFile(path, "utf-8");
      } catch {
        /* fresh */
      }
      const parsed = parseMemory(existing);
      // Keep MEMORY.md lean: long bodies live in progressive topic files;
      // the section only keeps a short blurb + pointer when spilling.
      const { blurb, spilled } = spillBlurb(body);
      const block = spilled
        ? `\n### ${title} (${stamp})\n\n${blurb}\n\n_Full note in progressive memory (see topic files under \`~/.codepilot/memory/\`)._\n`
        : `\n### ${title} (${stamp})\n\n${body}\n`;
      parsed.sections[target] = (parsed.sections[target] || "").trimEnd() + "\n" + block;
      const newText = renderMemory(parsed);
      await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined);
      await writeFile(path, newText, "utf-8");
    });

    const am = this.opts?.autoMemory;
    if (am !== false && (am?.enabled !== false)) {
      const resolved = resolveMemoryTopic({
        scope,
        section: section ?? target,
        title,
        content: body,
        topic: writeOpts?.topic,
        category: writeOpts?.category,
      });
      await writeAutoMemoryNote(
        this.cwd,
        {
          category: resolved.category,
          topic: resolved.topic,
          summary: title,
          body,
          source: path,
        },
        am,
      ).catch(() => undefined);
    }
    return path;
  }
}

/** Spill long MEMORY.md entries so the always-injected summary stays small. */
const MEMORY_BLURB_CHARS = 400;

function spillBlurb(body: string): { blurb: string; spilled: boolean } {
  if (body.length <= MEMORY_BLURB_CHARS) return { blurb: body, spilled: false };
  const cut = body.slice(0, MEMORY_BLURB_CHARS);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  const blurb = (at > 80 ? cut.slice(0, at + 1) : cut).trimEnd() + "…";
  return { blurb, spilled: true };
}

function canonicaliseSection(s: string | undefined): MemorySection | null {
  if (!s) return null;
  const target = MEMORY_SECTIONS.find((m) => m.toLowerCase() === s.toLowerCase());
  return target ?? null;
}

/** Render a parsed memory back to markdown. Stable, deterministic. */
export function renderMemory(parsed: ParsedMemory): string {
  const out: string[] = [];
  if (parsed.extras.length > 0) {
    for (const ex of parsed.extras) {
      if (ex.title === "_preamble") {
        out.push(ex.body);
        out.push("");
        continue;
      }
      out.push(`## ${ex.title}`, "", ex.body, "");
    }
  }
  for (const sec of MEMORY_SECTIONS) {
    const body = parsed.sections[sec];
    if (body && body.trim()) {
      out.push(`## ${sec}`, "", body.trim(), "");
    } else {
      out.push(`## ${sec}`, "", "_(none yet)_", "");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Summarise memory for system-prompt injection. Truncates intelligently. */
export function summariseMemory(
  contents: MemoryContents,
  maxChars = 4000
): MemoryContents {
  const out: MemoryContents = {};
  for (const [k, v] of Object.entries(contents) as [
    keyof MemoryContents,
    string | undefined
  ][]) {
    if (!v) continue;
    if (v.length <= maxChars) {
      out[k] = v;
      continue;
    }
    out[k] = summariseMemoryText(v, maxChars);
  }
  return out;
}

/**
 * Smart truncation: for files over a line threshold, keeps the head of each
 * section plus a leading excerpt, collapsing the tail with a marker. Falls back
 * to a flat prefix for unstructured files.
 */
export function summariseMemoryText(text: string, maxChars: number): string {
  const lines = text.split(/\r?\n/);
 // Threshold: if under 200 lines, use the simple prefix; otherwise section.
  if (lines.length <= 200) {
    return (
      text.slice(0, maxChars) +
      `\n\n[...truncated, ${text.length - maxChars} more chars]`
    );
  }
  const parsed = parseMemory(text);
 // For each canonical section, keep the first 20 non-empty lines.
  const summary: string[] = [];
  for (const sec of MEMORY_SECTIONS) {
    const body = parsed.sections[sec];
    if (!body || !body.trim()) continue;
    const sectionLines = body.split(/\r?\n/);
    const head: string[] = [];
    let count = 0;
    for (const l of sectionLines) {
      if (l.trim().length === 0 && count === 0) continue;
      head.push(l);
      if (l.trim().length > 0) count++;
      if (count >= 20) break;
    }
    summary.push(`## ${sec}\n${head.join("\n").trimEnd()}\n[...truncated, ${
      sectionLines.length - count
    } more lines]`);
  }
  if (summary.length === 0) {
    return (
      text.slice(0, maxChars) +
      `\n\n[...truncated, ${text.length - maxChars} more chars]`
    );
  }
  const joined = summary.join("\n\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars) + `\n\n[...truncated ${joined.length - maxChars} chars]`;
}

/** True if a memory file exists. */
export async function memoryFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
