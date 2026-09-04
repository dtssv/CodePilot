// memory_write: append a knowledge entry to either project-level CODEPILOT.md
// or user-level MEMORY.md. The session owns a memory sink; the tool calls it.
//
// When the `section` argument is provided (one of "Project context",
// "Rules", "Architecture decisions", "Discovered durable knowledge"), the
// entry is placed under the matching `## <section>` heading. Without it,
// the sink uses a best-effort classifier on the title + content to pick a
// target section.

import { z } from "zod";
import type { ToolDef } from "./types.js";

const schema = z.object({
  scope: z.enum(["project", "user"]).default("project").describe("Target memory file."),
  title: z.string().describe("Short heading for the entry."),
  content: z.string().describe("Body content of the memory entry."),
  section: z
    .enum([
      "Project context",
      "Rules",
      "Architecture decisions",
      "Discovered durable knowledge",
    ])
    .optional()
    .describe("Optional canonical section to write under. If omitted, a classifier picks one."),
});

export interface MemorySink {
  write(
    scope: "project" | "user",
    title: string,
    content: string,
    section?: string
  ): Promise<string>;
}

export const memoryWriteTool: ToolDef<typeof schema> & { sink?: MemorySink } = {
  name: "memory_write",
  description:
    "Append a knowledge entry to project (CODEPILOT.md) or user (~/.codepilot/MEMORY.md) memory. " +
    "Pass `section` to target one of the canonical sections (Project context / Rules / " +
    "Architecture decisions / Discovered durable knowledge); otherwise the sink picks one " +
    "based on the title and content.",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    if (!this.sink) {
      return { content: "memory sink not configured for this session", isError: true };
    }
    try {
      const target = await this.sink.write(
        input.scope,
        input.title,
        input.content,
        input.section
      );
      const sectionNote = input.section ? ` (section: ${input.section})` : "";
      return { content: `wrote memory entry to ${target}${sectionNote}` };
    } catch (err) {
      return { content: `memory_write failed: ${(err as Error).message}`, isError: true };
    }
  },
};
