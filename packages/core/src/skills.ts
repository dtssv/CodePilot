// Skill system.
//
// A "skill" is a folder containing a SKILL.md file with YAML frontmatter and a
// markdown body of instructions. CodePilot discovers skills from three sources
// (highest priority first):
//
//   1. <cwd>/.codepilot/skills/*/SKILL.md    (project-local)
//   2. ~/.codepilot/skills/*/SKILL.md        (user-global)
//   3. packages/core/skills/*/SKILL.md       (built-in, shipped with the package)
//
// The system prompt advertises only the skill name + a one-line description for
// every discovered skill. The body is loaded on demand through the `skill`
// tool — progressive disclosure that keeps the static prefix small and
// preserves prompt-cache hits across turns.
//
// The format mirrors what claude-code and DSH call a "skill": a self-contained
// markdown file with simple frontmatter (`name`, `description`, optional
// `tools` list, optional `when` hint), and a body that the model can follow
// verbatim. We deliberately do not implement a full YAML parser — only the
// small subset above is recognised — so the dependency footprint stays at zero.

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Skill {
  /** Canonical skill name (from frontmatter, or the folder name as fallback). */
  name: string;
  /** One-line description shown in the system prompt summary. */
  description: string;
  /** Optional hint for when the skill should be invoked. */
  when?: string;
  /** Optional list of tool names the skill expects to use. */
  tools?: string[];
  /** Absolute path to the SKILL.md file on disk. */
  path: string;
  /** Absolute path to the skill directory. */
  dir: string;
  /** Which source this skill came from. */
  source: SkillSource;
  /** Full markdown body (frontmatter stripped). */
  body: string;
}

export type SkillSource = "project" | "user" | "builtin";

export interface DiscoverOptions {
  /** Override the project-local skills directory (defaults to `<cwd>/.codepilot/skills`). */
  projectDir?: string;
  /** Override the user-global skills directory (defaults to `~/.codepilot/skills`). */
  userDir?: string;
  /** Override the built-in skills directory. Defaults to the directory shipped
   *  with `@codepilot/core` (resolved from this module's location). */
  builtinDir?: string;
  /** Extra explicit skill directories to scan (lowest priority after builtins). */
  extraDirs?: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter parser (deliberately minimal)
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md file's text into `{ frontmatter, body }`. The frontmatter
 * is a simple `key: value` block delimited by `---` lines at the top of the
 * file. Only the keys we recognise (`name`, `description`, `when`, `tools`)
 * are returned; everything else is silently ignored.
 *
 * Implementation notes:
 *   - We split on the first two `---` lines. Anything after the closing
 *     `---` is the body.
 *   - We do not handle multi-line values, anchors, or include directives.
 *     A full YAML parser would add 100+ KB to the bundle for a feature we
 *     don't need.
 *   - Lists are parsed as either YAML flow syntax (`[a, b, c]`) or repeated
 *     keys at the same indent (`tools:\n  - foo\n  - bar`).
 */
export function parseSkillMd(
  text: string
): { name?: string; description?: string; when?: string; tools?: string[] } {
  const out: {
    name?: string;
    description?: string;
    when?: string;
    tools?: string[];
  } = {};
  // Detect leading frontmatter: must start with `---` on its own line.
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") return out;
  // Find the closing `---`.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return out;

  const fmLines = lines.slice(1, end);
  let currentKey: string | null = null;
  for (const raw of fmLines) {
    const line = raw.replace(/\s+$/, "");
    if (line.length === 0) continue;
    if (/^\s/.test(line) && currentKey) {
      // Continuation — list item under the current key.
      const trimmed = line.trim();
      if (currentKey === "tools") {
        if (trimmed.startsWith("- ")) {
          out.tools = out.tools ?? [];
          out.tools.push(trimmed.slice(2).trim());
        }
      }
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = (m[2] ?? "").trim();
    currentKey = key;
    if (value.length === 0) continue; // list starts on next line
    if (key === "name") out.name = stripQuotes(value);
    else if (key === "description") out.description = stripQuotes(value);
    else if (key === "when") out.when = stripQuotes(value);
    else if (key === "tools") {
      // Either flow list `[a, b, c]` or a single bare value.
      const flow = value.match(/^\[(.*)\]$/);
      if (flow) {
        out.tools = flow[1]!
          .split(",")
          .map((s) => stripQuotes(s.trim()))
          .filter((s) => s.length > 0);
      } else {
        out.tools = [stripQuotes(value)];
      }
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const BUILTIN_SKILLS_DIR_HINT = ["skills"]; // relative to packages/core/

/** Resolve the absolute path to the directory holding the built-in skills.
 *  We resolve from this module's URL so the result is stable regardless of
 *  the caller's cwd — the build emits `dist/skills.js`, and `skills/` lives
 *  one level up from `src/`, so we walk up from `dist/`. */
export function defaultBuiltinSkillsDir(): string {
  // The compiled file lives at <pkg>/dist/skills.js; the source is at
  // <pkg>/src/skills.ts. In both layouts the skills/ folder sits next to
  // the package root, so the parent of the file's directory is the right
  // place to look.
  const here = fileURLToPath(import.meta.url);
  const pkgRoot = resolve(dirname(here), "..");
  return join(pkgRoot, ...BUILTIN_SKILLS_DIR_HINT);
}

/** Walk a directory looking for immediate subdirectories that contain a
 *  `SKILL.md`. Non-recursive on purpose — each skill is exactly one folder.
 *  Missing directories are not an error — they simply return `[]`, and the
 *  caller falls back to the embedded built-in skills. */
async function scanDirForSkills(
  dir: string,
  source: SkillSource
): Promise<Skill[]> {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const skillDir = join(dir, entry);
    let st;
    try {
      st = await stat(skillDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillPath = join(skillDir, "SKILL.md");
    let text: string;
    try {
      text = await readFile(skillPath, "utf-8");
    } catch {
      continue;
    }
    const fm = parseSkillMd(text);
    const body = stripFrontmatter(text);
    const name = fm.name ?? entry;
    out.push({
      name,
      description: fm.description ?? "",
      when: fm.when,
      tools: fm.tools,
      path: skillPath,
      dir: skillDir,
      source,
      body,
    });
  }
  return out;
}

/** Build a `Skill` from the embedded `BUILTIN_SKILLS` table. We assign the
 *  on-disk path to a synthetic placeholder under the resolved builtin dir so
 *  the field is always a real absolute path; tests and production code can
 *  rely on `path` being non-empty. */
function builtinSkillObjects(): Skill[] {
  const dir = defaultBuiltinSkillsDir();
  const out: Skill[] = [];
  for (const b of BUILTIN_SKILLS) {
    const fm = parseSkillMd(b.markdown);
    out.push({
      name: fm.name ?? b.name,
      description: fm.description ?? "",
      when: fm.when,
      tools: fm.tools,
      path: join(dir, b.name, "SKILL.md"),
      dir: join(dir, b.name),
      source: "builtin",
      body: stripFrontmatter(b.markdown),
    });
  }
  return out;
}

function stripFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      return lines.slice(i + 1).join("\n").replace(/^\s*\n/, "");
    }
  }
  return text;
}

/** Discover skills from all known sources. Later sources do NOT override
 *  earlier ones — the first definition of a name wins (project > user > builtin).
 *  The `extraDirs` argument, if given, is scanned after builtins and uses the
 *  `project` source label.
 *
 *  Built-in skills come from one of two places, in priority order:
 *    1. The on-disk `packages/core/skills/` directory (if it exists on the host
 *       filesystem — useful during development and for users who install from
 *       a source checkout).
 *    2. The embedded `BUILTIN_SKILLS` table (used when the package is installed
 *       from a registry and the skills directory is not shipped). */
export async function discoverSkills(
  cwd: string,
  extraDirs: string[] | string | DiscoverOptions = []
): Promise<Skill[]> {
  const opts: DiscoverOptions =
    typeof extraDirs === "string" || Array.isArray(extraDirs)
      ? { extraDirs: Array.isArray(extraDirs) ? extraDirs : [extraDirs] }
      : extraDirs;
  const projectDir =
    opts.projectDir ?? join(cwd, ".codepilot", "skills");
  const userDir = opts.userDir ?? join(homedir(), ".codepilot", "skills");
  const builtinDir = opts.builtinDir ?? defaultBuiltinSkillsDir();
  const extra = opts.extraDirs ?? [];

  const collected: Skill[] = [];
  const seen = new Set<string>();
  const add = (s: Skill) => {
    if (seen.has(s.name)) return;
    seen.add(s.name);
    collected.push(s);
  };

  const projectSkills = await scanDirForSkills(projectDir, "project");
  for (const s of projectSkills) add(s);
  const userSkills = await scanDirForSkills(userDir, "user");
  for (const s of userSkills) add(s);
  for (const ed of extra) {
    if (!ed) continue;
    const abs = isAbsolute(ed) ? ed : resolve(cwd, ed);
    const more = await scanDirForSkills(abs, "project");
    for (const s of more) add(s);
  }
  // Built-ins: prefer on-disk (lets the source tree override), fall back to
  // the embedded table.
  const onDiskBuiltins = await scanDirForSkills(builtinDir, "builtin");
  if (onDiskBuiltins.length > 0) {
    for (const s of onDiskBuiltins) add(s);
  } else {
    for (const s of builtinSkillObjects()) add(s);
  }

  // Stable order: by source priority, then alphabetically by name.
  const priority: Record<SkillSource, number> = { project: 0, user: 1, builtin: 2 };
  collected.sort((a, b) => {
    const pa = priority[a.source] - priority[b.source];
    if (pa !== 0) return pa;
    return a.name.localeCompare(b.name);
  });
  return collected;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Find the best skill for a query. Matching is case-insensitive and tries, in
 * order:
 *   1. Exact name match.
 *   2. Substring match of the query in the name.
 *   3. Substring match of any whitespace-separated keyword in the name,
 *      description, or `when` hint.
 *
 * Returns `null` if no skill is a plausible match.
 */
export function matchSkill(skills: Skill[], query: string): Skill | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return null;
  // 1. exact name
  for (const s of skills) {
    if (s.name.toLowerCase() === q) return s;
  }
  // 2. name substring
  for (const s of skills) {
    if (s.name.toLowerCase().includes(q)) return s;
  }
  // 3. keyword in name / description / when
  for (const s of skills) {
    const hay = `${s.name} ${s.description} ${s.when ?? ""}`.toLowerCase();
    if (hay.includes(q)) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// System-prompt section (progressive disclosure)
// ---------------------------------------------------------------------------

/**
 * Render the system-prompt section that advertises available skills. The
 * session layer can splice this in directly — it is intentionally short:
 * each skill contributes only its name and a one-line description. The full
 * instructions live behind the `skill` tool, so a model that needs detail
 * can fetch it on demand without bloating the static prefix.
 */
export function skillsPromptSection(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines: string[] = [];
  lines.push(`<skills>`);
  lines.push(
    "The following skills are available. Each one is a reusable instruction " +
      "set you can load on demand by calling the `skill` tool with the skill " +
      "name. Load a skill when the user request matches its description; the " +
      "loaded body replaces the abstract description and gives you the exact " +
      "checklist, commands, or output format the skill requires."
  );
  for (const s of skills) {
    const when = s.when ? ` — when: ${s.when}` : "";
    const tools = s.tools && s.tools.length > 0 ? ` [tools: ${s.tools.join(", ")}]` : "";
    lines.push(`- \`${s.name}\`: ${s.description || "(no description)"}${when}${tools}`);
  }
  lines.push(`</skills>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Convenience: load a single skill by name (used by the `skill` tool)
// ---------------------------------------------------------------------------

/** Look up a skill by exact name in a pre-discovered list. */
export function findSkill(skills: Skill[], name: string): Skill | null {
  for (const s of skills) {
    if (s.name === name) return s;
  }
  // case-insensitive fallback
  const lower = name.toLowerCase();
  for (const s of skills) {
    if (s.name.toLowerCase() === lower) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Built-in skill body (embedded so the package is self-contained).
// ---------------------------------------------------------------------------
//
// The actual SKILL.md files also live in `packages/core/skills/` for users who
// want to read them on disk, but we embed the markdown here so the discovery
// path does not depend on the package's installation layout (which can be
// flattened by pnpm or hoisted by npm). Discovery falls back to the on-disk
// copy if present and otherwise constructs the Skill object from these.

export const BUILTIN_SKILLS: ReadonlyArray<{ name: string; markdown: string }> = [
  {
    name: "commit",
    markdown: `---
name: commit
description: Generate a Conventional Commits message and create a single logical commit for the current staged/unstaged work.
when: The user asks to commit, save, or record the current change.
tools:
  - bash
  - read_file
  - grep
---

# commit

Use this skill when the user asks to commit the current change set.

## Workflow

1. Inspect the working tree:
   - \`git status --short\`
   - \`git diff --stat\`
   - \`git log -5 --oneline\` to confirm the project's commit style.

2. Decide what belongs in the commit. The default is **one logical commit** for
   everything the user just asked for. If the change set mixes unrelated concerns
   (e.g. a feature and a refactor), stop and ask the user before splitting.

3. Stage the relevant files with \`git add <paths>\`. Do **not** stage
   \`.codepilot/\`, \`dist/\`, \`node_modules/\`, or anything covered by
   \`.gitignore\`.

4. Write the commit message in **Conventional Commits** format:

       <type>(<scope>)<!>: <short summary>

       <body — explain WHY, not what. Wrap at 72 cols.>

       <footer — references, breaking-change notes>

   - \`type\` is one of \`feat\`, \`fix\`, \`chore\`, \`docs\`, \`refactor\`,
     \`test\`, \`perf\`, \`build\`, \`ci\`, \`style\`, \`revert\`.
   - \`!\` marks a breaking change.
   - Subject ≤ 72 chars, imperative mood, no trailing period.
   - If the project uses a different convention (look at \`git log\`), follow
     that instead.

5. Create the commit with \`git commit -m "<subject>\" -m "<body>"\`. Use a
   single \`-m\` per paragraph for clean formatting.

6. Do **not** push, force-push, amend, or rewrite history. If the user asked
   for any of those, confirm before doing it.

7. Report the new commit's short SHA and subject in your final message.
`,
  },
  {
    name: "review",
    markdown: `---
name: review
description: Read a diff (staged, unstaged, or branch-vs-base) and produce a structured code review with severity-tagged findings.
when: The user asks to review, audit, or critique a change.
tools:
  - bash
  - read_file
  - grep
---

# review

Use this skill when the user asks for a code review of a change set.

## Workflow

1. Determine the diff to review. Pick the right one:
   - Working tree: \`git diff\`
   - Staged: \`git diff --cached\`
   - vs. main: \`git diff main...HEAD\`
   - A specific commit: \`git show <sha>\`
   If unclear, ask the user.

2. Read the surrounding code for any region that is non-obvious. Do not
   review in a vacuum — context matters for naming, error handling, and
   invariant checks.

3. Walk the diff in source order. For each hunk, check:
   - **Correctness**: Does the code do what it claims? Are there off-by-one,
     null/undefined, async/await, or resource-leak bugs?
   - **Edge cases**: Empty inputs, very large inputs, concurrent access,
     partial failure.
   - **API surface**: Are public signatures backwards-compatible? Is the new
     error contract documented?
   - **Tests**: Is the change covered? Are the new tests meaningful (not
     tautological)?
   - **Naming / readability**: Would a new contributor understand this in 6
     months?
   - **Security**: Any untrusted input that reaches a sink? Any new secret
     handling?
   - **Performance**: Any obvious O(n²) where O(n) is available? Any
     accidental work in hot paths?

4. Output the review as a Markdown list. Tag each finding with a severity:

   - \`[blocker]\` — must fix before merge (correctness, security, data loss).
   - \`[major]\` — should fix; meaningful defect or maintainability hit.
   - \`[minor]\` — nitpick; would-be-nice polish.
   - \`[nit]\` — style / preference only.

   For each finding, cite the file and line range, quote the relevant code,
   and propose a concrete fix.

5. End the review with a short **summary**:
   - Overall verdict (\`approve\`, \`request changes\`, \`comment\`).
   - One-line per-file takeaway.
   - Anything you explicitly did **not** review (e.g. generated code,
     vendored dependencies).
`,
  },
];
