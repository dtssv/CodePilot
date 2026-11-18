// plan_update: maintain a structured plan (steps with status). The agent loop
// keeps the latest plan in the session state and persists it as `plan` events.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { PlanStep } from "../types.js";
import type { ToolDef } from "./types.js";

const stepSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});

const schema = z.object({
  steps: z.array(stepSchema).describe("Replacement plan steps."),
});

export const planUpdateTool: ToolDef<typeof schema> = {
  name: "plan_update",
  description:
    "Replace the structured plan (survives compaction). Steps: `{id?, title, status}` " +
    "pending|in_progress|completed — at most one in_progress; " +
    "`completed` when the deliverable exists (file or non-file outcome) and was verified if claimed; " +
    "omit steps you are no longer doing (do not keep abandoned work). " +
    "If stuck, ask the user — there is no blocked step status. " +
    "Titles name path + check when useful (not vague Investigate/Fix/Done). " +
    "When/how to plan: system Planning section; `start_goal` is the multi-round alternative.",
  inputSchema: schema,
  permission: "read",
  async execute(input) {
    const steps: PlanStep[] = input.steps.map((s) => ({
      id: s.id ?? `step_${randomUUID().slice(0, 8)}`,
      title: s.title,
      status: s.status,
    }));
    return {
      content: `plan updated: ${steps.length} step(s)`,
      blocks: [
        { type: "text", text: JSON.stringify({ type: "plan", steps }) },
      ],
    };
  },
};
