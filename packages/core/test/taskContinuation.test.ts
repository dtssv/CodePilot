// task tool: unique sub-agent ids/runSeq, and continuing an EXISTING
// sub-agent via continue_session_id instead of spawning a fresh one.

import { describe, expect, it } from "vitest";
import { taskTool, type SubagentRunSpec, type SubagentRunResult } from "../src/tools/task.js";
import type { Event } from "../src/types.js";

/** A mock runner that records specs and echoes back a stable sessionId. */
function makeMockRunner() {
  const specs: SubagentRunSpec[] = [];
  return {
    specs,
    runner: {
      async run(spec: SubagentRunSpec): Promise<SubagentRunResult> {
        specs.push(spec);
        return {
          conclusion: `conclusion for ${spec.objective}`,
          steps: 1,
          ok: true,
          // Mirror the task tool's assigned ownerId as the returned sessionId.
          sessionId: spec.ownerId ?? spec.resumeSessionId,
        };
      },
    },
  };
}

function ctxWith(events: Event[]) {
  return {
    cwd: "/tmp",
    subagentDepth: 0,
    toolCallId: "call_1",
    emitEvent: (e: Event) => {
      events.push(e);
    },
  };
}

describe("task tool — unique ids & runSeq", () => {
  it("assigns a stable sessionId and a monotonic runSeq per dispatch", async () => {
    const mock = makeMockRunner();
    const tool = taskTool;
    tool.runner = mock.runner;
    tool._sem = undefined;
    tool._spawned = 0;
    tool._runSeq = 0;

    const events: Event[] = [];
    const r1 = await tool.execute({ objective: "first" } as never, ctxWith(events) as never);
    const r2 = await tool.execute({ objective: "second" } as never, ctxWith(events) as never);

    // Both single-task dispatches have index 0, but distinct runSeq (1, 2)…
    const subEvents = events.filter((e) => e.type === "subagent") as Extract<Event, { type: "subagent" }>[];
    const seqs = [...new Set(subEvents.map((e) => e.runSeq))].sort();
    expect(seqs).toEqual([1, 2]); // not "all #1"
    // …and distinct, non-empty sessionIds.
    const ids = [...new Set(subEvents.map((e) => e.sessionId))];
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === "string" && id!.startsWith("sub_"))).toBe(true);

    // The returned content surfaces the session_id as the continuation handle.
    expect(r1.content).toMatch(/session_id: sub_/);
    expect(r1.content).toMatch(/continue_session_id/);
    expect(r2.content).toMatch(/session_id: sub_/);
  });
});

describe("task tool — continue an existing sub-agent", () => {
  it("passes resumeSessionId through so the runner continues the same run", async () => {
    const mock = makeMockRunner();
    const tool = taskTool;
    tool.runner = mock.runner;
    tool._sem = undefined;
    tool._spawned = 0;
    tool._runSeq = 0;

    const events: Event[] = [];
    // Fresh dispatch → get a session id.
    await tool.execute({ objective: "do step 1" } as never, ctxWith(events) as never);
    const firstId = (events.find((e) => e.type === "subagent") as Extract<Event, { type: "subagent" }>).sessionId!;
    expect(firstId).toMatch(/^sub_/);

    // Continue the SAME sub-agent with a follow-up.
    mock.specs.length = 0;
    await tool.execute(
      { objective: "now do step 2", continue_session_id: firstId } as never,
      ctxWith(events) as never,
    );

    expect(mock.specs).toHaveLength(1);
    // The runner received the resume id and the follow-up objective, and the
    // tool used that same id as the owner (not a fresh one).
    expect(mock.specs[0]!.resumeSessionId).toBe(firstId);
    expect(mock.specs[0]!.ownerId).toBe(firstId);
    expect(mock.specs[0]!.objective).toBe("now do step 2");
  });
});
