// memory_write: append durable knowledge to project-state MEMORY.md
// or user-level MEMORY.md, mirroring into progressive notes/ (capped inbox).
// Call only when the user explicitly asked to remember this turn;
// permission engine asks before every write (see memory.agentWrite).

import { z } from "zod";
import type { ToolDef } from "./types.js";
import type { AutoMemoryCategory } from "../memory/autoMemory.js";

const schema = z.object({
  scope: z.enum(["project", "user"]).default("project").describe("Target memory file."),
  title: z.string().describe("Short heading for the entry (also the index bullet hook, ≤~150 chars)."),
  content: z.string().describe("Full body — stored under progressive memory notes/."),
  section: z
    .enum([
      "Project context",
      "Rules",
      "Architecture decisions",
      "Discovered durable knowledge",
    ])
    .optional()
    .describe("Optional MEMORY.md section. Also selects the default taxonomy tag."),
  topic: z
    .string()
    .optional()
    .describe("Taxonomy hint (overview|architecture|standards|knowledge|user|feedback|reference)."),
  category: z
    .enum(["user", "feedback", "project", "reference"])
    .optional()
    .describe("Optional index tag for the progressive memory bullet."),
});

export interface MemoryWriteOpts {
  topic?: string;
  category?: AutoMemoryCategory;
}

export interface MemorySink {
  write(
    scope: "project" | "user",
    title: string,
    content: string,
    section?: string,
    opts?: MemoryWriteOpts,
  ): Promise<string>;
}

export const memoryWriteTool: ToolDef<typeof schema> & { sink?: MemorySink } = {
  name: "memory_write",
  description:
    "Append one durable memory note (`section`/`topic`, short title). Default `scope=project`; " +
    "`scope=user` only for lasting cross-repo preferences. When to write: system Memory section; " +
    "writes ask for confirmation unless yolo.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    void ctx;
    if (!this.sink) {
      return { content: "memory sink not configured for this session", isError: true };
    }
    try {
      const target = await this.sink.write(
        input.scope,
        input.title,
        input.content,
        input.section,
        { topic: input.topic, category: input.category },
      );
      const bits = [
        input.section ? `section=${input.section}` : null,
        input.topic ? `topic=${input.topic}` : null,
      ].filter(Boolean);
      const note = bits.length ? ` (${bits.join(", ")})` : "";
      return { content: `wrote memory entry to ${target}${note}` };
    } catch (err) {
      return { content: `memory_write failed: ${(err as Error).message}`, isError: true };
    }
  },
};
