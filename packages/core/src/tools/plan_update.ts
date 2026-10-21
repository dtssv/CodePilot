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
    "skip for roughly the easiest ~25%. Each step: `{id, title, status}` where status is " +
    "pending|in_progress|completed|blocked. Update when status changes, in the SAME response " +
    "as that step's tool calls — never plan_update alone. Keep 3–8 active steps; put blockers " +
    "in the title. Verify steps must be checks you can actually run (no filler sanity checks).",
  inputSchema: schema,
  permission: "read",
  async execute(input) {
    const steps: PlanStep[] = input.steps.map((s) => ({
      id: s.id ?? `step_${randomUUID().slice(0, 8)}`,
      title: s.title,
      status: s.status,
    }));
    let content = `plan updated: ${steps.length} step(s)`;
    // Soft nudge only — never refuse. Prefer a real verify step over filler.
    const VERIFY_HINT =
      /verif|test|build|lint|check|e2e|regress|ci|typecheck|screenshot|visual|accept|browser|spike/i;
    if (
      steps.length >= 3 &&
      !steps.some((s) => VERIFY_HINT.test(s.title))
    ) {
      content +=
        `\n\n[reminder] Multi-step plans should include a verification step you can ` +
        `actually run (test/build/lint/browser/screenshot — not a fake sanity check) ` +
        `before marking the task done. Add one via plan_update when you next revise.`;
    }
    return {
      content,
      blocks: [
        { type: "text", text: JSON.stringify({ type: "plan", steps }) },
      ],
    };
  },
};
