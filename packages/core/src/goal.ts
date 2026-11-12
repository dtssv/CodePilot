// Long-horizon goal mode: drive the agent until it reports done, blocked, or
// hits maxRounds. The session owns plan + memory state; the goal loop keeps
// prompting with a structured per-round nudge. Per-round checkpoints are
// appended to the session's checkpoint file.

import { createSession, type Session } from "./session.js";
import type { GoalRunOptions, GoalRunResult, Event } from "./types.js";
import { appendCheckpointRound, checkpointPath } from "./checkpoints.js";
import { killAllJobs } from "./tools/bashJobs.js";
import { listSpecFeatures } from "./specs.js";

/**
 * The two goal-completion markers the loop scans the final assistant text
 * for. They are part of the public prompt contract — see `goalPromptBody`.
 */
export const COMPLETION_MARKERS = [
  /<goal_status>completed<\/goal_status>/i,
  /<goal_status>blocked<\/goal_status>/i,
] as const;

const DEFAULT_MAX_ROUNDS = 50;

/** Consecutive no-progress rounds after which the loop forces `blocked`. A
 * round counts as progress when it wrote/edited a file, ran a shell command
 * that succeeded, advanced a plan step to `completed`, or produced a non-empty
 * reply. Without this, an agent that keeps thinking but never acts can burn
 * every round up to the cap. */
const DEFAULT_MAX_STALLS = 3;

/** Tools whose successful call counts as forward progress in a goal round. */
const PROGRESS_WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "notebook_edit",
]);
const PROGRESS_SHELL_TOOLS = new Set(["bash", "shell"]);

/** Structured data passed to `onCheckpoint` after each round. */
export interface GoalCheckpointInfo {
  round: number;
  status: "running" | "completed" | "blocked" | "round_limit";
  reason?: string;
  blockedReason?: string;
  path: string;
}

/**
 * Extension surface for `runGoal`. GoalRunOptions (in types.ts) is fixed;
 * this shape extends it with the new optional `onCheckpoint` callback
 * without forcing a types.ts change. Callers can pass either shape.
 */
export interface GoalRunOptionsEx extends GoalRunOptions {
  onCheckpoint?: (info: GoalCheckpointInfo) => void | Promise<void>;
  /** Fired once per no-progress round with the current consecutive-stall count
   * and the configured limit, so a host can surface "idle" progress. The loop
   * forces `blocked` when the count reaches the limit. */
  onStall?: (info: { round: number; stalls: number; limit: number }) => void | Promise<void>;
}

/**
 * The body of the per-round nudge the goal loop injects into the session.
 * It is exported so that callers (and tests) can introspect or override it.
 */
export const goalPromptBody = `You are running in a long-horizon goal loop. Each round you receive the same OBJECTIVE plus a short status line. Follow this protocol every turn:

1. Read the current plan (the system prompt's <plan> block) to see where you left off.
2. Identify the next step whose status is \`pending\` or whose status is \`in_progress\` from a prior round. Mark it \`in_progress\` via \`plan_update\`.
3. Execute that step using the available tools. Read files, make edits, run commands, call sub-agents — whatever the step needs.
4. Verify the step's deliverable (run a test, a build, a lint, or the acceptance check the OBJECTIVE implies). Do not mark a step \`completed\` until verification passes. Do not emit \`completed\` for the whole OBJECTIVE until a verify step has succeeded.
5. Update the plan: mark the just-finished step \`completed\`, advance the cursor.
6. Decide whether the OBJECTIVE is fully satisfied:
   - If YES, call the \`goal_status\` tool with \`status: "completed"\` (and a one-line reason). As a fallback you may instead end your turn with EXACTLY this line and nothing else after it:
     <goal_status>completed</goal_status>
   - If NO, but you are blocked on something that cannot be resolved in this loop (missing credentials, an external service, an ambiguity that only the user can resolve), call \`goal_status\` with \`status: "blocked"\` and a one-line reason — or, as a fallback, end your turn with:
     <goal_status>blocked</goal_status>
     <goal_blocked_reason>one short sentence explaining the blocker</goal_blocked_reason>
   - Otherwise, do not report a status. The loop will keep prompting you.

Additional rules:
- Prefer the \`goal_status\` tool over the text marker: it is the structured, reliable channel the loop trusts first. The text marker still works as a fallback.
- Keep plans lean (3-8 steps). If a plan grows past that, collapse completed clusters.
- Persist durable project facts future sessions would benefit from via \`memory_write\` (silent, project scope — prefer a \`section\`/\`topic\` so progressive memory stays navigable). Do not persist one-off procedures or push to user/global scope on your own.
- Do not commit, push, or perform other destructive operations unless the user explicitly asked.
- Prefer \`task\` for parallel exploration; do not serialise independent reads.
- If a step has been \`in_progress\` for more than two rounds without progress, mark it \`blocked\` and stop.

The loop will continue until you report a status (via the \`goal_status\` tool or the text marker) or it hits the round cap.`;

/**
 * Extra goal-loop guidance injected only when this project has a spec folder.
 * Kept separate from `goalPromptBody` so non-spec projects never see it.
 */
export const goalSpecClause = `\n\nThis project has a spec (a \`.codepilot/specs/<feature>/\` folder with requirements/design/tasks). Treat the acceptance criteria (\`AC-x.y\`) and each task's \`verify:<command> → AC-x.y\` line as the source of truth for "done": run the named verify command and treat an \`AC\` as satisfied only when its command passes. Do not emit \`completed\` for the OBJECTIVE while any acceptance criterion is still unmet.`;

export async function runGoal(opts: GoalRunOptionsEx): Promise<GoalRunResult> {
  const session = await createSession(opts);
  try {
    return await driveGoalRounds(session, opts);
  } finally {
    await session.dispose();
    await killAllJobs().catch(() => {});
  }
}

/**
 * Drive the goal loop over an already-created session, without creating or
 * disposing it. `runGoal` owns the session lifecycle; a host escalating the
 * current session can call this directly — the caller owns the lifecycle.
 */
export async function driveGoalRounds(
  session: Session,
  opts: Pick<GoalRunOptionsEx, "objective" | "maxRounds" | "maxStalls" | "onRound" | "onCheckpoint" | "onStall">
): Promise<GoalRunResult> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxStalls = opts.maxStalls ?? DEFAULT_MAX_STALLS;
  let round = 0;
  let status: "completed" | "blocked" | "round_limit" = "round_limit";
  let reason: string | undefined;
  let blockedReason: string | undefined;
  let stalls = 0;
  const sessionId = session.id;
  const cwd = session.cwd;
  const checkpoint = checkpointPath(cwd, sessionId);
  // Lazy spec awareness: only when this project actually has spec artifacts do
  // we bind the goal loop's "done" to acceptance criteria. No specs → [] → the
  // extra clause is never injected, so non-spec projects are unaffected.
  const hasSpec = await listSpecFeatures(cwd, {
    specDirectory: session.getConfig().specDirectory,
  })
    .then((f) => f.length > 0)
    .catch(() => false);

 // Helper: fire the per-round checkpoint (file + optional callback).
  const fireCheckpoint = async (
    roundIndex: number,
    s: "running" | "completed" | "blocked" | "round_limit",
    r?: string,
    br?: string
  ): Promise<void> => {
    try {
      await appendCheckpointRound(cwd, sessionId, roundIndex, s, r, br);
    } catch (err) {
      process.stderr.write(
        `[goal] checkpoint append failed: ${(err as Error).message}\n`
      );
    }
    if (opts.onCheckpoint) {
      try {
        await opts.onCheckpoint({
          round: roundIndex,
          status: s,
          reason: r,
          blockedReason: br,
          path: checkpoint,
        });
      } catch {
 /* listener errors are not fatal */
      }
    }
  };

  for (round = 1; round <= maxRounds; round++) {
    opts.onRound?.(round, "running");
    await fireCheckpoint(round, "running");
    // Watermark the transcript so we can judge THIS round's progress from only
    // the events it appends (writes, successful shell, plan advancement).
    const beforeCount = session.getEvents().length;
    const completedBefore = completedStepCount(session.getEvents());
    const userText = renderRoundPrompt(round, opts.objective, hasSpec);
    const delivery = await session.prompt(userText);
    // When the session was busy, `prompt()` enqueues the round and returns
    // "queued". Wait for it to drain before reading the result, else we'd scan
    // stale output and spin.
    if (delivery === "queued") {
      await session.waitUntilIdle();
    }

    const events = session.getEvents();
    const roundEvents = events.slice(beforeCount);
    const lastAssistant = lastAssistantText(events);
    // Dual-channel completion. Trust the structured `goal_status` tool event
    // (format-drift-proof) first; fall back to scanning the assistant text for
    // the `<goal_status>` markers. The last signal this round wins if both are
    // present (the tool already carries its own reason).
    const structured = lastStructuredStatus(roundEvents);
    const found = structured?.status ?? (lastAssistant ? scanForStatus(lastAssistant) : null);
    if (found === "completed") {
      status = "completed";
      reason =
        structured?.reason ??
        extractCompletedReason(lastAssistant) ??
        "model reported completed";
      await fireCheckpoint(round, "completed", reason);
      break;
    }
    if (found === "blocked") {
      status = "blocked";
      blockedReason = structured?.reason ?? extractBlockedReason(lastAssistant);
      reason = blockedReason ?? "model reported blocked";
      await fireCheckpoint(round, "blocked", reason, blockedReason);
      break;
    }

    // No status marker this round: judge progress. A productive round (a write,
    // a successful shell command, a plan step advanced, or a non-empty reply)
    // resets the stall counter; an idle round increments it. After maxStalls
    // consecutive idle rounds, force `blocked` rather than silently burning the
    // remaining rounds — the loop is making no headway on its own.
    if (maxStalls > 0) {
      if (roundMadeProgress(roundEvents, completedBefore)) {
        stalls = 0;
      } else {
        stalls++;
        if (opts.onStall) {
          try {
            await opts.onStall({ round, stalls, limit: maxStalls });
          } catch {
            /* listener errors are not fatal */
          }
        }
        if (stalls >= maxStalls) {
          status = "blocked";
          blockedReason =
            `no observable progress for ${stalls} consecutive rounds ` +
            `(no file writes, successful shell, or plan advancement) — stopping ` +
            `rather than burning the remaining rounds`;
          reason = blockedReason;
          await fireCheckpoint(round, "blocked", reason, blockedReason);
          break;
        }
      }
    }
  }

  if (status === "round_limit") {
    reason = `reached maxRounds=${maxRounds} without a status marker`;
    await fireCheckpoint(round, "round_limit", reason);
  }
  const result: GoalRunResult = { status, reason };
  if (blockedReason) {
    (result as GoalRunResult & { blockedReason?: string }).blockedReason = blockedReason;
  }
  return result;
}

/** Build the user-text for a given round. Round 1 frames the work; later rounds re-anchor it. */
function renderRoundPrompt(round: number, objective: string, hasSpec = false): string {
  // The spec clause is appended only when this project has spec artifacts, so
  // non-spec runs see exactly the original prompt body.
  const body = hasSpec ? `${goalPromptBody}${goalSpecClause}` : goalPromptBody;
  if (round === 1) {
    return `OBJECTIVE:
${objective}

${body}

This is round 1 of the goal loop. Begin by reading the current plan (likely empty) and either:
- call \`plan_update\` to create a first plan, or
- if the task is trivial enough to handle inline (a one-line fix, a single command), do it now and end with \`<goal_status>completed</goal_status>\`.`;
  }
  return `OBJECTIVE (unchanged across rounds):
${objective}

Round ${round} reminder:
${body}

Resume where you left off. If the previous turn ended without a status marker, it means there is still work to do.`;
}

/**
 * Did this round make observable progress? True when the round's events include
 * a successful write/edit tool call, a successful shell command, or the plan's
 * completed-step count rose. Text-only or empty rounds are NOT progress.
 */
function roundMadeProgress(roundEvents: Event[], completedBefore: number): boolean {
  const callNames = new Map<string, string>();
  let maxCompleted = completedBefore;
  for (const e of roundEvents) {
    if (e.type === "tool_call") {
      callNames.set(e.id, e.name);
    } else if (e.type === "tool_result") {
      if (e.isError) continue;
      const name = e.name ?? callNames.get(e.toolCallId) ?? "";
      if (PROGRESS_WRITE_TOOLS.has(name) || PROGRESS_SHELL_TOOLS.has(name)) {
        return true;
      }
    } else if (e.type === "plan") {
      const completed = e.steps.filter((s) => s.status === "completed").length;
      if (completed > maxCompleted) maxCompleted = completed;
    }
  }
  return maxCompleted > completedBefore;
}

/** Completed-step count of the most recent `plan` event, or 0 when none. */
function completedStepCount(events: Event[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "plan") {
      return e.steps.filter((s) => s.status === "completed").length;
    }
  }
  return 0;
}

/** The most recent structured `goal_status` event in this round's events, or
 * null when none. Preferred over scanning assistant text for the markers. */
function lastStructuredStatus(
  roundEvents: Event[]
): { status: "completed" | "blocked"; reason?: string } | null {
  for (let i = roundEvents.length - 1; i >= 0; i--) {
    const e = roundEvents[i]!;
    if (e.type === "goal_status") {
      return { status: e.status, reason: e.reason };
    }
  }
  return null;
}

function lastAssistantText(events: Event[]): string {  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "assistant") {
      return e.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
    }
  }
  return "";
}

function scanForStatus(text: string): "completed" | "blocked" | null {
  for (const re of COMPLETION_MARKERS) {
    const m = re.exec(text);
    if (!m) continue;
    if (m[0].toLowerCase().includes("completed")) return "completed";
    if (m[0].toLowerCase().includes("blocked")) return "blocked";
  }
  return null;
}

function extractBlockedReason(text: string): string | undefined {
  const m = /<goal_blocked_reason>([\s\S]*?)<\/goal_blocked_reason>/i.exec(text);
  if (m && m[1]) return m[1].trim();
 // Fallback: text after the blocked marker, first non-empty line.
  const fb = /<goal_status>blocked<\/goal_status>([\s\S]*)/i.exec(text);
  if (fb && fb[1]) {
    const first = fb[1].split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    if (first) return first;
  }
  return undefined;
}

function extractCompletedReason(text: string): string | undefined {
  const m = /<goal_completed_summary>([\s\S]*?)<\/goal_completed_summary>/i.exec(text);
  if (m && m[1]) return m[1].trim();
  return undefined;
}
