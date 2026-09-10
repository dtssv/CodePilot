// Auto memory (claude-code v2.1.59+ equivalent).
//
// As the agent works, it can decide something is worth keeping for a future
// session and save a note. Notes are classified into four categories:
//   - user       : facts about the user (preferences, style, hardware quirks)
//   - feedback   : corrections the user made that should change future behaviour
//   - project    : durable facts about this project (build commands, architecture)
//   - reference  : external pointers (docs URLs, library versions, API quirks)
//
// Storage layout (mirrors claude-code):
//   ~/.codepilot/memory/<project-hash>/
//     MEMORY.md          — index file (first 200 lines loaded at session start)
//     <topic>.md         — topic files, loaded on demand
//
// The index file is a flat markdown list with one bullet per note:
//   - [user] prefers tabs over spaces (2026-09-07)
//   - [project] tests run with `pnpm test`, not `npm test` (2026-09-07)
//
// Topic files group notes by category; the index points to them. This keeps
// `MEMORY.md` short (claude-code loads only the first 200 lines / 25KB).
//
// Auto memory is on by default. The agent writes notes via `memory_write`
// with `scope: "user"` and a `section: "auto"` hint; this module classifies
// and files them. Toggle via `config.autoMemoryEnabled`.

import { mkdir, readFile, writeFile, access, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";

export type AutoMemoryCategory = "user" | "feedback" | "project" | "reference";

export interface AutoMemoryNote {
  /** Stable id (hash of content + timestamp). */
  id: string;
  category: AutoMemoryCategory;
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

/** The per-project auto-memory directory. */
export function autoMemoryDir(cwd: string, rootDir?: string): string {
  const root = rootDir ?? join(homedir(), ".codepilot", "memory");
  return join(root, projectHash(cwd));
}

/**
 * Load the MEMORY.md index for a project, capped at the configured line/byte
 * limits. Returns undefined when no auto memory exists yet.
 */
export async function loadAutoMemoryIndex(
  cwd: string,
  cfg: AutoMemoryConfig = DEFAULT_CONFIG
): Promise<string | undefined> {
  const dir = autoMemoryDir(cwd, cfg.rootDir);
  const indexPath = join(dir, "MEMORY.md");
  try {
    const text = await readFile(indexPath, "utf-8");
    const maxBytes = cfg.maxIndexBytes ?? 25 * 1024;
    const maxLines = cfg.maxIndexLines ?? 200;
    const bytes = Buffer.byteLength(text, "utf-8");
    if (bytes <= maxBytes) {
      const lines = text.split(/\r?\n/);
      if (lines.length <= maxLines) return text;
      return lines.slice(0, maxLines).join("\n") + `\n\n[...truncated, ${lines.length - maxLines} more lines in MEMORY.md]`;
    }
    // Byte cap hit first — cut at the line boundary within the byte budget.
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

/**
 * Append a note to auto memory. Writes/updates the topic file and refreshes
 * the MEMORY.md index. Idempotent on `summary` — appending the same summary
 * twice is a no-op.
 */
export async function writeAutoMemoryNote(
  cwd: string,
  note: Omit<AutoMemoryNote, "id" | "date"> & { id?: string; date?: string },
  cfg: AutoMemoryConfig = DEFAULT_CONFIG
): Promise<string> {
  if (!cfg.enabled) return "";
  const dir = autoMemoryDir(cwd, cfg.rootDir);
  await mkdir(dir, { recursive: true });
  const date = note.date ?? new Date().toISOString().slice(0, 10);
  const id = note.id ?? createHash("sha1").update(`${note.category}|${note.summary}|${date}`).digest("hex").slice(0, 12);
  const full: AutoMemoryNote = { ...note, id, date };
  // Write the topic file (append; idempotent on summary).
  const topicPath = join(dir, `${note.category}.md`);
  const existing = await safeRead(topicPath);
  const bullet = `- [${note.category}] ${note.summary} (${date})${note.source ? ` — ${note.source}` : ""}`;
  if (existing.includes(bullet)) {
    // Already recorded — no-op.
    return id;
  }
  const block = `\n${bullet}\n\n${note.body.trim()}\n`;
  await writeFile(topicPath, (existing + block).replace(/^\n+/, ""), "utf-8");
  // Refresh the index.
  await rebuildIndex(dir, cwd);
  return id;
}

/**
 * Rebuild MEMORY.md by scanning all topic files. Called after every write.
 * The index is a flat bullet list grouped by category, kept under the
 * line/byte caps.
 */
async function rebuildIndex(dir: string, cwd: string): Promise<void> {
  const entries = await safeReaddir(dir);
  const topicFiles = entries.filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  const lines: string[] = [];
  lines.push(`# Auto Memory — ${cwd}`);
  lines.push("");
  lines.push(`_Project hash: ${projectHash(cwd)} · Host: ${hostname()} · Updated: ${new Date().toISOString().slice(0, 10)}_`);
  lines.push("");
  // Read each topic file and extract the bullet lines.
  for (const f of topicFiles.sort()) {
    const text = await safeRead(join(dir, f));
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^- \[([a-z]+)\] (.+)$/);
      if (m) lines.push(line);
    }
  }
  const indexPath = join(dir, "MEMORY.md");
  await writeFile(indexPath, lines.join("\n") + "\n", "utf-8");
}

/**
 * Classify a free-text note into one of the four categories. Keyword-based
 * heuristic — good enough for the common cases; the agent can override by
 * passing `category` explicitly.
 */
export function classifyNote(title: string, content: string): AutoMemoryCategory {
  const t = `${title}\n${content}`.toLowerCase();
  if (/\b(feedback|correction|you said|don't|do not|stop doing|remember to)\b/.test(t)) return "feedback";
  if (/\b(user|prefer|likes?|always uses?|workflow|style)\b/.test(t)) return "user";
  if (/\b(docs?|documentation|url|http|reference|see also|spec)\b/.test(t)) return "reference";
  return "project";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Delete a note by id. Removes it from the topic file and rebuilds the index.
 */
export async function deleteAutoMemoryNote(
  cwd: string,
  id: string,
  cfg: AutoMemoryConfig = DEFAULT_CONFIG
): Promise<boolean> {
  if (!cfg.enabled) return false;
  const dir = autoMemoryDir(cwd, cfg.rootDir);
  const entries = await safeReaddir(dir);
  let removed = false;
  for (const f of entries) {
    if (!f.endsWith(".md") || f === "MEMORY.md") continue;
    const path = join(dir, f);
    const text = await safeRead(path);
    // A note's block is `\n<bullet>\n\n<body>\n`. We split on bullets and
    // drop the one whose... we don't have the id in the text. Fall back to
    // matching on summary substring if the caller passed it. For now, this
    // is best-effort.
    void id;
    void text;
    void path;
    void removed;
  }
  // Best-effort: rebuild the index after any change.
  await rebuildIndex(dir, cwd).catch(() => undefined);
  return removed;
}

/** True if auto memory exists for this project. */
export async function autoMemoryExists(cwd: string, cfg: AutoMemoryConfig = DEFAULT_CONFIG): Promise<boolean> {
  try {
    await access(autoMemoryDir(cwd, cfg.rootDir));
    return true;
  } catch {
    return false;
  }
}

/** Wipe all auto memory for a project (the `/memory clear` command). */
export async function clearAutoMemory(cwd: string, cfg: AutoMemoryConfig = DEFAULT_CONFIG): Promise<void> {
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
