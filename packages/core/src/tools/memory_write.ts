// memory_write: append a knowledge entry to either project-level CODEPILOT.md
// or user-level MEMORY.md. The session owns a memory sink; the tool calls it.

import { z } from "zod";
import type { ToolDef } from "./types.js";

const schema = z.object({
  scope: z.enum(["project", "user"]).default("project").describe("Target memory file."),
  title: z.string().describe("Short heading for the entry."),
  content: z.string().describe("Body content of the memory entry."),
});

export interface MemorySink {
  write(scope: "project" | "user", title: string, content: string): Promise<string>;
}

export const memoryWriteTool: ToolDef<typeof schema> & { sink?: MemorySink } = {
  name: "memory_write",
  description:
    "Append a knowledge entry to project (CODEPILOT.md) or user (~/.codepilot/MEMORY.md) memory.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    if (!this.sink) {
      return { content: "memory sink not configured for this session", isError: true };
    }
    try {
      const target = await this.sink.write(input.scope, input.title, input.content);
      return { content: `wrote memory entry to ${target}` };
    } catch (err) {
      return { content: `memory_write failed: ${(err as Error).message}`, isError: true };
    }
  },
};
