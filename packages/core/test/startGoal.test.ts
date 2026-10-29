// start_goal: model escalates the current task into a long-horizon goal loop.

import { describe, it, expect, vi } from "vitest";
import { startGoalTool } from "../src/tools/start_goal.js";
import type { ToolContext } from "../src/tools/types.js";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: "/w",
    artifact: async () => "a",
    readArtifact: async () => "",
    ...over,
  } as ToolContext;
}

/** Parse the goal_request block the agent loop consumes. */
function goalRequest(blocks: Array<{ type: string; text: string }> | undefined) {
  const b = blocks?.find((x) => x.type === "text");
  return b
    ? (JSON.parse(b.text) as { type: string; objective?: string; maxRounds?: number; reason?: string })
    : null;
}

describe("start_goal", () => {
  it("no host handle → degrades to a no-op ack, no goal_request block", async () => {
    const tool = { ...startGoalTool };
    tool.onStartGoal = undefined;
    const r = await tool.execute({ objective: "do a big thing" }, ctx());
    expect(r.content).toMatch(/not available/i);
    expect(r.blocks).toBeUndefined();
  });

  it("host accepts → emits a goal_request block with the objective", async () => {
    const onStartGoal = vi.fn(async () => true);
    const tool = { ...startGoalTool, onStartGoal };
    const r = await tool.execute({ objective: "migrate auth module" }, ctx());
    expect(onStartGoal).toHaveBeenCalledWith("migrate auth module", undefined, undefined);
    const gr = goalRequest(r.blocks);
    expect(gr?.type).toBe("goal_request");
    expect(gr?.objective).toBe("migrate auth module");
  });

  it("host declines → no goal_request block, model told to continue", async () => {
    const tool = { ...startGoalTool, onStartGoal: async () => false };
    const r = await tool.execute({ objective: "x" }, ctx());
    expect(r.blocks).toBeUndefined();
    expect(r.content).toMatch(/did not start|continue/i);
  });

  it("carries maxRounds and reason when provided", async () => {
    const tool = { ...startGoalTool, onStartGoal: async () => true };
    const r = await tool.execute(
      { objective: "big job", maxRounds: 30, reason: "many steps" },
      ctx(),
    );
    const gr = goalRequest(r.blocks);
    expect(gr?.maxRounds).toBe(30);
    expect(gr?.reason).toBe("many steps");
  });
});
