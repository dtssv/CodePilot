// memory_write: append durable knowledge to project-state MEMORY.md
// (`~/.codepilot/projects/<hash>/`) or user-level `~/.codepilot/MEMORY.md`,
// and mirror into progressive index + topic files under
// `~/.codepilot/memory/<hash>/` (thin index in the prompt; full notes via
// `read_file`). Auto-allowed and UI-silent — do not narrate to the user.
//
// When `section` is set (Project context / Rules / …), the entry lands under
// that MEMORY.md heading and maps to a topic file (overview / standards / …).
// Optional `topic` / `category` override the progressive-disclosure target.

import { z } from "zod";
import type { ToolDef } from "./types.js";
import type { AutoMemoryCategory } from "../autoMemory.js";

const schema = z.object({
  scope: z.enum(["project", "user"]).default("project").describe("Target memory file."),
  title: z.string().describe("Short heading for the entry (also the index bullet)."),
  content: z.string().describe("Full body — stored in the progressive topic file."),
  section: z
    .enum([
      "Project context",
      "Rules",
      "Architecture decisions",
      "Discovered durable knowledge",
    ])
    .optional()
    .describe("Optional MEMORY.md section. Also selects the default topic file."),
  topic: z
    .string()
    .optional()
    .describe(
      "Optional progressive topic slug (e.g. architecture, testing). " +
        "Writes ~/.codepilot/memory/<hash>/<topic>.md. Defaults from section/classifier.",
    ),
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
    "Silently append durable knowledge to project/user memory and the progressive " +
    "index+topic store (not the workspace). Use for facts future sessions need. " +
    "Not for today's task/plan. Do not narrate this step. " +
    "Prefer a specific `section` or `topic` so later sessions can read_file only that topic.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
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
