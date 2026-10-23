// Progressive project memory: thin INDEX + topic files (harness-style).
//
// Layout (per project):
//   ~/.codepilot/memory/<project-hash>/
//     MEMORY.md          — index only (injected at session start, capped)
//     overview.md        — what the project is
//     architecture.md    — design / module map
//     standards.md       — rules & conventions
//     knowledge.md       — discovered durable facts
//     user.md / feedback.md / reference.md — cross-cutting notes
//     <custom>.md        — optional agent-chosen topics
//
// Prompt gets the index + short MEMORY.md summaries; full topic bodies are
// loaded on demand via `read_file` (paths are listed in the index).
//
// Writes go through `memory_write` → {@link writeAutoMemoryNote} (wired from
// FileMemorySink). Toggle via `config.autoMemoryEnabled`.

import { mkdir, readFile, writeFile, access, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";

export type AutoMemoryCategory = "user" | "feedback" | "project" | "reference";

/** Progressive-disclosure topic files (filename without .md). */
export const MEMORY_TOPICS = [
  "overview",
  "architecture",
  "standards",
  "knowledge",
  "user",
  "feedback",
  "reference",
] as const;

export type MemoryTopic = (typeof MEMORY_TOPICS)[number] | (string & {});

export interface AutoMemoryNote {
  /** Stable id (hash of content + timestamp). */
  id: string;
  category: AutoMemoryCategory;
  /** Topic file slug (defaults from category / MEMORY.md section). */
  topic: string;
  /** One-line summary (the bullet in the index). */
  summary: string;
  /** Full note body (in the topic file). */
  body: string;
  /** ISO date the note was recorded. */
  date: string;
  /** Optional file:line the note relates to. */
  source?: string;
}

export interface AutoMemoryConfig {
  /** Master toggle. Default true. */
  enabled: boolean;
  /** Override the memory root (defaults to ~/.codepilot/memory). */
  rootDir?: string;
  /** Max lines of MEMORY.md to load at session start (default 200). */
  maxIndexLines?: number;
  /** Max bytes of MEMORY.md to load at session start (default 25KB). */
  maxIndexBytes?: number;
}

const DEFAULT_CONFIG: AutoMemoryConfig = {
  enabled: true,
  maxIndexLines: 200,
  maxIndexBytes: 25 * 1024,
};

/**
 * Compute a stable hash for a project (by absolute cwd path). This keeps
 * each project's auto memory in its own subdirectory, so notes from one
 * repo don't leak into another.
 */
export function projectHash(cwd: string): string {
  return createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 16);
}

/** The per-project progressive-memory directory. */
export function autoMemoryDir(cwd: string, rootDir?: string): string {
  const root = rootDir ?? join(homedir(), ".codepilot", "memory");
  return join(root, projectHash(cwd));
}

/** Sanitize a free-form topic slug for a filename. */
export function sanitizeTopic(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || "knowledge";
}

/**
 * Map MEMORY.md section / scope / free text → topic file + category tag.
 */
export function resolveMemoryTopic(opts: {
  scope: "project" | "user";
  section?: string;
  title: string;
  content: string;
  topic?: string;
  category?: AutoMemoryCategory;
}): { topic: string; category: AutoMemoryCategory } {
  if (opts.topic?.trim()) {
    const topic = sanitizeTopic(opts.topic);
    const category =
      opts.category ??
      (opts.scope === "user" ? "user" : categoryForTopic(topic, opts.title, opts.content));
    return { topic, category };
  }
  if (opts.scope === "user") {
    const category = opts.category ?? classifyNote(opts.title, opts.content);
    const topic =
      category === "feedback" ? "feedback" : category === "reference" ? "reference" : "user";
    return { topic, category: opts.category ?? category };
  }
  const sec = (opts.section ?? "").toLowerCase();
  if (sec.includes("architecture") || sec.includes("decision")) {
    return { topic: "architecture", category: opts.category ?? "project" };
  }
  if (sec.includes("rule")) {
    return { topic: "standards", category: opts.category ?? "project" };
  }
  if (sec.includes("discovered") || sec.includes("knowledge")) {
    return { topic: "knowledge", category: opts.category ?? "project" };
  }
  if (sec.includes("project context") || sec.includes("context")) {
    return { topic: "overview", category: opts.category ?? "project" };
  }
  const category = opts.category ?? classifyNote(opts.title, opts.content);
  return {
    topic: topicForCategory(category, opts.title, opts.content),
    category,
  };
}

function topicForCategory(
  category: AutoMemoryCategory,
  title: string,
  content: string,
): string {
  if (category === "user") return "user";
  if (category === "feedback") return "feedback";
  if (category === "reference") return "reference";
  const t = `${title}\n${content}`.toLowerCase();
  if (/\b(architecture|design|module|layer|decision)\b/.test(t)) return "architecture";
  if (/\b(rule|convention|must|never|always|lint|style)\b/.test(t)) return "standards";
  if (/\b(overview|purpose|what this|project is)\b/.test(t)) return "overview";
  return "knowledge";
}

function categoryForTopic(
  topic: string,
  title: string,
  content: string,
): AutoMemoryCategory {
  if (topic === "user") return "user";
  if (topic === "feedback") return "feedback";
  if (topic === "reference") return "reference";
  return classifyNote(title, content) === "reference" ? "reference" : "project";
}

/**
 * Load the MEMORY.md index for a project, capped at the configured line/byte
 * limits. Returns undefined when no auto memory exists yet.
 * Includes absolute paths to topic files so the agent can `read_file` them.
 */
export async function loadAutoMemoryIndex(
  cwd: string,
  cfg: AutoMemoryConfig = DEFAULT_CONFIG,
): Promise<string | undefined> {
  if (cfg.enabled === false) return undefined;
  const dir = autoMemoryDir(cwd, cfg.rootDir);
  const indexPath = join(dir, "MEMORY.md");
  try {
    let text = await readFile(indexPath, "utf-8");
    // Ensure topic paths are present (older indexes may lack the footer).
    if (!text.includes("## Topic files")) {
      text = await appendTopicFooter(text, dir);
    }
    const maxBytes = cfg.maxIndexBytes ?? 25 * 1024;
    const maxLines = cfg.maxIndexLines ?? 200;
    const bytes = Buffer.byteLength(text, "utf-8");
    if (bytes <= maxBytes) {
      const lines = text.split(/\r?\n/);
      if (lines.length <= maxLines) return text;
      return (
        lines.slice(0, maxLines).join("\n") +
        `\n\n[...truncated, ${lines.length - maxLines} more lines in MEMORY.md]`
      );
    }
    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    let total = 0;
    for (const l of lines) {
      const sz = Buffer.byteLength(l + "\n", "utf-8");
      if (total + sz > maxBytes) break;
      out.push(l);
      total += sz;
    }
    return out.join("\n") + `\n\n[...truncated at ${maxBytes} bytes]`;
  } catch {
    return undefined;
  }
}

async function appendTopicFooter(indexText: string, dir: string): Promise<string> {
  const topics = await listTopicFiles(dir);
  if (topics.length === 0) return indexText;
  const footer = [
    "",
    "## Topic files (read_file for full notes)",
    "",
    `_Directory: \`${dir}\`_`,
    "",
    ...topics.map((f) => `- \`${join(dir, f)}\``),
    "",
  ].join("\n");
  return indexText.trimEnd() + "\n" + footer;
}

async function listTopicFiles(dir: string): Promise<string[]> {
  const entries = await safeReaddir(dir);
  return entries.filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort();
}

/**
 * Append a note to progressive memory. Writes/updates the topic file and
 * refreshes the MEMORY.md index. Idempotent on `summary` — same summary twice
 * is a no-op.
 */
export async function writeAutoMemoryNote(
  cwd: string,
  note: Omit<AutoMemoryNote, "id" | "date" | "topic"> & {
    id?: string;
    date?: string;
    topic?: string;
  },
  cfg: AutoMemoryConfig = DEFAULT_CONFIG,
): Promise<string> {
  if (!cfg.enabled) return "";
  const dir = autoMemoryDir(cwd, cfg.rootDir);
  await mkdir(dir, { recursive: true });
  const date = note.date ?? new Date().toISOString().slice(0, 10);
  const topic = sanitizeTopic(note.topic ?? topicForCategory(note.category, note.summary, note.body));
  const id =
    note.id ??
    createHash("sha1")
      .update(`${topic}|${note.category}|${note.summary}|${date}`)
      .digest("hex")
      .slice(0, 12);
  const full: AutoMemoryNote = { ...note, id, date, topic };
  const topicPath = join(dir, `${topic}.md`);
  const existing = await safeRead(topicPath);
  const bullet = `- [${full.category}] ${full.summary} (${date})${full.source ? ` — ${full.source}` : ""}`;
  if (existing.includes(bullet)) {
    return id;
  }
  const block = `\n${bullet}\n\n${full.body.trim()}\n`;
  await writeFile(topicPath, (existing + block).replace(/^\n+/, ""), "utf-8");
  await rebuildIndex(dir, cwd);
  return id;
}

/**
 * Rebuild MEMORY.md by scanning all topic files. Called after every write.
 */
async function rebuildIndex(dir: string, cwd: string): Promise<void> {
  const topicFiles = await listTopicFiles(dir);
  const lines: string[] = [];
  lines.push(`# Progressive memory — ${cwd}`);
  lines.push("");
  lines.push(
    `_Project hash: ${projectHash(cwd)} · Host: ${hostname()} · Updated: ${new Date().toISOString().slice(0, 10)}_`,
  );
  lines.push("");
  lines.push("Always-loaded index (bullets only). For full notes, `read_file` a topic path below.");
  lines.push("");
  for (const f of topicFiles) {
    const text = await safeRead(join(dir, f));
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^- \[([a-z]+)\] (.+)$/);
      if (m) lines.push(line);
    }
  }
  lines.push("");
  lines.push("## Topic files (read_file for full notes)");
  lines.push("");
  lines.push(`_Directory: \`${dir}\`_`);
  lines.push("");
  for (const f of topicFiles) {
    lines.push(`- \`${join(dir, f)}\``);
  }
  lines.push("");
  await writeFile(join(dir, "MEMORY.md"), lines.join("\n"), "utf-8");
}

/**
 * Classify a free-text note into one of the four categories. Keyword-based
 * heuristic — good enough for the common cases; the agent can override by
 * passing `category` explicitly.
 */
export function classifyNote(title: string, content: string): AutoMemoryCategory {
  const t = `${title}\n${content}`.toLowerCase();
  if (/\b(feedback|correction|you said|don't|do not|stop doing|remember to)\b/.test(t)) {
    return "feedback";
  }
  if (/\b(user|prefer|likes?|always uses?|workflow|style)\b/.test(t)) return "user";
  if (/\b(docs?|documentation|url|http|reference|see also|spec)\b/.test(t)) return "reference";
  return "project";
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Delete a note by id. Best-effort; rebuilds the index after any change.
 */
export async function deleteAutoMemoryNote(
  cwd: string,
  id: string,
  cfg: AutoMemoryConfig = DEFAULT_CONFIG,
): Promise<boolean> {
  if (!cfg.enabled) return false;
  const dir = autoMemoryDir(cwd, cfg.rootDir);
  void id;
  await rebuildIndex(dir, cwd).catch(() => undefined);
  return false;
}

/** True if auto memory exists for this project. */
export async function autoMemoryExists(
  cwd: string,
  cfg: AutoMemoryConfig = DEFAULT_CONFIG,
): Promise<boolean> {
  try {
    await access(autoMemoryDir(cwd, cfg.rootDir));
    return true;
  } catch {
    return false;
  }
}

/** Wipe all auto memory for a project (the `/memory clear` command). */
export async function clearAutoMemory(
  cwd: string,
  cfg: AutoMemoryConfig = DEFAULT_CONFIG,
): Promise<void> {
  const dir = autoMemoryDir(cwd, cfg.rootDir);
  const entries = await safeReaddir(dir);
  for (const f of entries) {
    try {
      await unlink(join(dir, f));
    } catch {
      /* ignore */
    }
  }
}
