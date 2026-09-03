// Long-horizon goal mode: drive the agent until it reports done, blocked, or
// hits maxRounds. The session is responsible for plan + memory state; the
// goal loop just keeps prompting.

import { createSession } from "./session.js";
import type { GoalRunOptions, GoalRunResult, Event } from "./types.js";

const COMPLETION_MARKERS = [
  /<goal_status>completed<\/goal_status>/i,
  /<goal_status>blocked<\/goal_status>/i,
];

const DEFAULT_MAX_ROUNDS = 50;

export async function runGoal(opts: GoalRunOptions): Promise<GoalRunResult> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const session = await createSession(opts);
  let round = 0;
  let status: "completed" | "blocked" | "round_limit" = "round_limit";
  let reason: string | undefined;

  try {
    for (round = 1; round <= maxRounds; round++) {
      opts.onRound?.(round, "running");
      const userText =
        round === 1
          ? `OBJECTIVE: ${opts.objective}\n\n` +
            "Plan and execute. When you are fully done, output exactly:\n" +
            "<goal_status>completed</goal_status>\n" +
            "If you are stuck and cannot proceed, output exactly:\n" +
            "<goal_status>blocked</goal_status>\n" +
            "Followed by a short reason. Otherwise, keep working."
          : `Continue working on the objective. Use plan_update, tools, and memory_write as appropriate. ` +
            "When fully done, output <goal_status>completed</goal_status>. " +
            "If stuck, output <goal_status>blocked</goal_status> with a reason.";
      await session.prompt(userText);

      const events = session.getEvents();
      const lastAssistant = lastAssistantText(events);
      if (!lastAssistant) continue;
      const found = scanForStatus(lastAssistant);
      if (found === "completed") {
        status = "completed";
        reason = "model reported completed";
        break;
      }
      if (found === "blocked") {
        status = "blocked";
        reason = extractBlockedReason(lastAssistant) ?? "model reported blocked";
        break;
      }
    }
  } finally {
    await session.dispose();
  }

  return { status, reason };
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
    if (m[0].includes("completed")) return "completed";
    if (m[0].includes("blocked")) return "blocked";
  }
  return null;
}

function extractBlockedReason(text: string): string | undefined {
  // Look for text after the blocked marker.
  const m = /<goal_status>blocked<\/goal_status>([\s\S]*)/i.exec(text);
  if (m && m[1]) return m[1].trim().split("\n")[0];
  return undefined;
}
