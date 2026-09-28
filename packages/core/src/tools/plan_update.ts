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
    "Replace the current plan with a fresh list of steps. Use this to keep a structured " +
    "todo list visible to the user AND protected from context compaction (plan events " +
    "are always retained verbatim). For any task with >= 3 steps, call this at the start " +
    "to declare the plan, then call it again whenever a step's status changes (mark " +
    "`completed`, set the next one `in_progress`, or surface a `blocked` step). " +
    "Each step is an OBJECT with fields: `id` (stable short string, reuse across updates), " +
    "`title` (one line, what the deliverable is), and `status` (one of " +
    "\"pending\", \"in_progress\", \"completed\", \"blocked\"). " +
    "Aim for 3-8 active steps; collapse clusters of completed steps rather than letting the " +
    "list grow unbounded. If you mark a step `blocked`, say so in its title so the user sees " +
    "the blocker without opening a tool result.\n\n" +
    "Example input:\n" +
    '```json\n' +
    '{\n' +
    '  "steps": [\n' +
    '    {"id": "1", "title": "Read README and package.json", "status": "in_progress"},\n' +
    '    {"id": "2", "title": "Analyze packages/core architecture", "status": "pending"},\n' +
    '    {"id": "3", "title": "Summarize design", "status": "pending"}\n' +
    '  ]\n' +
    '}\n' +
    '```\n' +
    "Do NOT pass strings in the steps array — each element MUST be an object.",
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
