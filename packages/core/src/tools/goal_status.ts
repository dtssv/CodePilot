// goal_status: the structured, format-drift-proof channel for reporting the
// terminal state of a long-horizon goal loop, trusted ahead of the fragile
// text-marker scan. Emits a `goal_status` event the goal loop reads before
// falling back to the text markers (which stay supported). Outside a goal loop
// it is a harmless, explanatory no-op.

import { z } from "zod";
import type { ToolDef } from "./types.js";

const schema = z.object({
  status: z
    .enum(["completed", "blocked"])
    .describe(
      "The goal's terminal state. `completed`: the objective is fully satisfied " +
        "and a verification has passed. `blocked`: something outside this loop " +
        "must be resolved first (missing credentials, an external service, an " +
        "ambiguity only the user can settle).",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "One short sentence: for `completed`, what was achieved; for `blocked`, " +
        "the blocker. Surfaced in the goal result and the per-round checkpoint.",
    ),
});

export const goalStatusTool: ToolDef<typeof schema> = {
  name: "goal_status",
  description:
    "End the current goal loop: status `completed` (verified) or `blocked`. " +
    "At most once per round; no-op outside a goal loop.",
  inputSchema: schema,
  permission: "read",
  async execute(input, _ctx) {
    return {
      content:
        `Recorded goal_status: ${input.status}` +
        (input.reason ? ` (${input.reason})` : "") +
        ". If a goal loop is driving this session it will stop this round; otherwise this is a no-op.",
      blocks: [
        {
          type: "text",
          // The agent loop parses this into a `goal_status` event the goal loop
          // reads ahead of the text markers.
          text: JSON.stringify({
            type: "goal_status",
            status: input.status,
            ...(input.reason ? { reason: input.reason } : {}),
          }),
        },
      ],
    };
  },
};
