// Long-horizon goal mode: drive the agent until it reports done, blocked, or
// hits maxRounds. The session owns plan + memory state; the goal loop just
// keeps prompting with a structured per-round nudge.
//
// Enhancements (2025-Q1):
//   - Per-round checkpoint append: after each round we append a small
//     `### Round N — <status>` block to the session's checkpoint file
//     (under .codepilot/checkpoints/<sessionId>.md) so the next session
//     can see not just the final state but the trajectory that got us
//     there. The structured `blocked_reason` is included verbatim when
//     the round terminates with `<goal_status>blocked</goal_status>`.
//   - onCheckpoint callback: callers (CLI, protocol server) can observe
//     every checkpoint write without reading the file. The callback
//     fires once per round with the round index, status, optional
//     reason, and the checkpoint path. It is part of `GoalRunOptionsEx`
//     to preserve the existing `GoalRunOptions` shape.

import { createSession } from "./session.js";
import type { GoalRunOptions, GoalRunResult, Event } from "./types.js";
import { appendCheckpointRound, checkpointPath } from "./checkpoints.js";

/**
 * The two goal-completion markers the loop scans the final assistant text
 * for. They are part of the public prompt contract — see `goalPromptBody`.
 */
export const COMPLETION_MARKERS = [
  /<goal_status>completed<\/goal_status>/i,
  /<goal_status>blocked<\/goal_status>/i,
] as const;

const DEFAULT_MAX_ROUNDS = 50;

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
}

/**
 * The body of the per-round nudge the goal loop injects into the session.
 * It is exported so that callers (and tests) can introspect or override it.
 */
export const goalPromptBody = `You are running in a long-horizon goal loop. Each round you receive the same OBJECTIVE plus a short status line. Follow this protocol every turn:

1. Read the current plan (the system prompt's <plan> block) to see where you left off.
2. Identify the next step whose status is \`pending\` or whose status is \`in_progress\` from a prior round. Mark it \`in_progress\` via \`plan_update\`.
3. Execute that step using the available tools. Read files, make edits, run commands, call sub-agents — whatever the step needs.
4. Verify the step's deliverable (run a test, a build, a lint). Do not mark a step \`completed\` until verification passes.
5. Update the plan: mark the just-finished step \`completed\`, advance the cursor.
6. Decide whether the OBJECTIVE is fully satisfied:
   - If YES, end your turn with EXACTLY this line and nothing else after it:
     <goal_status>completed</goal_status>
   - If NO, but you are blocked on something that cannot be resolved in this loop (missing credentials, an external service, an ambiguity that only the user can resolve), end your turn with:
     <goal_status>blocked</goal_status>
     <goal_blocked_reason>one short sentence explaining the blocker</goal_blocked_reason>
   - Otherwise, do not emit any <goal_status> tag. The loop will keep prompting you.

Additional rules:
- Keep plans lean (3-8 steps). If a plan grows past that, collapse completed clusters.
- Persist anything you had to discover and that future sessions would benefit from to memory via \`memory_write\`.
- Do not commit, push, or perform other destructive operations unless the user explicitly asked.
- Prefer \`task\` for parallel exploration; do not serialise independent reads.
- If a step has been \`in_progress\` for more than two rounds without progress, mark it \`blocked\` and stop.

The loop will continue until you emit one of the status markers or it hits the round cap.`;

export async function runGoal(opts: GoalRunOptionsEx): Promise<GoalRunResult> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const session = await createSession(opts);
  let round = 0;
  let status: "completed" | "blocked" | "round_limit" = "round_limit";
  let reason: string | undefined;
  let blockedReason: string | undefined;
  const sessionId = session.id;
  const cwd = session.cwd;
  const checkpoint = checkpointPath(cwd, sessionId);

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

  try {
    for (round = 1; round <= maxRounds; round++) {
      opts.onRound?.(round, "running");
      await fireCheckpoint(round, "running");
      const userText = renderRoundPrompt(round, opts.objective);
      await session.prompt(userText);

      const events = session.getEvents();
      const lastAssistant = lastAssistantText(events);
      if (!lastAssistant) continue;
      const found = scanForStatus(lastAssistant);
      if (found === "completed") {
        status = "completed";
        reason = extractCompletedReason(lastAssistant) ?? "model reported completed";
        await fireCheckpoint(round, "completed", reason);
        break;
      }
      if (found === "blocked") {
        status = "blocked";
        blockedReason = extractBlockedReason(lastAssistant);
        reason = blockedReason ?? "model reported blocked";
        await fireCheckpoint(round, "blocked", reason, blockedReason);
        break;
      }
    }
  } finally {
    await session.dispose();
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
function renderRoundPrompt(round: number, objective: string): string {
  if (round === 1) {
    return `OBJECTIVE:
${objective}

${goalPromptBody}

This is round 1 of the goal loop. Begin by reading the current plan (likely empty) and either:
- call \`plan_update\` to create a first plan, or
- if the task is trivial enough to handle inline (a one-line fix, a single command), do it now and end with \`<goal_status>completed</goal_status>\`.`;
  }
  return `OBJECTIVE (unchanged across rounds):
${objective}

Round ${round} reminder:
${goalPromptBody}

Resume where you left off. If the previous turn ended without a status marker, it means there is still work to do.`;
}

function lastAssistantText(events: Event[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
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
