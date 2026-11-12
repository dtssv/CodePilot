// task tool `run: "background"`: dispatch a sub-agent detached, return a handle
// immediately, and deliver a one-time completion through the registry. Plus the
// control tools (subagent_list / wait / interrupt) and the per-session registry.

import { describe, expect, it } from "vitest";
import { taskTool, type SubagentRunSpec, type SubagentRunResult } from "../src/tools/task.js";
import {
  makeSubagentListTool,
  makeSubagentWaitTool,
  makeSubagentInterruptTool,
} from "../src/tools/subagentControl.js";
import { BackgroundSubagentRegistry } from "../src/tools/subagentJobs.js";
import type { Event } from "../src/types.js";

/** A runner whose run() resolves only when the test calls the captured resolver,
 * so we can assert the task tool returns BEFORE the sub-agent finishes. */
function makeDeferredRunner() {
  const specs: SubagentRunSpec[] = [];
  let resolveRun!: (r: SubagentRunResult) => void;
  const gate = new Promise<SubagentRunResult>((res) => {
    resolveRun = res;
  });
  let sawAbort = false;
  return {
    specs,
    sawAbort: () => sawAbort,
    runner: {
      async run(spec: SubagentRunSpec): Promise<SubagentRunResult> {
        specs.push(spec);
        if (spec.signal) {
          spec.signal.addEventListener("abort", () => {
            sawAbort = true;
          });
        }
        return gate;
      },
    },
    finish: (r: SubagentRunResult) => resolveRun(r),
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

function resetTool(registry: BackgroundSubagentRegistry) {
  taskTool._sem = undefined;
  taskTool._spawned = 0;
  taskTool._runSeq = 0;
  taskTool.backgroundRegistry = registry;
}

describe("task tool — background dispatch", () => {
  it("returns immediately with a running handle, before the sub-agent finishes", async () => {
    const mock = makeDeferredRunner();
    taskTool.runner = mock.runner;
    const registry = new BackgroundSubagentRegistry();
    resetTool(registry);
    const events: Event[] = [];

    const r = await taskTool.execute(
      { objective: "long job", run: "background" } as never,
      ctxWith(events) as never,
    );

    // The tool returned while the runner's promise is still pending.
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/status: running/);
    expect(r.content).toMatch(/session_id: sub_/);
    // The runner was invoked and the job is registered as running.
    expect(mock.specs).toHaveLength(1);
    const listed = registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("running");
    // A background `subagent` progress event was emitted with background:true.
    const sub = events.find((e) => e.type === "subagent") as
      | Extract<Event, { type: "subagent" }>
      | undefined;
    expect(sub?.background).toBe(true);
    expect(sub?.state).toBe("running");

    // Let the job finish and the registry settle.
    mock.finish({ conclusion: "all done", steps: 3, ok: true });
    await registry.wait(listed[0]!.sessionId);
    expect(registry.get(listed[0]!.sessionId)!.status).toBe("ok");
  });

  it("fires the completion listener exactly once with the conclusion", async () => {
    const mock = makeDeferredRunner();
    taskTool.runner = mock.runner;
    const registry = new BackgroundSubagentRegistry();
    resetTool(registry);
    const completions: string[] = [];
    registry.onCompletion((m) => completions.push(`${m.status}:${m.summary}`));
    const events: Event[] = [];

    await taskTool.execute(
      { objective: "job", run: "background" } as never,
      ctxWith(events) as never,
    );
    mock.finish({ conclusion: "result text", steps: 1, ok: true });
    await registry.wait(registry.list()[0]!.sessionId);

    expect(completions).toEqual(["ok:result text"]);
  });

  it("holds a spawn slot while running and the background run counts against maxTotal", async () => {
    const mock = makeDeferredRunner();
    taskTool.runner = mock.runner;
    const registry = new BackgroundSubagentRegistry();
    resetTool(registry);
    taskTool.maxTotal = 1;
    const events: Event[] = [];

    const first = await taskTool.execute(
      { objective: "a", run: "background" } as never,
      ctxWith(events) as never,
    );
    expect(first.isError).toBeFalsy();
    // Second background dispatch is refused: the first already consumed the cap.
    const second = await taskTool.execute(
      { objective: "b", run: "background" } as never,
      ctxWith(events) as never,
    );
    expect(second.isError).toBe(true);
    expect(second.content).toMatch(/cap of 1/);

    mock.finish({ conclusion: "x", steps: 1, ok: true });
    taskTool.maxTotal = undefined;
  });

  it("refuses background when no registry is wired", async () => {
    const mock = makeDeferredRunner();
    taskTool.runner = mock.runner;
    taskTool._sem = undefined;
    taskTool._spawned = 0;
    taskTool._runSeq = 0;
    taskTool.backgroundRegistry = undefined;
    const events: Event[] = [];
    const r = await taskTool.execute(
      { objective: "x", run: "background" } as never,
      ctxWith(events) as never,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not available/);
  });

  it("fan-out ignores run:background (always awaits)", async () => {
    // A `tasks` fan-out with run:background should NOT take the background path;
    // it runs to completion and returns a combined result.
    const specs: SubagentRunSpec[] = [];
    taskTool.runner = {
      async run(spec: SubagentRunSpec): Promise<SubagentRunResult> {
        specs.push(spec);
        return { conclusion: `done ${spec.objective}`, steps: 1, ok: true };
      },
    };
    const registry = new BackgroundSubagentRegistry();
    resetTool(registry);
    const events: Event[] = [];
    const r = await taskTool.execute(
      { tasks: [{ objective: "x" }, { objective: "y" }], run: "background" } as never,
      ctxWith(events) as never,
    );
    expect(r.content).toMatch(/sub-agents finished/);
    expect(registry.list()).toHaveLength(0);
    expect(specs).toHaveLength(2);
  });
});

describe("background sub-agent control tools", () => {
  it("subagent_list reports running jobs; empty when none", async () => {
    const registry = new BackgroundSubagentRegistry();
    const listTool = makeSubagentListTool(registry);
    const empty = await listTool.execute({} as never, {} as never);
    expect(empty.content).toMatch(/No background sub-agents/);

    const mock = makeDeferredRunner();
    registry.register({
      sessionId: "sub_x",
      objective: "crunch",
      runSeq: 1,
      controller: new AbortController(),
      done: mock.runner.run({ objective: "crunch", cwd: "/tmp" }),
    });
    const list = await listTool.execute({} as never, {} as never);
    expect(list.content).toMatch(/sub_x/);
    expect(list.content).toMatch(/\[running\]/);
    expect(list.content).toMatch(/crunch/);
    mock.finish({ conclusion: "ok", steps: 1, ok: true });
    await registry.wait("sub_x");
  });

  it("subagent_wait blocks until done and returns the conclusion", async () => {
    const registry = new BackgroundSubagentRegistry();
    const waitTool = makeSubagentWaitTool(registry);
    const mock = makeDeferredRunner();
    registry.register({
      sessionId: "sub_w",
      objective: "o",
      runSeq: 1,
      controller: new AbortController(),
      done: mock.runner.run({ objective: "o", cwd: "/tmp" }),
    });
    const waitP = waitTool.execute({ session_id: "sub_w" } as never, {} as never);
    mock.finish({ conclusion: "the answer", steps: 2, ok: true });
    const r = await waitP;
    expect(r.content).toMatch(/finished: ok/);
    expect(r.content).toMatch(/the answer/);
  });

  it("subagent_wait reports a failed run as an error", async () => {
    const registry = new BackgroundSubagentRegistry();
    const waitTool = makeSubagentWaitTool(registry);
    const mock = makeDeferredRunner();
    registry.register({
      sessionId: "sub_f",
      objective: "o",
      runSeq: 1,
      controller: new AbortController(),
      done: mock.runner.run({ objective: "o", cwd: "/tmp" }),
    });
    const waitP = waitTool.execute({ session_id: "sub_f" } as never, {} as never);
    mock.finish({ conclusion: "it broke", steps: 0, ok: false });
    const r = await waitP;
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/failed/);
  });

  it("subagent_interrupt aborts a running job and marks it interrupted", async () => {
    const registry = new BackgroundSubagentRegistry();
    const interruptTool = makeSubagentInterruptTool(registry);
    const controller = new AbortController();
    let aborted = false;
    controller.signal.addEventListener("abort", () => (aborted = true));
    const mock = makeDeferredRunner();
    registry.register({
      sessionId: "sub_i",
      objective: "o",
      runSeq: 1,
      controller,
      done: mock.runner.run({ objective: "o", cwd: "/tmp" }),
    });
    const r = await interruptTool.execute(
      { session_id: "sub_i" } as never,
      {} as never,
    );
    expect(r.content).toMatch(/interrupting/);
    expect(aborted).toBe(true);
    expect(registry.get("sub_i")!.status).toBe("interrupted");

    // A second interrupt reports it is already interrupted.
    const r2 = await interruptTool.execute(
      { session_id: "sub_i" } as never,
      {} as never,
    );
    expect(r2.isError).toBe(true);
    expect(r2.content).toMatch(/already interrupted/);
    mock.finish({ conclusion: "x", steps: 0, ok: false });
  });

  it("control tools report unknown session_ids", async () => {
    const registry = new BackgroundSubagentRegistry();
    const waitTool = makeSubagentWaitTool(registry);
    const interruptTool = makeSubagentInterruptTool(registry);
    const w = await waitTool.execute({ session_id: "nope" } as never, {} as never);
    expect(w.isError).toBe(true);
    expect(w.content).toMatch(/No background sub-agent/);
    const i = await interruptTool.execute(
      { session_id: "nope" } as never,
      {} as never,
    );
    expect(i.isError).toBe(true);
    expect(i.content).toMatch(/No background sub-agent/);
  });

  it("two sessions' control tools stay bound to their own registry (no cross-wiring)", async () => {
    // Regression: the control tools were module singletons whose `.registry`
    // field was overwritten by whichever session initialized its tools last.
    // In a multi-session process (the shared daemon) that made session A's
    // `subagent_wait` resolve against session B's registry, reporting "No
    // background sub-agent with session_id …" for a job that really existed.
    // Building the tools per session (closing over the registry) fixes it.
    const regA = new BackgroundSubagentRegistry();
    const regB = new BackgroundSubagentRegistry();
    const waitA = makeSubagentWaitTool(regA);
    const listA = makeSubagentListTool(regA);
    // Session B initializes its tools AFTER A — under the old singleton bug this
    // is the write that would hijack A's control tools.
    makeSubagentWaitTool(regB);
    makeSubagentListTool(regB);

    const mock = makeDeferredRunner();
    regA.register({
      sessionId: "sub_a664",
      objective: "A job",
      runSeq: 1,
      controller: new AbortController(),
      done: mock.runner.run({ objective: "A job", cwd: "/tmp" }),
    });

    // A's list sees A's job; B's registry is empty.
    const listed = await listA.execute({} as never, {} as never);
    expect(listed.content).toMatch(/sub_a664/);
    expect(regB.list()).toHaveLength(0);

    // A's wait resolves against A's registry — the job is found, not "unknown".
    const waitP = waitA.execute({ session_id: "sub_a664" } as never, {} as never);
    mock.finish({ conclusion: "A result", steps: 1, ok: true });
    const r = await waitP;
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/finished: ok/);
    expect(r.content).toMatch(/A result/);
  });
});
