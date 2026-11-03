// Spec-driven-development artifact discovery.
//
// A "spec" is one feature folder under the project's spec directory
// (default `<cwd>/.codepilot/specs/<feature>/`) holding up to three Markdown
// files written by the spec-* skills:
//
//   requirements.md  — numbered acceptance criteria (AC-x.y), the contract
//   design.md        — how it will be built, traced to the ACs
//   tasks.md         — ordered tasks, each with `verify:<cmd> → AC-x.y`
//
// Unlike plans (runtime state under `~/.codepilot/projects/<hash>/plans`),
// specs default INSIDE the repo so they are reviewed and versioned with the
// code. This module is read-only discovery: the skills themselves create and
// edit the files with `write_file`/`edit_file`, keeping one writer and no
// bespoke persistence to drift. The source of truth is the Markdown on disk.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";

/** One acceptance criterion parsed from a requirements file. */
export interface SpecAcceptanceCriterion {
  /** The `AC-<req>.<n>` id. */
  id: string;
  /** The criterion text (after the id). */
  text: string;
}

/** A single task parsed from tasks.md, with its verify binding. */
export interface SpecTask {
  /** Task id (e.g. `T1`), or the raw title when none is present. */
  id: string;
  title: string;
  done: boolean;
  /** The verify command (text after `verify:` and before `→`), if any. */
  verifyCommand?: string;
  /** Acceptance-criteria ids this task closes (after the `→`). */
  closesAcceptanceCriteria: string[];
}

/** A discovered feature spec. */
export interface SpecFeature {
  /** Feature folder name (slug). */
  slug: string;
  /** Absolute path to the feature folder. */
  dir: string;
  /** Which artifacts exist. */
  hasRequirements: boolean;
  hasDesign: boolean;
  hasTasks: boolean;
  /** Acceptance criteria parsed from requirements.md (best-effort). */
  acceptanceCriteria: SpecAcceptanceCriterion[];
  /** Tasks parsed from tasks.md (best-effort). */
  tasks: SpecTask[];
  /** Newest mtime across the feature's files (for sorting). */
  updatedAt: number;
}

/**
 * The directory holding feature specs. Defaults to `<cwd>/.codepilot/specs`.
 * Override via `config.specDirectory` (absolute, or relative to cwd).
 */
export function specsDir(cwd: string, override?: string): string {
  if (override) {
    return isAbsolute(override) ? override : resolve(cwd, override);
  }
  return join(cwd, ".codepilot", "specs");
}

/**
 * Parse `AC-x.y: text` lines out of a requirements markdown body. Matches the
 * shape the `spec-requirements` skill writes; tolerant of leading list markers.
 */
export function parseAcceptanceCriteria(text: string): SpecAcceptanceCriterion[] {
  const out: SpecAcceptanceCriterion[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\b(AC-\d+\.\d+)\s*[:：]\s*(.+?)\s*$/);
    if (m) out.push({ id: m[1]!, text: m[2]! });
  }
  return out;
}

/**
 * Parse tasks out of a tasks.md body. Each task is a top-level checkbox item;
 * its `verify:` line (which may be a nested bullet) binds a command to the
 * `AC-x.y` ids it closes.
 */
export function parseTasks(text: string): SpecTask[] {
  const lines = text.split(/\r?\n/);
  const tasks: SpecTask[] = [];
  let current: SpecTask | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const task = line.match(/^\s*- \[([ xX~!])\]\s+(.+?)\s*$/);
    if (task) {
      const mark = task[1]!.toLowerCase();
      const label = task[2]!;
      const idMatch = label.match(/^((?:T|t)\d+)\b\s*[—-]?\s*(.*)$/);
      current = {
        id: idMatch ? idMatch[1]! : label,
        title: idMatch ? (idMatch[2] || label) : label,
        done: mark === "x",
        closesAcceptanceCriteria: [],
      };
      tasks.push(current);
      continue;
    }
    // A verify line may hang under the current task (nested bullet or inline).
    const verify = line.match(/verify\s*[:：]\s*(.+)$/i);
    if (verify && current) {
      const rest = verify[1]!;
      const arrow = rest.split(/→|->/);
      const cmd = arrow[0]!.trim().replace(/^`|`$/g, "").trim();
      if (cmd) current.verifyCommand = cmd;
      if (arrow[1]) {
        for (const m of arrow[1].matchAll(/AC-\d+\.\d+/g)) {
          current.closesAcceptanceCriteria.push(m[0]);
        }
      }
    }
  }
  return tasks;
}

async function newestMtime(paths: string[]): Promise<number> {
  let newest = 0;
  for (const p of paths) {
    try {
      const st = await stat(p);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      /* missing — skip */
    }
  }
  return newest;
}

/** Read and parse one feature spec folder. Returns undefined when empty. */
export async function readSpecFeature(
  cwd: string,
  slug: string,
  opts: { specDirectory?: string } = {},
): Promise<SpecFeature | undefined> {
  const dir = join(specsDir(cwd, opts.specDirectory), slug);
  const reqPath = join(dir, "requirements.md");
  const designPath = join(dir, "design.md");
  const tasksPath = join(dir, "tasks.md");
  const reqText = await readFile(reqPath, "utf-8").catch(() => null);
  const designText = await readFile(designPath, "utf-8").catch(() => null);
  const tasksText = await readFile(tasksPath, "utf-8").catch(() => null);
  if (reqText == null && designText == null && tasksText == null) return undefined;
  return {
    slug,
    dir,
    hasRequirements: reqText != null,
    hasDesign: designText != null,
    hasTasks: tasksText != null,
    acceptanceCriteria: reqText ? parseAcceptanceCriteria(reqText) : [],
    tasks: tasksText ? parseTasks(tasksText) : [],
    updatedAt: await newestMtime([reqPath, designPath, tasksPath]),
  };
}

/** List all feature specs in the project, newest first. */
export async function listSpecFeatures(
  cwd: string,
  opts: { specDirectory?: string } = {},
): Promise<SpecFeature[]> {
  const root = specsDir(cwd, opts.specDirectory);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SpecFeature[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const feat = await readSpecFeature(cwd, ent.name, opts);
    if (feat) out.push(feat);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * Coverage report for one feature: which acceptance criteria are closed by at
 * least one task's `verify:` binding, and which are not. Drives the
 * "every AC must be verified" gate the spec-tasks skill enforces.
 */
export function specCoverage(feature: SpecFeature): {
  covered: string[];
  uncovered: string[];
  tasksWithoutVerify: string[];
} {
  const closed = new Set<string>();
  const tasksWithoutVerify: string[] = [];
  for (const t of feature.tasks) {
    if (!t.verifyCommand) tasksWithoutVerify.push(t.id);
    for (const ac of t.closesAcceptanceCriteria) closed.add(ac);
  }
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const ac of feature.acceptanceCriteria) {
    (closed.has(ac.id) ? covered : uncovered).push(ac.id);
  }
  return { covered, uncovered, tasksWithoutVerify };
}
