// `plan` tool: maintain the structured plan (`action: "update"`) or submit it
// for approval (`action: "done"`).

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { PlanStep } from "../types.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

const stepSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});

/**
 * `action` stays **required** in the JSON schema (so models are nudged to
 * send it). A preprocess fills `action: "update"` when omitted — legacy
 * `plan_update`-shaped calls `{ steps: [...] }` still validate. Do not use
 * Zod `.default()` here: zod-to-json-schema then drops `action` from
 * `required`, and models keep omitting it.
 */
const schema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const o = { ...(raw as Record<string, unknown>) };
    if (o.action == null || o.action === "") o.action = "update";
    return o;
  },
  z
    .object({
      action: z
        .enum(["update", "done"])
        .describe(
          'Required. `"update"` replaces plan steps; `"done"` submits for approval.',
        ),
      steps: z
        .array(stepSchema)
        .optional()
        .describe("Replacement plan steps (required for action=update)."),
      summary: z
        .string()
        .optional()
        .describe("One-paragraph summary when submitting for approval (action=done)."),
    })
    .superRefine((v, ctx) => {
      if (v.action === "update" && (!v.steps || v.steps.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "action=update requires a non-empty `steps` array",
          path: ["steps"],
        });
      }
      // At most one in_progress unless parallel is explicitly allowed.
      if (v.action === "update" && v.steps) {
        const active = v.steps.filter((s) => s.status === "in_progress").length;
        if (active > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `at most one step may be in_progress (got ${active})`,
            path: ["steps"],
          });
        }
      }
    }),
);

export type PlanToolWiring = {
  writePlan?: (summary: string | undefined, steps: PlanStep[]) => Promise<string>;
  currentPlan?: () => PlanStep[] | undefined;
};

export function executePlanUpdate(stepsIn: z.infer<typeof stepSchema>[]): ToolResult {
  const steps: PlanStep[] = stepsIn.map((s) => ({
    id: s.id ?? `step_${randomUUID().slice(0, 8)}`,
    title: s.title,
    status: s.status,
  }));
  return {
    content: `plan updated: ${steps.length} step(s)`,
    blocks: [{ type: "text", text: JSON.stringify({ type: "plan", steps }) }],
  };
}

export async function executePlanDone(
  input: { summary?: string },
  ctx: ToolContext,
  wiring: PlanToolWiring,
): Promise<ToolResult> {
  if (!ctx.askUser) {
    const steps = wiring.currentPlan?.() ?? [];
    const unfinished = steps.filter((s) => s.status !== "completed");
    if (unfinished.length > 0) {
      return {
        content:
          `plan_done refused (headless): ${unfinished.length} step(s) still ` +
          `pending/in_progress — mark each completed, or drop abandoned steps from the next plan update, before done.`,
        isError: true,
      };
    }
  }
  let planPath: string | undefined;
  if (wiring.writePlan && wiring.currentPlan) {
    try {
      const steps = wiring.currentPlan() ?? [];
      planPath = await wiring.writePlan(input.summary, steps);
    } catch {
      /* best-effort — approval flow still works without the file */
    }
  }
  if (!ctx.askUser) {
    return {
      content: `plan approved (headless session: auto-approved)${planPath ? ` — written to ${planPath}` : ""}`,
      blocks: [
        {
          type: "text",
          text: JSON.stringify({
            type: "exit_plan_mode",
            approved: true,
            summary: input.summary ?? "",
            planPath,
          }),
        },
      ],
    };
  }
  const answers = await ctx.askUser({
    requestId: `q_${Math.random().toString(36).slice(2, 10)}`,
    questions: [
      {
        id: "approve",
        header: "Plan approval",
        question:
          (input.summary ? input.summary + "\n\n" : "") +
          `Approve this plan and switch to agent mode?${planPath ? `\n\n_Plan written to \`${planPath}\` — open it to review in full._` : ""}`,
        options: [
          { label: "Approve", description: "Switch to agent mode and execute the plan." },
          { label: "Revise", description: "Stay in plan mode; give feedback to revise." },
        ],
      },
    ],
  });
  const raw = answers["approve"];
  const answer = Array.isArray(raw) ? raw[0] : raw;
  const approved = answer === "Approve";
  return {
    content: approved
      ? `plan approved by user — you are now in agent mode, begin executing.${planPath ? ` Plan file: ${planPath}` : ""}`
      : `plan NOT approved. Feedback: ${answer ?? "(none)"}. Revise and resubmit.`,
    blocks: [
      {
        type: "text",
        text: JSON.stringify({
          type: "exit_plan_mode",
          approved,
          summary: input.summary ?? "",
          planPath,
        }),
      },
    ],
  };
}

export type PlanTool = ToolDef<typeof schema> & PlanToolWiring;

export const planTool: PlanTool = {
  name: "plan",
  description:
    "Update or submit the structured plan. " +
    "Example update: `{ \"action\": \"update\", \"steps\": [{ \"title\": \"…\", \"status\": \"in_progress\" }] }`. " +
    "`action` is required (`update` | `done`) — never send `steps` alone. " +
    "`update` replaces the plan with `steps:[{id?, title, status}]` — pending|in_progress|completed; " +
    "at most one in_progress (enforced); `completed` when the deliverable exists (file or non-file outcome) and was verified if claimed; " +
    "omit steps you are no longer doing. Headless `done` requires all remaining steps completed. " +
    "Titles name path + check when useful. " +
    "`done` submits for approval (writes under plans/; approve → agent mode). " +
    "When/how to plan: system Planning section; `goal` is the multi-round alternative.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    if (input.action === "update") {
      return executePlanUpdate(input.steps!);
    }
    return executePlanDone({ summary: input.summary }, ctx, this as PlanTool);
  },
};
