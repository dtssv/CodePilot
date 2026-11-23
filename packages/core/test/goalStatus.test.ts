// goal action=status: structured terminal-state channel for the goal loop.

import { describe, it, expect } from "vitest";
import { goalTool } from "../src/tools/goal.js";
import type { ToolContext } from "../src/tools/types.js";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: "/w",
    artifact: async () => "a",
    readArtifact: async () => "",
    ...over,
  } as ToolContext;
}

function parseBlock(blocks: Array<{ type: string; text: string }> | undefined) {
  const b = blocks?.find((x) => x.type === "text");
  return b ? (JSON.parse(b.text) as Record<string, unknown>) : null;
}

describe("goal action=status", () => {
  it("emits a goal_status block for completed", async () => {
    const r = await goalTool.execute(
      { action: "status", status: "completed", reason: "verified" },
      ctx(),
    );
    const gs = parseBlock(r.blocks);
    expect(gs?.type).toBe("goal_status");
    expect(gs?.status).toBe("completed");
    expect(gs?.reason).toBe("verified");
  });

  it("emits a goal_status block for blocked", async () => {
    const r = await goalTool.execute(
      { action: "status", status: "blocked", reason: "no creds" },
      ctx(),
    );
    const gs = parseBlock(r.blocks);
    expect(gs?.type).toBe("goal_status");
    expect(gs?.status).toBe("blocked");
  });

  it("works without a reason", async () => {
    const r = await goalTool.execute({ action: "status", status: "completed" }, ctx());
    expect(parseBlock(r.blocks)?.status).toBe("completed");
  });

  it("is read-tier", () => {
    expect(goalTool.permission).toBe("read");
  });
});
