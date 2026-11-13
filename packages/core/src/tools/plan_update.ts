// plan_update: maintain a structured plan (steps with status). The agent loop
// keeps the latest plan in the session state and persists it as `plan` events.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { PlanStep } from "../types.js";
import type { ToolDef } from "./types.js";

const stepSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]),
});

const schema = z.object({
  steps: z.array(stepSchema).describe("Replacement plan steps."),
});

export const planUpdateTool: ToolDef<typeof schema> = {
  name: "plan_update",
  description:
    "Replace the structured plan (survives compaction). Use for tasks with ≥3 real steps; " +
    "skip for roughly the easiest ~25%. Each step: `{id, title, status}` " +
    "(pending|in_progress|completed|blocked). Update when status changes, in the SAME response " +
    "as that step's tool calls — never plan_update alone. Keep 3–8 steps; put blockers in the title. " +
    "A high-quality step is concrete, independently checkable, and ordered on the last; any check it " +
    "claims must be one the project supports and the task calls for. Low-quality: a step whose check " +
    "does not test its claim (a syntax/parse pass standing in for a behaviour check), or a tight " +
    "edit→check→edit micro-loop as the main cadence. Do not plan a check you cannot perform — if you " +
    "cannot verify something, say so rather than adding a step that only pretends to.",
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
