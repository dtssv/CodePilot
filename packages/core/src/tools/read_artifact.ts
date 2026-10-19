// read_artifact: load the full content of an artifact previously written via
// the artifact spill mechanism (referenced by `art_<hash>`).

import { z } from "zod";
import type { ToolDef } from "./types.js";

const schema = z.object({
  ref: z.string().describe("Artifact reference (e.g. \"art_<hash>\")."),
  startLine: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("0-based line offset."),
  maxLines: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .optional()
    .describe("Max lines to return (default 5000)."),
});

export const readArtifactTool: ToolDef<typeof schema> = {
  name: "read_artifact",
  description:
    "Read a large tool result that spilled to an artifact (bash output >8KB, a big file, a web " +
    "page). The original result keeps the head plus an `art_<hash>` ref; pass that ref here and " +
    "use `startLine`/`maxLines` to read just the window you need. Artifacts are session-scoped — " +
    "if a ref is gone, re-run the tool that produced it.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    try {
      const text = await ctx.readArtifact(input.ref);
      const lines = text.split(/\r?\n/);
      const start = input.startLine ?? 0;
      const max = input.maxLines ?? 5000;
      const slice = lines.slice(start, start + max).join("\n");
      return {
        content:
          lines.length > start + max
            ? `${slice}\n\n[...truncated, ${lines.length - (start + max)} more lines]`
            : slice,
      };
    } catch (err) {
      return { content: `read_artifact failed: ${(err as Error).message}`, isError: true };
    }
  },
};
