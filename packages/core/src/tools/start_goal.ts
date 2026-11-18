// start_goal: let the model escalate the current task into a long-horizon
// goal loop (multi-round autonomous execution until met, blocked, or round
// cap). Model-invoked, not auto-detected. Emits a `goal_request` event;
// the host drives rounds via the existing runGoal loop. With no host
// handle wired, degrades to a no-op acknowledgement.

import { z } from "zod";
import type { ToolDef } from "./types.js";

/** Default round cap when the model omits `maxRounds`. Keep in sync with
 * `driveGoalRounds` (same value). Hosts may still clamp lower. */
export const DEFAULT_MODEL_GOAL_ROUNDS = 50;

const schema = z.object({
  objective: z
    .string()
    .min(1)
    .describe("Self-contained long-horizon objective (re-anchored every round)."),
  maxRounds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional round cap (default 50); safety bound, not a target."),
  reason: z.string().optional().describe("Why a goal loop (vs one turn / plan_update)."),
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
    "Start a host-driven multi-round goal loop (plan+verify each round). Default maxRounds: 50. " +
    "When to escalate vs `plan_update`: system Long-horizon goals section.",
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
    const accepted = await handle(
      input.objective,
      input.maxRounds ?? DEFAULT_MODEL_GOAL_ROUNDS,
      input.reason,
    );
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
