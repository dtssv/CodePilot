import { describe, expect, it } from "vitest";
import { runToolsWithBarrier } from "../src/agent/agent-barrier.js";

describe("runToolsWithBarrier steer pause", () => {
  it("runs the first batch even when shouldPause is already true", async () => {
    const ran: number[] = [];
    const results = await runToolsWithBarrier(
      [0, 1, 2],
      () => true,
      async (i) => {
        ran.push(i);
        return { content: `ok-${i}` };
      },
      { shouldPause: () => true },
    );
    // First adjacent parallel batch runs entirely; pause only after a finished batch.
    expect(ran).toEqual([0, 1, 2]);
    expect(results.map((r) => r.content)).toEqual(["ok-0", "ok-1", "ok-2"]);
  });

  it("skips later exclusive batches once shouldPause flips after the first", async () => {
    const ran: number[] = [];
    let pause = false;
    const results = await runToolsWithBarrier(
      [0, 1, 2],
      () => false, // exclusive each
      async (i) => {
        ran.push(i);
        if (i === 0) pause = true;
        return { content: `ok-${i}` };
      },
      { shouldPause: () => pause },
    );
    expect(ran).toEqual([0]);
    expect(results[0]!.content).toBe("ok-0");
    expect(results[1]!.content).toMatch(/interrupted: a user message was injected/i);
    expect(results[2]!.content).toMatch(/interrupted: a user message was injected/i);
    expect(results[1]!.isError).toBe(true);
  });
});
