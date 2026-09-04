// task: dispatch a sub-task to a sub-agent. The sub-agent gets a fresh context
// (does not see the parent's history) and returns only the final conclusion.
// This is the same idea as Claude Code's Task tool.

import { z } from "zod";
import type { Event } from "../types.js";
import type { ToolDef } from "./types.js";

const schema = z.object({
  objective: z.string().describe("Clear, self-contained objective for the sub-agent."),
  tools: z
    .array(z.string())
    .optional()
    .describe("Restrict to a subset of tool names (default: read-only + grep/glob/ls)."),
  model: z
    .string()
    .optional()
    .describe("Override the model (default: smallModel)."),
  maxSteps: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Maximum tool steps for the sub-agent (default 15)."),
});

export interface SubagentRunner {
  run(opts: {
    objective: string;
    cwd: string;
    tools?: string[];
    model?: string;
    maxSteps?: number;
    onEvent?: (e: Event) => void;
  }): Promise<{ conclusion: string; steps: number }>;
}

export const taskTool: ToolDef<typeof schema> & { runner?: SubagentRunner } = {
  name: "task",
  description:
    "Dispatch a focused task to a sub-agent in an isolated context. The sub-agent does not " +
    "see your history and you do not see its intermediate steps — only its final conclusion " +
    "comes back. Use it for parallelisable exploration that would otherwise clutter your own " +
    "context: codebase searches, 'what does this module do', 'find every callsite of X', " +
    "'summarise this file'. Do NOT use it for a single `read_file` or one-line `grep` — that " +
    "is cheaper to do directly. Do NOT use it to delegate serial work you could do yourself. " +
    "Pass `tools` to widen the sub-agent's tool set beyond the read-only default; the sub-agent " +
    "still cannot spawn further sub-agents. Write the `objective` so a fresh agent can act on " +
    "it without further context (state the goal, the files of interest, and what to return). " +
    "The sub-agent's conclusion must follow the structured `### Findings / ### Key " +
    "references / ### Recommendations` format described in its system prompt.",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    if (!this.runner) {
      return { content: "subagent runner not configured for this session", isError: true };
    }
    try {
      const result = await this.runner.run({
        objective: input.objective,
        cwd: ctx.cwd,
        tools: input.tools,
        model: input.model,
        maxSteps: input.maxSteps,
      });
      return {
        content:
          `sub-agent completed in ${result.steps} step(s). Conclusion:\n\n${result.conclusion}`,
      };
    } catch (err) {
      return { content: `sub-agent failed: ${(err as Error).message}`, isError: true };
    }
  },
};
