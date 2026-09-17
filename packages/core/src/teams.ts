// Agent Teams (ROADMAP-NEXT §4.2): multi-agent collaboration with explicit
// roles, a shared workspace, conflict detection, and a merge strategy.
//
// How this differs from `task`'s fan-out mode, which already runs several
// sub-agents in parallel:
//
//   fan-out    N independent objectives, N independent conclusions. The
//              parent agent reads all N and figures out what it means.
//   team       the members are working on ONE goal. A leader can split the
//              goal into assignments, members can share a worktree, edits
//              to the same file by two members are detected and reported,
//              and the results are merged by a declared strategy.
//
// The whole thing is built on the existing `SubagentRunner` — a team member
// is a sub-agent. What this module adds is orchestration around them:
// decomposition before, conflict detection during, merge after.
//
// Team members are peers, not a hierarchy of processes: every member runs at
// the same nesting depth, and (like all sub-agents) cannot spawn its own team.

import type { SubagentRunner, SubagentRunSpec } from "./tools/task.js";
import type { Event, TeamMessageEvent } from "./types.js";
import {
  createWorktree,
  removeWorktree,
  worktreeDiffStat,
  type WorktreeHandle,
} from "./worktree.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A member's role.
 *
 * - `leader` — decomposes the goal into assignments and (for the
 *   `leader_summary` strategy) writes the final report. Runs read-only:
 *   planning and summarising need no write access, and a leader that edits
 *   files while its workers do the same is exactly the conflict the team
 *   structure exists to avoid.
 * - `worker` — carries out an assignment. May edit files.
 * - `specialist` — a worker with a narrow remit (security, performance, …).
 *   Same execution path; the distinction is for the leader's benefit and
 *   for readable logs.
 */
export type TeamRole = "leader" | "worker" | "specialist";

export const TEAM_ROLES: readonly TeamRole[] = ["leader", "worker", "specialist"];

/** How the members' conclusions become one answer. */
export type MergeStrategy = "leader_summary" | "voting" | "concat";

export const MERGE_STRATEGIES: readonly MergeStrategy[] = [
  "leader_summary",
  "voting",
  "concat",
];

export interface TeamMemberSpec {
  role: TeamRole;
  /**
   * What this member should do. Optional for workers when a leader is
   * present: the leader is then asked to write the assignment. Required for
   * the leader itself only in the sense that it inherits the team objective.
   */
  objective?: string;
  /** Display name used in logs and `team_message` events. Defaults to
   *  `<role>-<n>`. Must be unique within the team. */
  name?: string;
  /** Sub-agent type (built-in `explore`/`worker`, or a custom agent name).
   *  Defaults to `explore` for leaders and `worker` for everyone else. */
  agent_type?: string;
  tools?: string[];
  model?: string;
  maxSteps?: number;
}

export interface TeamSpec {
  /** The shared goal. Used for leader decomposition and for the merge pass. */
  objective?: string;
  members: TeamMemberSpec[];
  /** Default: `leader_summary` when the team has a leader, else `concat`. */
  merge_strategy?: MergeStrategy;
  /** Run every member in ONE linked git worktree instead of the parent cwd,
   *  so a team that edits files leaves the user's working tree untouched. */
  shared_worktree?: boolean;
}

export interface TeamMemberResult {
  name: string;
  role: TeamRole;
  /** The objective actually executed (possibly written by the leader). */
  objective: string;
  conclusion: string;
  steps: number;
  ok: boolean;
  /** Files the member's write/edit tool calls targeted, relative-ish as the
   *  member named them. Used for conflict detection. */
  filesTouched: string[];
}

/** Two or more members wrote to the same file. */
export interface TeamConflict {
  file: string;
  members: string[];
}

export interface TeamRunResult {
  members: TeamMemberResult[];
  conflicts: TeamConflict[];
  /** The merged answer, per the merge strategy. */
  summary: string;
  mergeStrategy: MergeStrategy;
  /** Present when `shared_worktree` was requested and succeeded. */
  worktree?: { path: string; branch: string; diffStat: string };
  /** Why a requested feature was unavailable (worktree fallback, missing
   *  leader, …). Surfaced to the parent rather than silently swallowed. */
  notes: string[];
}

export interface TeamRunDeps {
  runner: SubagentRunner;
  cwd: string;
  /** Emits `team_message` events (persisted + streamed, never sent to the
   *  model). Usually `ToolContext.emitEvent`. */
  emitEvent?: (e: Event) => void | Promise<void>;
  /** Shared concurrency limiter so a team cannot exceed the session's
   *  sub-agent budget. */
  semaphore?: { withPermit<T>(fn: () => Promise<T>): Promise<T> };
  /** Nesting depth of the `task` call that created this team. */
  depth?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Member naming + validation
// ---------------------------------------------------------------------------

/** Assign stable, unique names to members, respecting explicit ones. */
export function nameMembers(members: TeamMemberSpec[]): string[] {
  const used = new Set<string>();
  const names: string[] = [];
  const counters = new Map<TeamRole, number>();
  for (const m of members) {
    let name = m.name?.trim();
    if (!name) {
      const n = (counters.get(m.role) ?? 0) + 1;
      counters.set(m.role, n);
      name = `${m.role}-${n}`;
    }
    // Explicit duplicates get a suffix rather than an error: a duplicated
    // name is a typo, not a reason to refuse to run the team.
    let unique = name;
    let i = 2;
    while (used.has(unique)) unique = `${name}#${i++}`;
    used.add(unique);
    names.push(unique);
  }
  return names;
}

export function validateTeam(spec: TeamSpec): string | null {
  if (!spec.members || spec.members.length === 0) return "team has no members";
  if (spec.members.length > 8) {
    return `team has ${spec.members.length} members; the maximum is 8`;
  }
  const leaders = spec.members.filter((m) => m.role === "leader");
  if (leaders.length > 1) {
    return `team has ${leaders.length} leaders; at most one is allowed`;
  }
  const doers = spec.members.filter((m) => m.role !== "leader");
  if (doers.length === 0) {
    return "team has only a leader; add at least one worker or specialist";
  }
  for (const m of spec.members) {
    if (!TEAM_ROLES.includes(m.role)) return `unknown role: ${String(m.role)}`;
  }
  const needsAssignment = doers.some((m) => !m.objective?.trim());
  if (needsAssignment && leaders.length === 0 && !spec.objective?.trim()) {
    return "every member needs an `objective`, or provide a team `objective` and a leader to write the assignments";
  }
  return null;
}

// ---------------------------------------------------------------------------
// File tracking (for conflict detection)
// ---------------------------------------------------------------------------

/** Tools whose calls mean "this member wrote to a file". */
const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "notebook_edit",
]);

/** Extract the target path from a write-tool call's input, if there is one. */
export function writtenPath(toolName: string, input: unknown): string | null {
  if (!WRITE_TOOLS.has(toolName)) return null;
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "notebook_path", "file"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** Files written by two or more members, sorted for stable output. */
export function detectConflicts(members: TeamMemberResult[]): TeamConflict[] {
  const byFile = new Map<string, Set<string>>();
  for (const m of members) {
    for (const f of m.filesTouched) {
      const set = byFile.get(f) ?? new Set<string>();
      set.add(m.name);
      byFile.set(f, set);
    }
  }
  const out: TeamConflict[] = [];
  for (const [file, names] of byFile) {
    if (names.size > 1) out.push({ file, members: [...names].sort() });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** JSON schema for the leader's decomposition pass. */
function assignmentSchema(names: string[]): Record<string, unknown> {
  return {
    type: "object",
    required: ["assignments"],
    properties: {
      assignments: {
        type: "array",
        description: `One entry per member that needs an assignment: ${names.join(", ")}`,
        items: {
          type: "object",
          required: ["member", "objective"],
          properties: {
            member: { type: "string", enum: names },
            objective: {
              type: "string",
              description:
                "A self-contained objective: the goal, the files/areas to work in, and exactly what to report back.",
            },
          },
        },
      },
    },
  };
}

function decomposePrompt(objective: string, roster: string): string {
  return (
    `You are the LEADER of an agent team working on this goal:\n\n${objective}\n\n` +
    `Your team:\n${roster}\n\n` +
    `Split the goal into one assignment per member listed as NEEDS-ASSIGNMENT. ` +
    `Investigate the codebase first (you are read-only) so the assignments name real ` +
    `files and real work. Rules:\n` +
    `- Assignments must be independently executable — members run in PARALLEL and ` +
    `cannot talk to each other.\n` +
    `- Do NOT give two members overlapping edits to the same file; that is the one ` +
    `failure mode this structure exists to prevent.\n` +
    `- Respect each member's stated remit (a specialist keeps its specialty).\n` +
    `- Each assignment states the goal, where to work, and what to report back.`
  );
}

function summaryPrompt(
  objective: string,
  members: TeamMemberResult[],
  conflicts: TeamConflict[],
): string {
  const body = members
    .map(
      (m) =>
        `<member name="${m.name}" role="${m.role}" ok="${m.ok}" steps="${m.steps}">\n` +
        `<objective>${m.objective}</objective>\n` +
        `<files_written>${m.filesTouched.join(", ") || "none"}</files_written>\n` +
        `<conclusion>\n${m.conclusion}\n</conclusion>\n</member>`,
    )
    .join("\n\n");
  const conflictBlock =
    conflicts.length > 0
      ? `\n\nFILE CONFLICTS — these files were written by more than one member, so ` +
        `their changes may have clobbered each other. Call this out explicitly and ` +
        `say what the user should verify:\n` +
        conflicts.map((c) => `- ${c.file}: ${c.members.join(", ")}`).join("\n")
      : "";

  return (
    `You are the LEADER of an agent team. The team's goal was:\n\n${objective}\n\n` +
    `Every member has finished. Write the team's single report for the parent agent.\n\n` +
    `${body}${conflictBlock}\n\n` +
    `Your report must: state what the team accomplished against the goal; list what ` +
    `each member changed; flag contradictions between members, unfinished work, and ` +
    `any file conflicts above; and end with what remains to be done ("none" if ` +
    `nothing). Do not re-do the members' work or re-read their files — synthesise ` +
    `what they reported. Be terse and concrete.`
  );
}

function votePrompt(objective: string, members: TeamMemberResult[]): string {
  const body = members
    .map(
      (m) =>
        `<candidate member="${m.name}" role="${m.role}">\n${m.conclusion}\n</candidate>`,
    )
    .join("\n\n");
  return (
    `Several agents independently worked on the same goal:\n\n${objective}\n\n` +
    `${body}\n\n` +
    `Decide which single answer the team should stand behind. Judge by agreement ` +
    `(what most members independently concluded), evidence quality, and internal ` +
    `consistency — not by length or confidence of tone. Return JSON: the winning ` +
    `member, a one-line rationale, and which members agreed with the winner.`
  );
}

const VOTE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["winner", "rationale"],
  properties: {
    winner: { type: "string", description: "The name of the winning member." },
    rationale: { type: "string", description: "One line: why this answer won." },
    agreed_with_winner: {
      type: "array",
      items: { type: "string" },
      description: "Names of members whose conclusions agree with the winner.",
    },
  },
};

/**
 * Run an agent team to completion.
 *
 * Order of operations: validate → (shared worktree) → leader decomposition →
 * members in parallel → conflict detection → merge. Every phase is
 * narrated through `team_message` events.
 */
export async function runTeam(
  spec: TeamSpec,
  deps: TeamRunDeps,
): Promise<TeamRunResult> {
  const invalid = validateTeam(spec);
  if (invalid) throw new Error(`invalid team: ${invalid}`);

  const notes: string[] = [];
  const names = nameMembers(spec.members);
  const leaderIndex = spec.members.findIndex((m) => m.role === "leader");
  const hasLeader = leaderIndex >= 0;
  const objective = spec.objective?.trim() || firstObjective(spec) || "(no objective given)";
  const strategy: MergeStrategy =
    spec.merge_strategy ?? (hasLeader ? "leader_summary" : "concat");

  const emit = async (
    msg: Omit<TeamMessageEvent, "type" | "timestamp">,
  ): Promise<void> => {
    if (!deps.emitEvent) return;
    await deps.emitEvent({ type: "team_message", timestamp: Date.now(), ...msg });
  };

  const runSpec = (
    member: TeamMemberSpec,
    name: string,
    memberObjective: string,
    cwd: string,
    onEvent?: (e: Event) => void,
  ): SubagentRunSpec => ({
    objective: memberObjective,
    cwd,
    // Leaders plan and summarise; they never need write access.
    agentType: member.agent_type ?? (member.role === "leader" ? "explore" : "worker"),
    tools: member.tools,
    model: member.model,
    maxSteps: member.maxSteps,
    depth: deps.depth,
    onEvent,
    // Isolation is a team-level decision (one shared worktree), never
    // per-member: members with separate worktrees could not see each
    // other's work, which defeats the point of a shared goal.
    isolation: "none",
  });

  // --- shared worktree ---------------------------------------------------
  let worktree: WorktreeHandle | null = null;
  let memberCwd = deps.cwd;
  if (spec.shared_worktree === true) {
    const wt = await createWorktree({ cwd: deps.cwd, label: "team" });
    if (wt.ok) {
      worktree = wt.worktree;
      memberCwd = wt.worktree.path;
      await emit({
        from: "team",
        to: "all",
        kind: "status",
        content:
          `shared worktree ready: ${wt.worktree.path} (branch ${wt.worktree.branch}, ` +
          `base ${wt.worktree.baseRef})`,
      });
    } else {
      notes.push(
        `shared worktree unavailable (${wt.reason}: ${wt.message}); members ran in the parent cwd`,
      );
    }
  }

  try {
    // --- leader decomposition -------------------------------------------
    const doers = spec.members
      .map((m, i) => ({ member: m, name: names[i]!, index: i }))
      .filter((x) => x.member.role !== "leader");
    const objectives = new Map<number, string>();
    for (const d of doers) {
      const own = d.member.objective?.trim();
      if (own) objectives.set(d.index, own);
    }
    const needAssignment = doers.filter((d) => !objectives.has(d.index));

    if (needAssignment.length > 0 && hasLeader && !deps.signal?.aborted) {
      const leader = spec.members[leaderIndex]!;
      const leaderName = names[leaderIndex]!;
      const roster = doers
        .map(
          (d) =>
            `- ${d.name} (${d.member.role})` +
            (objectives.has(d.index)
              ? `: already assigned — "${objectives.get(d.index)}"`
              : `: NEEDS-ASSIGNMENT`),
        )
        .join("\n");
      await emit({
        from: "team",
        to: leaderName,
        kind: "status",
        content: `decomposing the goal into ${needAssignment.length} assignment(s)`,
      });
      const plan = await runMember(
        deps,
        {
          ...runSpec(leader, leaderName, decomposePrompt(objective, roster), memberCwd),
          outputSchema: assignmentSchema(needAssignment.map((d) => d.name)),
        },
      );
      const assignments = parseAssignments(plan.conclusion);
      for (const d of needAssignment) {
        const assigned = assignments.get(d.name);
        if (assigned) {
          objectives.set(d.index, assigned);
          await emit({
            from: leaderName,
            to: d.name,
            kind: "assignment",
            content: assigned,
          });
        }
      }
      const unassigned = needAssignment.filter((d) => !objectives.has(d.index));
      if (unassigned.length > 0) {
        // Fall back to the team objective so the member still does useful
        // work; say so, because an un-decomposed team is not what was asked.
        notes.push(
          `leader did not produce an assignment for ${unassigned
            .map((d) => d.name)
            .join(", ")}; they received the team objective instead`,
        );
        for (const d of unassigned) objectives.set(d.index, objective);
      }
    } else if (needAssignment.length > 0) {
      for (const d of needAssignment) objectives.set(d.index, objective);
    }

    // --- members in parallel --------------------------------------------
    const results = await Promise.all(
      doers.map(async (d): Promise<TeamMemberResult> => {
        const memberObjective = objectives.get(d.index) ?? objective;
        const filesTouched = new Set<string>();
        const onEvent = (e: Event): void => {
          if (e.type === "tool_call") {
            const p = writtenPath(e.name, e.input);
            if (p) filesTouched.add(p);
          }
        };
        await emit({
          from: "team",
          to: d.name,
          kind: "status",
          content: `started (${d.member.agent_type ?? d.member.role})`,
        });
        try {
          const r = await runMember(
            deps,
            runSpec(d.member, d.name, memberObjective, memberCwd, onEvent),
          );
          await emit({
            from: d.name,
            to: hasLeader ? names[leaderIndex]! : "all",
            kind: "conclusion",
            content: r.conclusion,
          });
          return {
            name: d.name,
            role: d.member.role,
            objective: memberObjective,
            conclusion: r.conclusion,
            steps: r.steps,
            ok: true,
            filesTouched: [...filesTouched],
          };
        } catch (err) {
          const message = (err as Error).message;
          await emit({
            from: d.name,
            to: hasLeader ? names[leaderIndex]! : "all",
            kind: "conclusion",
            content: `FAILED: ${message}`,
          });
          return {
            name: d.name,
            role: d.member.role,
            objective: memberObjective,
            conclusion: `FAILED: ${message}`,
            steps: 0,
            ok: false,
            filesTouched: [...filesTouched],
          };
        }
      }),
    );

    // --- conflict detection ---------------------------------------------
    const conflicts = detectConflicts(results);
    if (conflicts.length > 0) {
      await emit({
        from: "team",
        to: "all",
        kind: "conflict",
        content:
          `${conflicts.length} file(s) written by more than one member:\n` +
          conflicts.map((c) => `- ${c.file}: ${c.members.join(", ")}`).join("\n"),
      });
    }

    // --- merge -----------------------------------------------------------
    const merged = await mergeResults(
      strategy,
      { objective, results, conflicts, notes, hasLeader, leaderIndex, names, spec },
      deps,
      memberCwd,
      runSpec,
    );
    await emit({
      from: hasLeader ? names[leaderIndex]! : "team",
      to: "all",
      kind: "summary",
      content: merged.summary,
    });

    let worktreeInfo: TeamRunResult["worktree"];
    if (worktree) {
      worktreeInfo = {
        path: worktree.path,
        branch: worktree.branch,
        diffStat: await worktreeDiffStat(worktree),
      };
    }

    return {
      members: results,
      conflicts,
      summary: merged.summary,
      mergeStrategy: merged.strategy,
      worktree: worktreeInfo,
      notes: [...notes, ...merged.notes],
    };
  } finally {
    // The worktree is removed but its BRANCH is kept: the team's edits are
    // the deliverable, and a removed branch would throw them away. The
    // parent gets the branch name and the diff stat.
    if (worktree) {
      await removeWorktree(worktree, { keepBranch: true }).catch(() => undefined);
    }
  }
}

interface MergeContext {
  objective: string;
  results: TeamMemberResult[];
  conflicts: TeamConflict[];
  notes: string[];
  hasLeader: boolean;
  leaderIndex: number;
  names: string[];
  spec: TeamSpec;
}

async function mergeResults(
  strategy: MergeStrategy,
  ctx: MergeContext,
  deps: TeamRunDeps,
  cwd: string,
  runSpec: (
    m: TeamMemberSpec,
    name: string,
    objective: string,
    cwd: string,
    onEvent?: (e: Event) => void,
  ) => SubagentRunSpec,
): Promise<{ summary: string; strategy: MergeStrategy; notes: string[] }> {
  const notes: string[] = [];
  const concat = (): string => concatSummary(ctx.results, ctx.conflicts);

  if (strategy === "concat" || deps.signal?.aborted) {
    return { summary: concat(), strategy: "concat", notes };
  }

  // Both remaining strategies need a member to run the merge pass. A leader
  // is the natural choice; without one we synthesise a read-only judge
  // rather than refusing, and record that we did.
  const merger: TeamMemberSpec = ctx.hasLeader
    ? ctx.spec.members[ctx.leaderIndex]!
    : { role: "leader", agent_type: "explore" };
  const mergerName = ctx.hasLeader ? ctx.names[ctx.leaderIndex]! : "team-judge";
  if (!ctx.hasLeader) {
    notes.push(
      `merge_strategy "${strategy}" needs a leader; an implicit read-only ${mergerName} performed the merge`,
    );
  }

  if (strategy === "voting") {
    const usable = ctx.results.filter((r) => r.ok);
    if (usable.length < 2) {
      notes.push(
        `voting needs at least 2 successful members (got ${usable.length}); fell back to concat`,
      );
      return { summary: concat(), strategy: "concat", notes };
    }
    try {
      const r = await runMember(deps, {
        ...runSpec(merger, mergerName, votePrompt(ctx.objective, usable), cwd),
        outputSchema: VOTE_SCHEMA,
      });
      const vote = parseVote(r.conclusion);
      const winner = usable.find((m) => m.name === vote?.winner);
      if (!vote || !winner) {
        notes.push("vote result was unusable; fell back to concat");
        return { summary: concat(), strategy: "concat", notes };
      }
      const agreed = (vote.agreedWith ?? []).filter((n) =>
        usable.some((m) => m.name === n),
      );
      const header =
        `Team vote: **${winner.name}** wins ` +
        `(${agreed.length + 1}/${usable.length} in agreement).\n` +
        `Rationale: ${vote.rationale}\n`;
      return {
        summary: `${header}\n${winner.conclusion}\n\n${conflictFooter(ctx.conflicts)}`.trim(),
        strategy: "voting",
        notes,
      };
    } catch (err) {
      notes.push(`voting pass failed (${(err as Error).message}); fell back to concat`);
      return { summary: concat(), strategy: "concat", notes };
    }
  }

  // leader_summary
  try {
    const r = await runMember(
      deps,
      runSpec(
        merger,
        mergerName,
        summaryPrompt(ctx.objective, ctx.results, ctx.conflicts),
        cwd,
      ),
    );
    return { summary: r.conclusion, strategy: "leader_summary", notes };
  } catch (err) {
    notes.push(
      `leader summary failed (${(err as Error).message}); fell back to concat`,
    );
    return { summary: concat(), strategy: "concat", notes };
  }
}

/** Run one member through the shared semaphore, when there is one. */
async function runMember(
  deps: TeamRunDeps,
  spec: SubagentRunSpec,
): Promise<{ conclusion: string; steps: number }> {
  if (!deps.semaphore) return deps.runner.run(spec);
  return deps.semaphore.withPermit(() => deps.runner.run(spec));
}

function firstObjective(spec: TeamSpec): string | undefined {
  for (const m of spec.members) {
    const o = m.objective?.trim();
    if (o) return o;
  }
  return undefined;
}

function conflictFooter(conflicts: TeamConflict[]): string {
  if (conflicts.length === 0) return "";
  return (
    `### File conflicts\n` +
    `These files were written by more than one member; verify them:\n` +
    conflicts.map((c) => `- \`${c.file}\` — ${c.members.join(", ")}`).join("\n")
  );
}

/** The no-model merge: every conclusion, verbatim, under its member. */
export function concatSummary(
  members: TeamMemberResult[],
  conflicts: TeamConflict[],
): string {
  const body = members
    .map(
      (m) =>
        `### ${m.name} (${m.role}) — ${m.ok ? `${m.steps} step(s)` : "FAILED"}\n\n` +
        `_Objective:_ ${m.objective}\n\n${m.conclusion}`,
    )
    .join("\n\n---\n\n");
  const footer = conflictFooter(conflicts);
  return footer ? `${body}\n\n---\n\n${footer}` : body;
}

// ---------------------------------------------------------------------------
// Parsing the leader's structured output
// ---------------------------------------------------------------------------

/** Pull a JSON value out of a sub-agent conclusion (possibly fenced). */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), text.trim()].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try the next candidate */
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

/** member name → objective, from the leader's decomposition output. */
export function parseAssignments(conclusion: string): Map<string, string> {
  const out = new Map<string, string>();
  const parsed = extractJson(conclusion);
  if (typeof parsed !== "object" || parsed === null) return out;
  const list = (parsed as { assignments?: unknown }).assignments;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const { member, objective } = entry as Record<string, unknown>;
    if (typeof member !== "string" || typeof objective !== "string") continue;
    if (objective.trim().length === 0) continue;
    out.set(member, objective.trim());
  }
  return out;
}

export interface TeamVote {
  winner: string;
  rationale: string;
  agreedWith?: string[];
}

export function parseVote(conclusion: string): TeamVote | null {
  const parsed = extractJson(conclusion);
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.winner !== "string" || o.winner.trim().length === 0) return null;
  const agreed = Array.isArray(o.agreed_with_winner)
    ? o.agreed_with_winner.filter((x): x is string => typeof x === "string")
    : undefined;
  return {
    winner: o.winner.trim(),
    rationale:
      typeof o.rationale === "string" && o.rationale.trim().length > 0
        ? o.rationale.trim()
        : "(no rationale given)",
    agreedWith: agreed,
  };
}

// ---------------------------------------------------------------------------
// Rendering for the `task` tool result
// ---------------------------------------------------------------------------

/** Format a team run as the text the parent agent receives. */
export function renderTeamResult(result: TeamRunResult): string {
  const okCount = result.members.filter((m) => m.ok).length;
  const head =
    `Team finished: ${okCount}/${result.members.length} members succeeded, ` +
    `merge strategy "${result.mergeStrategy}"` +
    (result.conflicts.length > 0
      ? `, ${result.conflicts.length} file conflict(s)`
      : "") +
    ".";
  const parts = [head, "", result.summary];
  if (result.worktree) {
    parts.push(
      "",
      `[shared worktree — branch ${result.worktree.branch}]`,
      result.worktree.diffStat.length > 0
        ? result.worktree.diffStat
        : "(no changes)",
      `The worktree directory was removed; the branch is kept for you to review or merge.`,
    );
  }
  if (result.notes.length > 0) {
    parts.push("", `[notes]`, ...result.notes.map((n) => `- ${n}`));
  }
  return parts.join("\n");
}
