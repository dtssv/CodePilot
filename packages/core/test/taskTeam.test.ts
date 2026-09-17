// `task` tool team mode (ROADMAP-NEXT §4.2): schema, mode exclusivity, and
// the wiring from ToolContext.emitEvent to team_message events.

import { describe, expect, it } from "vitest";

import { taskTool, type SubagentRunSpec } from "../src/tools/task.js";
import type { Event } from "../src/types.js";

function mockRunner(conclusions: Array<{ match: RegExp; text: string }> = []) {
  const specs: SubagentRunSpec[] = [];
  return {
    specs,
    runner: {
      async run(spec: SubagentRunSpec) {
        specs.push(spec);
        for (const c of conclusions) {
          if (c.match.test(spec.objective)) return { conclusion: c.text, steps: 1 };
        }
        return { conclusion: `did: ${spec.objective}`, steps: 1 };
      },
    },
  };
}

function ctx(extra: Record<string, unknown> = {}) {
  return { cwd: "/tmp", subagentDepth: 0, ...extra } as never;
}

describe("task tool — team mode", () => {
  it("runs a team and returns the merged report", async () => {
    const mock = mockRunner();
    taskTool.runner = mock.runner;
    taskTool._sem = undefined;
    const events: Event[] = [];
    const r = await taskTool.execute(
      {
        objective: "migrate the config loader",
        team: [
          { role: "worker", name: "fe", objective: "update the callers" },
          { role: "specialist", name: "sec", objective: "audit the new parser" },
        ],
      } as never,
      ctx({ emitEvent: (e: Event) => void events.push(e) }),
    );

    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Team finished: 2\/2 members succeeded/);
    expect(r.content).toMatch(/update the callers/);
    expect(r.content).toMatch(/audit the new parser/);
    // Members run one level deeper than the caller.
    expect(mock.specs.every((s) => s.depth === 1)).toBe(true);
    // Team traffic reached the host as team_message events.
    const team = events.filter((e) => e.type === "team_message");
    expect(team.length).toBeGreaterThanOrEqual(3);
  });

  it("works without an emitEvent channel", async () => {
    const mock = mockRunner();
    taskTool.runner = mock.runner;
    taskTool._sem = undefined;
    const r = await taskTool.execute(
      {
        objective: "g",
        team: [{ role: "worker", objective: "work" }],
      } as never,
      ctx(),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/1\/1 members succeeded/);
  });

  it("reports an invalid team as a tool error rather than throwing", async () => {
    const mock = mockRunner();
    taskTool.runner = mock.runner;
    taskTool._sem = undefined;
    const r = await taskTool.execute(
      { objective: "g", team: [{ role: "leader" }] } as never,
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/team run failed: invalid team: team has only a leader/);
    expect(mock.specs).toHaveLength(0);
  });

  it("rejects combining team with tasks or csv", () => {
    const parse = (v: unknown) => taskTool.inputSchema.safeParse(v);
    expect(parse({ objective: "g", team: [{ role: "worker", objective: "w" }] }).success).toBe(true);
    expect(
      parse({ team: [{ role: "worker", objective: "w" }], tasks: [{ objective: "x" }] }).success,
    ).toBe(false);
    expect(parse({ team: [{ role: "worker", objective: "w" }], csv: "a,b" }).success).toBe(false);
    // Team mode without an objective is allowed when members carry their own.
    expect(parse({ team: [{ role: "worker", objective: "w" }] }).success).toBe(true);
  });

  it("validates roles and merge strategies", () => {
    const parse = (v: unknown) => taskTool.inputSchema.safeParse(v);
    expect(parse({ objective: "g", team: [{ role: "boss" }] }).success).toBe(false);
    expect(
      parse({
        objective: "g",
        team: [{ role: "worker", objective: "w" }],
        merge_strategy: "mind_meld",
      }).success,
    ).toBe(false);
    expect(
      parse({
        objective: "g",
        team: [{ role: "worker", objective: "w" }],
        merge_strategy: "voting",
        shared_worktree: true,
      }).success,
    ).toBe(true);
  });

  it("still honours the depth guard in team mode", async () => {
    const mock = mockRunner();
    taskTool.runner = mock.runner;
    taskTool._sem = undefined;
    taskTool.maxDepth = 2;
    const r = await taskTool.execute(
      { objective: "g", team: [{ role: "worker", objective: "w" }] } as never,
      ctx({ subagentDepth: 2 }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/would exceed the max/);
    expect(mock.specs).toHaveLength(0);
  });
});
