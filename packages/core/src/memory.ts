// Memory: read & write CODEPILOT.md (project) and ~/.codepilot/MEMORY.md (user).
//
// CODEPILOT.md / MEMORY.md are structured documents with four sections:
//
//   ## Project context          - what is this project, its goal
//   ## Rules                    - user-stated hard constraints
//   ## Architecture decisions   - major design choices with rationale
//   ## Discovered durable knowledge - facts that survive across sessions
//
// Older files written before this layout existed are still readable: the
// parser tolerates arbitrary `## <title>` sections and falls back to a
// single "Body" section for unstructured content. `memory_write` accepts
// a `section` argument to target one of the canonical sections; without
// one, the entry is appended as a titled block under a best-guess section.

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemorySink } from "./tools/memory_write.js";

export const PROJECT_MEMORY_NAME = "CODEPILOT.md";
export const USER_MEMORY_PATH = join(homedir(), ".codepilot", "MEMORY.md");

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

/** Read project + user memory files. Missing files yield undefined. */
export async function readMemory(cwd: string): Promise<MemoryContents> {
  const out: MemoryContents = {};
  try {
    out.project = await readFile(join(cwd, PROJECT_MEMORY_NAME), "utf-8");
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

/** Best-effort mapping from a free-text title to a canonical section. */
export function classifySection(title: string, content: string): MemorySection {
  const t = `${title}\n${content}`.toLowerCase();
  if (/\b(rule|always|never|must|约束|规则|禁止)\b/.test(t)) return "Rules";
  if (/\b(architecture|design|decision|chose|chose|架构|设计|选择)\b/.test(t)) return "Architecture decisions";
  if (/\b(discovered|invariant|fact|known|knowledge|发现|事实)\b/.test(t)) return "Discovered durable knowledge";
  return "Project context";
}

/** File-backed sink. Honours the `section` argument. */
export class FileMemorySink implements MemorySink {
  constructor(private readonly cwd: string) {}

  async write(
    scope: "project" | "user",
    title: string,
    content: string,
    section?: string
  ): Promise<string> {
    const path =
      scope === "project"
        ? join(this.cwd, PROJECT_MEMORY_NAME)
        : USER_MEMORY_PATH;
    let existing = "";
    try {
      existing = await readFile(path, "utf-8");
    } catch {
      /* fresh */
    }
    const parsed = parseMemory(existing);
    const target = canonicaliseSection(section) ??
      classifySection(title, content);
    const stamp = new Date().toISOString().slice(0, 10);
    const block = `\n### ${title} (${stamp})\n\n${content.trim()}\n`;
    parsed.sections[target] = (parsed.sections[target] || "").trimEnd() + "\n" + block;
    const newText = renderMemory(parsed);
    await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined);
    await writeFile(path, newText, "utf-8");
    return path;
  }
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
 * Smart truncation that, for files over a line threshold, keeps the
 * head (header lines) of each section plus a leading excerpt, then
 * collapses the tail with a marker. Falls back to a flat prefix for
 * unstructured files.
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
