// Unified plan / goal / task control actions.

import { describe, it, expect, vi } from "vitest";
import { planTool } from "../src/tools/plan.js";
import { goalTool } from "../src/tools/goal.js";
import { taskTool } from "../src/tools/task.js";
import { BackgroundSubagentRegistry } from "../src/tools/index.js";
import type { ToolContext } from "../src/tools/types.js";
import { DIRECT_WIRE_TOOLS } from "../src/tools/wirePolicy.js";

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

describe("plan", () => {
  it("action=update emits a plan block", async () => {
    const r = await planTool.execute(
      {
        action: "update",
        steps: [{ title: "do thing", status: "in_progress" }],
      },
      ctx(),
    );
    const block = parseBlock(r.blocks);
    expect(block?.type).toBe("plan");
    expect(Array.isArray(block?.steps)).toBe(true);
    expect(r.content).toMatch(/plan updated/);
  });

  it("rejects more than one in_progress step", () => {
    const parsed = planTool.inputSchema.safeParse({
      action: "update",
      steps: [
        { title: "a", status: "in_progress" },
        { title: "b", status: "in_progress" },
      ],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.message).toMatch(/at most one.*in_progress/i);
    }
  });

  it("action=done headless auto-approves with exit_plan_mode", async () => {
    const tool = { ...planTool };
    const r = await tool.execute({ action: "done", summary: "ship it" }, ctx());
    const block = parseBlock(r.blocks);
    expect(block?.type).toBe("exit_plan_mode");
    expect(block?.approved).toBe(true);
  });
});

describe("goal", () => {
  it("action=start emits goal_request when host accepts", async () => {
    const onStartGoal = vi.fn(async () => true);
    const tool = { ...goalTool, onStartGoal };
    const r = await tool.execute(
      { action: "start", objective: "migrate auth", maxRounds: 20 },
      ctx(),
    );
    expect(onStartGoal).toHaveBeenCalledWith("migrate auth", 20, undefined);
    const block = parseBlock(r.blocks);
    expect(block?.type).toBe("goal_request");
    expect(block?.objective).toBe("migrate auth");
  });

  it("action=status emits goal_status", async () => {
    const r = await goalTool.execute(
      { action: "status", status: "completed", reason: "done" },
      ctx(),
    );
    const block = parseBlock(r.blocks);
    expect(block?.type).toBe("goal_status");
    expect(block?.status).toBe("completed");
  });
});

describe("task control actions", () => {
  it("action=list uses the background registry", async () => {
    const reg = new BackgroundSubagentRegistry();
    const tool = { ...taskTool, backgroundRegistry: reg };
    const r = await tool.execute({ action: "list" }, ctx());
    expect(r.content).toMatch(/No background sub-agents/i);
  });

  it("action=wait without session_id fails schema", () => {
    const parsed = taskTool.inputSchema.safeParse({ action: "wait" });
    expect(parsed.success).toBe(false);
  });
});

describe("direct wire", () => {
  it("wires plan and goal", () => {
    expect(DIRECT_WIRE_TOOLS.has("plan")).toBe(true);
    expect(DIRECT_WIRE_TOOLS.has("goal")).toBe(true);
  });
});
