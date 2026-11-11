// goal_status: structured, format-drift-proof channel for reporting a goal
// loop's terminal state. The tool emits a `goal_status` block the agent loop
// parses; the goal loop trusts it ahead of the text markers.

import { describe, it, expect } from "vitest";
import { goalStatusTool } from "../src/tools/goal_status.js";
import type { ToolContext } from "../src/tools/types.js";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: "/w",
    artifact: async () => "a",
    readArtifact: async () => "",
    ...over,
  } as ToolContext;
}

/** Parse the goal_status block the agent loop consumes. */
function goalStatus(blocks: Array<{ type: string; text: string }> | undefined) {
  const b = blocks?.find((x) => x.type === "text");
  return b
    ? (JSON.parse(b.text) as { type: string; status?: string; reason?: string })
    : null;
}

describe("goal_status tool", () => {
  it("emits a completed goal_status block with the reason", async () => {
    const r = await goalStatusTool.execute(
      { status: "completed", reason: "all tests pass" },
      ctx(),
    );
    const gs = goalStatus(r.blocks);
    expect(gs?.type).toBe("goal_status");
    expect(gs?.status).toBe("completed");
    expect(gs?.reason).toBe("all tests pass");
    expect(r.content).toMatch(/completed/);
  });

  it("emits a blocked goal_status block", async () => {
    const r = await goalStatusTool.execute({ status: "blocked", reason: "no creds" }, ctx());
    const gs = goalStatus(r.blocks);
    expect(gs?.status).toBe("blocked");
    expect(gs?.reason).toBe("no creds");
  });

  it("omits reason when not provided", async () => {
    const r = await goalStatusTool.execute({ status: "completed" }, ctx());
    const gs = goalStatus(r.blocks);
    expect(gs?.status).toBe("completed");
    expect(gs?.reason).toBeUndefined();
  });

  it("is read-tier (no file side effects)", () => {
    expect(goalStatusTool.permission).toBe("read");
  });
});
