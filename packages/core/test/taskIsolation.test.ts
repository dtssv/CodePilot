import { describe, expect, it } from "vitest";

import {
  taskTool,
  type SubagentRunSpec,
  type Isolation,
  ISOLATION_MODES,
} from "../src/tools/task.js";

/** A mock runner that records the specs it receives (never actually runs). */
function makeMockRunner() {
  const specs: SubagentRunSpec[] = [];
  return {
    specs,
    runner: {
      async run(spec: SubagentRunSpec) {
        specs.push(spec);
        return { conclusion: `mock conclusion for ${spec.isolation ?? "none"}`, steps: 0 };
      },
    },
  };
}

const baseCtx = (cwd: string) => ({ cwd, subagentDepth: 0 });

describe("task tool — isolation field", () => {
  it("ISOLATION_MODES exposes none + worktree", () => {
    expect(ISOLATION_MODES).toEqual(["none", "worktree"]);
  });

  it("schema accepts isolation: 'worktree' in single-task mode", async () => {
    const mock = makeMockRunner();
    const tool = taskTool;
    tool.runner = mock.runner;
    tool._sem = undefined;
    const r = await tool.execute(
      { objective: "do thing", isolation: "worktree" } as never,
      baseCtx("/tmp") as never
    );
    expect(r.isError).toBeFalsy();
    expect(mock.specs).toHaveLength(1);
    expect(mock.specs[0]!.isolation).toBe<Isolation>("worktree");
  });

  it("schema accepts isolation per-task in fan-out mode", async () => {
    const mock = makeMockRunner();
    const tool = taskTool;
    tool.runner = mock.runner;
    tool._sem = undefined;
    const r = await tool.execute(
      {
        tasks: [
          { objective: "a", isolation: "worktree" },
          { objective: "b", isolation: "none" },
          { objective: "c" },
        ],
      } as never,
      baseCtx("/tmp") as never
    );
    expect(r.isError).toBeFalsy();
    expect(mock.specs).toHaveLength(3);
    expect(mock.specs[0]!.isolation).toBe("worktree");
    expect(mock.specs[1]!.isolation).toBe("none");
    expect(mock.specs[2]!.isolation).toBeUndefined();
  });

  it("schema rejects an invalid isolation value", () => {
    const safe = taskTool.inputSchema.safeParse({
      objective: "x",
      isolation: "bogus",
    });
    expect(safe.success).toBe(false);
  });

  it("defaults to undefined isolation when omitted", async () => {
    const mock = makeMockRunner();
    const tool = taskTool;
    tool.runner = mock.runner;
    tool._sem = undefined;
    await tool.execute({ objective: "x" } as never, baseCtx("/tmp") as never);
    expect(mock.specs[0]!.isolation).toBeUndefined();
  });

  it("isolation: 'none' is passed through explicitly", async () => {
    const mock = makeMockRunner();
    const tool = taskTool;
    tool.runner = mock.runner;
    tool._sem = undefined;
    await tool.execute(
      { objective: "x", isolation: "none" } as never,
      baseCtx("/tmp") as never
    );
    expect(mock.specs[0]!.isolation).toBe("none");
  });

  it("the spec's cwd is the parent cwd (worktree creation happens inside the runner)", async () => {
    const mock = makeMockRunner();
    const tool = taskTool;
    tool.runner = mock.runner;
    tool._sem = undefined;
    await tool.execute(
      { objective: "x", isolation: "worktree" } as never,
      { cwd: "/some/repo", subagentDepth: 0 } as never
    );
    expect(mock.specs[0]!.cwd).toBe("/some/repo");
  });

  it("the conclusion reflects the isolation mode used", async () => {
    const mock = makeMockRunner();
    const tool = taskTool;
    tool.runner = mock.runner;
    tool._sem = undefined;
    const r = await tool.execute(
      { objective: "x", isolation: "worktree" } as never,
      baseCtx("/tmp") as never
    );
    expect(r.content).toContain("worktree");
  });
});
