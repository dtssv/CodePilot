// ask_user_question: structured Q&A the host renders and answers; headless
// sessions error out so the model falls back to a reasonable default.

import { z } from "zod";
import type { ToolDef } from "./types.js";

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
    "Ask 1–4 structured questions (preference / authorization / acceptance). " +
    "When to ask vs explore: system Tool-Use Policy. Headless: pick a default and note it.",
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
 // Restate each question next to its answer: a bare `id: answer` loses the
 // link to what was asked once the call args scroll out of focus.
    const lines = input.questions.map((q) => {
      const a = answers[q.id];
      const rendered = Array.isArray(a) ? a.join(", ") : (a ?? "(no answer)");
      return `Q (${q.id}): ${q.question}\nA: ${rendered}`;
    });
 // Plain facts only. Behavioural notes here ("do not ask again") get
 // paraphrased back to the user ("已记录，无需再次提问") and show up in the
 // tool's rendered output; the tool description already covers re-asking.
    const allDeclined = input.questions.every((q) => {
      const a = answers[q.id];
      const v = Array.isArray(a) ? a.join("") : (a ?? "");
      return v === "" || /^\(no answer\)$|停止提问|^stop$/i.test(v.trim());
    });
    return {
      content: allDeclined
        ? `The user did not pick an answer:\n${lines.join("\n")}`
        : `User answers:\n${lines.join("\n")}`,
    };
  },
};
