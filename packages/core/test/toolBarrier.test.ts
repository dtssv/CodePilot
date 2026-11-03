// Read/write concurrency barrier for in-turn tool execution.
//
// CodePilot used to run every tool call in a turn via a single `Promise.all`,
// which races two writes to the same file (the mtime/size CAS guard only
// catches staleness ACROSS turns, not two in-flight writes inside one turn).
// codex (RwLock read/write gate) and dsh (fail-closed exclusive barrier) both
// serialize mutating tools at the orchestration layer; these tests pin that
// behaviour for CodePilot's equivalent: reads parallelize, writes/execute run
// exclusively, results stay in the model's original call order, and an unknown
// permission is fail-closed (serial).

import { describe, expect, it } from "vitest";
import { runToolsWithBarrier, isParallelSafeTool } from "../src/agent.js";
import type { ToolExecResult } from "../src/agent-tools.js";

type Call = { id: string; parallel: boolean };

/** A run() that records concurrency: it reports the max number of calls that
 * were ever in flight simultaneously, and the completion order. */
function makeRunner() {
  let inFlight = 0;
  let maxInFlight = 0;
  const started: string[] = [];
  const settled: string[] = [];
  const run = async (c: Call): Promise<ToolExecResult> => {
    started.push(c.id);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Yield across a few microtasks so genuinely concurrent calls overlap.
    await Promise.resolve();
    await Promise.resolve();
    inFlight--;
    settled.push(c.id);
    return { content: c.id };
  };
  return { run, get maxInFlight() { return maxInFlight; }, started, settled };
}

describe("isParallelSafeTool", () => {
  it("treats read and network as parallel-safe", () => {
    expect(isParallelSafeTool("read")).toBe(true);
    expect(isParallelSafeTool("network")).toBe(true);
  });
  it("treats write and execute as NOT parallel-safe", () => {
    expect(isParallelSafeTool("write")).toBe(false);
    expect(isParallelSafeTool("execute")).toBe(false);
  });
  it("is fail-closed for an unknown permission", () => {
    expect(isParallelSafeTool(undefined)).toBe(false);
  });
});

describe("runToolsWithBarrier", () => {
  it("runs a batch of adjacent read-only calls concurrently", async () => {
    const calls: Call[] = [
      { id: "r1", parallel: true },
      { id: "r2", parallel: true },
      { id: "r3", parallel: true },
    ];
    const r = makeRunner();
    const out = await runToolsWithBarrier(calls, (c) => c.parallel, r.run);
    expect(out.map((o) => o.content)).toEqual(["r1", "r2", "r3"]);
    // All three were in flight at once.
    expect(r.maxInFlight).toBe(3);
  });

  it("serializes a write so nothing else runs while it is in flight", async () => {
    const calls: Call[] = [{ id: "w1", parallel: false }];
    const r = makeRunner();
    await runToolsWithBarrier(calls, (c) => c.parallel, r.run);
    expect(r.maxInFlight).toBe(1);
  });

  it("never overlaps two writes to the same resource", async () => {
    const calls: Call[] = [
      { id: "w1", parallel: false },
      { id: "w2", parallel: false },
    ];
    const r = makeRunner();
    await runToolsWithBarrier(calls, (c) => c.parallel, r.run);
    // Exclusive: at most one write in flight at any moment — no clobber race.
    expect(r.maxInFlight).toBe(1);
    // And they ran strictly in order.
    expect(r.settled).toEqual(["w1", "w2"]);
  });

  it("parallelizes reads but breaks the batch at a write (read, read | write | read)", async () => {
    const calls: Call[] = [
      { id: "r1", parallel: true },
      { id: "r2", parallel: true },
      { id: "w1", parallel: false },
      { id: "r3", parallel: true },
    ];
    const r = makeRunner();
    const out = await runToolsWithBarrier(calls, (c) => c.parallel, r.run);
    // Results preserve the model's original order regardless of concurrency.
    expect(out.map((o) => o.content)).toEqual(["r1", "r2", "w1", "r3"]);
    // The write never overlapped a read: the first batch (r1,r2) reaches 2, but
    // w1 runs alone, and r3 runs after w1 settles — so 2 is the global max.
    expect(r.maxInFlight).toBe(2);
    // The write started only after the first read batch fully settled, and r3
    // only after the write settled.
    expect(r.settled.indexOf("w1")).toBeGreaterThan(r.settled.indexOf("r2"));
    expect(r.settled.indexOf("r3")).toBeGreaterThan(r.settled.indexOf("w1"));
  });

  it("keeps results index-aligned with the input for a mixed sequence", async () => {
    const calls: Call[] = [
      { id: "w0", parallel: false },
      { id: "r1", parallel: true },
      { id: "r2", parallel: true },
      { id: "w3", parallel: false },
    ];
    const r = makeRunner();
    const out = await runToolsWithBarrier(calls, (c) => c.parallel, r.run);
    expect(out.map((o) => o.content)).toEqual(["w0", "r1", "r2", "w3"]);
  });
});
