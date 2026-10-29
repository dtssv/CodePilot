// start_goal: let the model escalate the CURRENT task into a long-horizon
// goal loop — multi-round autonomous execution that keeps driving until the
// objective is met, blocked, or a round cap is reached.
//
// Why a tool, not a heuristic
// ---------------------------
// There is no "detect a complex/long task and auto-start a goal loop"
// heuristic anywhere — that would be scenario-specific and misfire. Instead the
// MODEL, which understands the request, declares "this is a long-horizon
// objective worth driving in rounds" via a structured tool call. This mirrors
// how dsh exposes `create_goal` (model-invoked, not inferred from the prompt)
// and matches CodePilot's `suggest_mode` / `start_new_task` philosophy: a
// generic capability the model opts into, never a system guess.
//
// How the loop actually runs
// --------------------------
// core's `session.prompt()` returns control to the host each turn — core is not
// an event bus that auto-continues. So this tool does NOT loop inside the
// session. It emits a `goal_request` event carrying the objective (+ optional
// round cap); the HOST (CLI / protocol server / TUI) picks it up and drives
// rounds using the existing, battle-tested `runGoal` logic. This reuses the
// mature round loop instead of duplicating it inside the session control flow.
// If no host wires a handle (minimal embedders / tests), the tool degrades to a
// no-op acknowledgement and the model just continues normally.

import { z } from "zod";
import type { ToolDef } from "./types.js";

// Model-initiated goals get a wide cap so the loop can actually finish long
// work rather than stopping half-way (mirrors dsh's "wide cap + block-on-limit,
// not no-cap" design). The host may clamp this.
export const DEFAULT_MODEL_GOAL_ROUNDS = 100;

const schema = z.object({
  objective: z
    .string()
    .min(1)
    .describe(
      "The long-horizon objective, stated so it stays meaningful across many " +
        "rounds (e.g. 'migrate the auth module to the new token API and get all " +
        "tests green'). This is re-anchored every round, so make it self-contained.",
    ),
  maxRounds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional cap on driving rounds. Leave unset for the default. The loop " +
        "runs until you report completed/blocked or it hits this cap — the cap " +
        "is a safety bound, not a target; reaching it surfaces as a resumable " +
        "round-limit, not a silent stop.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "One short line on why this warrants a goal loop rather than a single turn.",
    ),
});

export interface StartGoalHandle {
  /** Host-wired: begin driving the goal loop for `objective`. Returns true if
   * the host accepted and will drive it. */
  (objective: string, maxRounds: number | undefined, reason: string | undefined): Promise<boolean>;
}

export interface StartGoalTool extends ToolDef<typeof schema> {
  /** Wired by the host to drive the loop (e.g. via runGoal on this session). */
  onStartGoal?: StartGoalHandle;
}

export const startGoalTool: StartGoalTool = {
  name: "start_goal",
  description:
    "Escalate the CURRENT task into a long-horizon goal loop: autonomous multi-round execution " +
    "that keeps driving until the objective is met, you report blocked, or a round cap is hit. Use " +
    "it when the task is genuinely large and multi-step — spanning many edits, verifications, and " +
    "rounds of work that will not fit a single turn — so it benefits from a plan + per-round " +
    "re-anchoring + checkpointing. Each round you re-read the plan, advance one step, VERIFY it, " +
    "and only emit `<goal_status>completed</goal_status>` once a verification has passed. Do NOT " +
    "use it for ordinary single-turn tasks, or just to 'keep going' — only at the start of a real " +
    "long-horizon objective. When unsure, don't call it.",
  inputSchema: schema,
  permission: "read",
  async execute(input, _ctx) {
    // Read from `this`: the session registers a per-session COPY with its own
    // `onStartGoal` wired, and the registry invokes `tool.execute(...)` so
    // `this` is that copy. (Reading the module singleton would miss the wiring.)
    const handle = (this as StartGoalTool).onStartGoal;
    if (!handle) {
      return {
        content:
          "start_goal is not available in this host; continue the task in the current turn.",
      };
    }
    const accepted = await handle(input.objective, input.maxRounds, input.reason);
    if (!accepted) {
      return {
        content:
          "The host did not start a goal loop; continue the task in the current turn.",
      };
    }
    return {
      content:
        `Goal loop requested for: ${input.objective}. The host will drive rounds until you emit ` +
        "<goal_status>completed</goal_status> or <goal_status>blocked</goal_status>. Follow the " +
        "goal protocol: plan, advance one step, verify, and only report completed after a verify passes.",
      blocks: [
        {
          type: "text",
          // The agent loop parses this into a `goal_request` event the host
          // consumes to start runGoal on this session.
          text: JSON.stringify({
            type: "goal_request",
            objective: input.objective,
            ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
          }),
        },
      ],
    };
  },
};
