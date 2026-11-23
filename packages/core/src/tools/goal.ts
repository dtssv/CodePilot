// `goal` tool: start a long-horizon goal loop (`action: "start"`) or report its
// terminal state (`action: "status"`).

import { z } from "zod";
import type { ToolDef, ToolResult } from "./types.js";

/** Default round cap when the model omits `maxRounds`. */
export const DEFAULT_MODEL_GOAL_ROUNDS = 50;

export type StartGoalHandle = (
  objective: string,
  maxRounds: number | undefined,
  reason: string | undefined,
) => Promise<boolean>;

const schema = z
  .object({
    action: z
      .enum(["start", "status"])
      .describe("`start` begins a goal loop; `status` ends the current one."),
    objective: z
      .string()
      .min(1)
      .optional()
      .describe("Self-contained long-horizon objective (required for action=start)."),
    maxRounds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional round cap when starting (default 50)."),
    reason: z
      .string()
      .optional()
      .describe("Why a goal loop (start), or what was achieved / blocked (status)."),
    status: z
      .enum(["completed", "blocked"])
      .optional()
      .describe("Terminal state when action=status."),
  })
  .superRefine((v, ctx) => {
    if (v.action === "start" && !v.objective) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "action=start requires `objective`",
        path: ["objective"],
      });
    }
    if (v.action === "status" && !v.status) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "action=status requires `status` (completed|blocked)",
        path: ["status"],
      });
    }
  });

export type GoalTool = ToolDef<typeof schema> & {
  onStartGoal?: StartGoalHandle;
};

export async function executeGoalStart(
  input: { objective: string; maxRounds?: number; reason?: string },
  onStartGoal: StartGoalHandle | undefined,
): Promise<ToolResult> {
  if (!onStartGoal) {
    return {
      content:
        "goal start is not available in this host; continue the task in the current turn.",
    };
  }
  const accepted = await onStartGoal(
    input.objective,
    input.maxRounds ?? DEFAULT_MODEL_GOAL_ROUNDS,
    input.reason,
  );
  if (!accepted) {
    return {
      content: "The host did not start a goal loop; continue the task in the current turn.",
    };
  }
  return {
    content:
      `Goal loop requested for: ${input.objective}. The host will drive rounds until you report ` +
      "status completed or blocked. Follow the goal protocol: plan, advance one step, verify, " +
      "and only report completed after a verify passes.",
    blocks: [
      {
        type: "text",
        text: JSON.stringify({
          type: "goal_request",
          objective: input.objective,
          ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        }),
      },
    ],
  };
}

export function executeGoalStatus(input: {
  status: "completed" | "blocked";
  reason?: string;
}): ToolResult {
  return {
    content:
      `Recorded goal status: ${input.status}` +
      (input.reason ? ` (${input.reason})` : "") +
      ". If a goal loop is driving this session it will stop this round; otherwise this is a no-op.",
    blocks: [
      {
        type: "text",
        text: JSON.stringify({
          type: "goal_status",
          status: input.status,
          ...(input.reason ? { reason: input.reason } : {}),
        }),
      },
    ],
  };
}

export const goalTool: GoalTool = {
  name: "goal",
  description:
    "`action: \"start\"` with `objective` (optional maxRounds/reason) begins a host-driven " +
    "multi-round plan+verify loop (default maxRounds: 50). " +
    "`action: \"status\"` with `status: completed|blocked` (optional reason) ends it — at most " +
    "once per round; no-op outside a goal loop. " +
    "When to escalate vs `plan`: system Long-horizon goals section.",
  inputSchema: schema,
  permission: "read",
  async execute(input) {
    if (input.action === "start") {
      return executeGoalStart(
        {
          objective: input.objective!,
          maxRounds: input.maxRounds,
          reason: input.reason,
        },
        (this as GoalTool).onStartGoal,
      );
    }
    return executeGoalStatus({ status: input.status!, reason: input.reason });
  },
};
