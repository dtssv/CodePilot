// Plan file persistence (claude-code `~/.claude/plans/` equivalent).
//
// When the agent in `plan` mode calls `plan_done`, the plan is written to
// `.codepilot/plans/<slug>.md` so it survives as a reviewable artifact
// (and so a colleague can review it before the PR, not after). The plan
// file name is derived from the session id + a short slug.
//
// On approval, the session restores its previous permission mode
// (claude-code `prePlanMode`) and switches to `agent` mode to begin
// executing the plan.
//
// Plan file layout:
//   # Plan: <summary or "(untitled)">
//
//   _Session: <id> · Created: <date> · Status: approved|rejected|pending_
//
//   ## Steps
//   - [ ] <id> — <title>
//   ...
//
//   ## Notes
//   <free text from the plan_done summary>

import { mkdir, writeFile, readFile, readdir, unlink, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { PlanStep } from "./types.js";

export interface PlanFile {
  /** Absolute path on disk. */
  path: string;
  /** The slug used in the filename. */
  slug: string;
  /** The plan title (first `# ` line). */
  title: string;
  /** The plan steps parsed from the `## Steps` section. */
  steps: PlanStep[];
  /** Free-text notes (the `## Notes` section). */
  notes: string;
  /** ISO timestamp from the file's creation line. */
  createdAt?: string;
  /** Approval status. */
  status: "pending" | "approved" | "rejected";
}

/**
 * The directory where plans are written. Defaults to `<cwd>/.codepilot/plans`
 * (project-local, committable) so a colleague can review the plan before
 * the PR. The user can override via `config.plansDirectory`.
 */
export function plansDir(cwd: string, override?: string): string {
  if (override) return resolve(cwd, override);
  return join(cwd, ".codepilot", "plans");
}

/**
 * Derive a filesystem-safe slug from a session id + summary. The slug is
 * lowercased, hyphen-separated, and capped at 60 chars.
 */
export function planSlug(sessionId: string, summary?: string): string {
  const base = (summary ?? "plan")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "plan";
  // Add a short hash of the session id so multiple plans from the same
  // session don't collide.
  const hash = sessionId.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase();
  return `${base}-${hash}`;
}

/**
 * Write a plan to disk. Returns the absolute path. Overwrites an existing
 * plan file with the same slug (re-submission after revision).
 */
export async function writePlanFile(
  cwd: string,
  sessionId: string,
  summary: string | undefined,
  steps: PlanStep[],
  opts: { plansDirectory?: string; status?: PlanFile["status"] } = {}
): Promise<PlanFile> {
  const dir = plansDir(cwd, opts.plansDirectory);
  await mkdir(dir, { recursive: true });
  const slug = planSlug(sessionId, summary);
  const path = join(dir, `${slug}.md`);
  const createdAt = new Date().toISOString();
  const status = opts.status ?? "pending";
  const title = summary?.trim() || "(untitled plan)";
  const lines: string[] = [];
  lines.push(`# Plan: ${title}`);
  lines.push("");
  lines.push(`_Session: ${sessionId} · Created: ${createdAt} · Status: ${status}_`);
  lines.push("");
  lines.push("## Steps");
  if (steps.length === 0) {
    lines.push("_(no steps recorded — call `plan_update` before `plan_done`)_");
  } else {
    for (const s of steps) {
      const mark = s.status === "completed" ? "[x]"
        : s.status === "in_progress" ? "[~]"
        : s.status === "blocked" ? "[!]"
        : "[ ]";
      lines.push(`- ${mark} \`${s.id}\` — ${s.title} (${s.status})`);
    }
  }
  lines.push("");
  lines.push("## Notes");
  lines.push(summary?.trim() || "_(no notes)_");
  lines.push("");
  await writeFile(path, lines.join("\n"), "utf-8");
  return {
    path,
    slug,
    title,
    steps,
    notes: summary ?? "",
    createdAt,
    status,
  };
}

/**
 * Read a plan file by slug. Returns undefined when the file doesn't exist.
 */
export async function readPlanFile(
  cwd: string,
  slug: string,
  opts: { plansDirectory?: string } = {}
): Promise<PlanFile | undefined> {
  const dir = plansDir(cwd, opts.plansDirectory);
  const path = join(dir, `${slug}.md`);
  try {
    const text = await readFile(path, "utf-8");
    return parsePlanFile(text, path, slug);
  } catch {
    return undefined;
  }
}

/**
 * List all plan files for a project, newest first.
 */
export async function listPlanFiles(
  cwd: string,
  opts: { plansDirectory?: string } = {}
): Promise<PlanFile[]> {
  const dir = plansDir(cwd, opts.plansDirectory);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: PlanFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const slug = name.slice(0, -3);
    const path = join(dir, name);
    try {
      const text = await readFile(path, "utf-8");
      const pf = parsePlanFile(text, path, slug);
      if (pf) out.push(pf);
    } catch {
      /* skip */
    }
  }
  // Sort by mtime, newest first.
  const withMtime = await Promise.all(out.map(async (pf) => {
    try {
      const st = await stat(pf.path);
      return { pf, mtime: st.mtimeMs };
    } catch {
      return { pf, mtime: 0 };
    }
  }));
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.map((x) => x.pf);
}

/**
 * Update a plan file's status (e.g. mark approved after the user accepts).
 * Rewrites the file in place.
 */
export async function setPlanFileStatus(
  cwd: string,
  slug: string,
  status: PlanFile["status"],
  opts: { plansDirectory?: string } = {}
): Promise<void> {
  const dir = plansDir(cwd, opts.plansDirectory);
  const path = join(dir, `${slug}.md`);
  try {
    const text = await readFile(path, "utf-8");
    const updated = text.replace(
      /_Session: [^·]+ · Created: [^·]+ · Status: (pending|approved|rejected)_/,
      `_Session: $1 · Created: $2 · Status: ${status}`
    );
    // The regex above is fragile on the capture groups; fall back to a
    // simpler line-based rewrite if it didn't match.
    if (updated === text) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.startsWith("_Session:")) {
          lines[i] = lines[i]!.replace(/· Status: \w+/, `· Status: ${status}`);
          break;
        }
      }
      await writeFile(path, lines.join("\n"), "utf-8");
      return;
    }
    await writeFile(path, updated, "utf-8");
  } catch {
    /* ignore — best-effort */
  }
}

/** Delete a plan file. */
export async function deletePlanFile(
  cwd: string,
  slug: string,
  opts: { plansDirectory?: string } = {}
): Promise<void> {
  const dir = plansDir(cwd, opts.plansDirectory);
  try {
    await unlink(join(dir, `${slug}.md`));
  } catch {
    /* ignore */
  }
}

/**
 * Parse a plan file's markdown back into a PlanFile. Best-effort — used
 * by `listPlanFiles` and the `/plans` command.
 */
function parsePlanFile(text: string, path: string, slug: string): PlanFile | undefined {
  const titleMatch = text.match(/^#\s+Plan:\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1]!.trim() : "(untitled plan)";
  const statusMatch = text.match(/· Status: (pending|approved|rejected)/);
  const status = (statusMatch?.[1] as PlanFile["status"]) ?? "pending";
  const createdMatch = text.match(/· Created: ([^·]+?) ·/);
  const createdAt = createdMatch?.[1]?.trim();
  // Parse steps from the `## Steps` section.
  const steps: PlanStep[] = [];
  const stepsSection = text.split(/^## Steps$/m)[1]?.split(/^## /m)[0] ?? "";
  for (const line of stepsSection.split(/\r?\n/)) {
    const m = line.match(/^\s*- \[([ x~!])\] `([^`]+)` — (.+?) \((\w+)\)\s*$/);
    if (m) {
      const mark = m[1]!;
      const status = mark === "x" ? "completed"
        : mark === "~" ? "in_progress"
        : mark === "!" ? "blocked"
        : "pending";
      // Prefer the explicit status in parens over the checkbox mark.
      const declared = m[4] as PlanStep["status"];
      steps.push({ id: m[2]!, title: m[3]!, status: declared ?? status });
    }
  }
  // Parse notes from the `## Notes` section.
  const notesSection = text.split(/^## Notes$/m)[1]?.split(/^## /m)[0] ?? "";
  const notes = notesSection.trim();
  return { path, slug, title, steps, notes, createdAt, status };
}

// Re-export the user-home fallback for callers that want plans outside the repo.
export function userPlansDir(): string {
  return join(homedir(), ".codepilot", "plans");
}
