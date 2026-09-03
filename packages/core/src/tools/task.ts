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
    "Run a sub-agent in an isolated context to perform a focused task; return the conclusion to the main agent.",
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
