// ask_user_question / plan_done: structured user interaction tools.
//
// ask_user_question (claude-code AskUserQuestion equivalent): the model
// poses one or more structured questions; the host UI renders them and
// returns an answers map. Requires a host `onAskUser` handler — headless
// sessions get an explicit error telling the model to proceed with the
// most reasonable default instead.
//
// plan_done (claude-code ExitPlanMode equivalent): plan-mode exit ramp.
// The model calls it when the plan is ready; the host is asked to approve;
// on approval the session emits a `mode_request` event which the Session
// turns into a switch to agent mode. The plan is also written to
// `.codepilot/plans/<slug>.md` (claude-code style) so it survives as a
// reviewable artifact.

import { z } from "zod";
import type { ToolDef } from "./types.js";
import type { PlanStep } from "../types.js";

const questionSchema = z.object({
  id: z.string().min(1).describe("Stable id echoed in the answers map."),
  header: z.string().optional().describe("Short heading, e.g. \"Confirm\"."),
  question: z.string().min(1).describe("The question to ask the user."),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string().optional(),
      })
    )
    .optional()
    .describe("Optional choices; omit for a free-text answer."),
  multi_select: z
    .boolean()
    .optional()
    .describe("Allow selecting multiple options (default false)."),
});

const askSchema = z.object({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(4)
    .describe("1-4 questions, asked together in one prompt."),
});

export const askUserQuestionTool: ToolDef<typeof askSchema> = {
  name: "ask_user_question",
  description:
    "Ask the user one or more structured questions and wait for the answers. Use " +
    "when a decision genuinely changes your plan (scope choices, destructive " +
    "confirmations, ambiguous requirements) — not for things you can decide from " +
    "the codebase. Ask at most a few questions at once; each may carry multiple " +
    "choice options (put the recommended option first, labelled \"(Recommended)\"). " +
    "In headless sessions this tool errors: proceed with the most reasonable " +
    "default and note the assumption in your final message.",
  inputSchema: askSchema,
  permission: "read",
  async execute(input, ctx) {
    if (!ctx.askUser) {
      return {
        content:
          "no interactive user channel in this session. Proceed with the most " +
          "reasonable default and document the assumption.",
        isError: true,
      };
    }
    const answers = await ctx.askUser({
      requestId: `q_${Math.random().toString(36).slice(2, 10)}`,
      questions: input.questions.map((q) => ({
        id: q.id,
        header: q.header,
        question: q.question,
        options: q.options,
        multiSelect: q.multi_select,
      })),
    });
    const lines = input.questions.map((q) => {
      const a = answers[q.id];
      const rendered = Array.isArray(a) ? a.join(", ") : (a ?? "(no answer)");
      return `${q.id}: ${rendered}`;
    });
    return { content: `User answers:\n${lines.join("\n")}` };
  },
};

const planDoneSchema = z.object({
  summary: z
    .string()
    .optional()
    .describe("One-paragraph summary of the plan being submitted for approval."),
});

export const planDoneTool: ToolDef<typeof planDoneSchema> & {
  /** Optional: a function the host wires up so plan_done can persist the
   *  plan to `.codepilot/plans/` before asking for approval. Receives the
   *  summary + the current plan steps. Returns the path of the written file. */
  writePlan?: (summary: string | undefined, steps: PlanStep[]) => Promise<string>;
  /** Optional: current plan steps, injected by the session so plan_done
   *  can write them to disk without needing a separate tool call. */
  currentPlan?: () => PlanStep[] | undefined;
} = {
  name: "plan_done",
  description:
    "Submit the current plan for user approval and exit plan mode. Call this ONLY " +
    "when the plan is complete and you are confident in it. The plan is written to " +
    "`.codepilot/plans/<slug>.md` so it survives as a reviewable artifact; the user " +
    "is shown the plan plus the optional `summary`; on approval the session switches " +
    "to agent mode and you may begin executing. On rejection you stay in plan mode — " +
    "revise the plan with the feedback and submit again. Don't call this before the " +
    "plan is actually ready.",
  inputSchema: planDoneSchema,
  permission: "read",
  async execute(input, ctx) {
    // Persist the plan to disk first (claude-code writes before exit too).
    let planPath: string | undefined;
    if (this.writePlan && this.currentPlan) {
      try {
        const steps = this.currentPlan() ?? [];
        planPath = await this.writePlan(input.summary, steps);
      } catch {
        /* best-effort — approval flow still works without the file */
      }
    }
    if (!ctx.askUser) {
      // Headless: treat as approved so automated plan→agent flows work.
      return {
        content: `plan approved (headless session: auto-approved)${planPath ? ` — written to ${planPath}` : ""}`,
        blocks: [
          {
            type: "text",
            text: JSON.stringify({ type: "exit_plan_mode", approved: true, summary: input.summary ?? "", planPath }),
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
          text: JSON.stringify({ type: "exit_plan_mode", approved, summary: input.summary ?? "", planPath }),
        },
      ],
    };
  },
};
