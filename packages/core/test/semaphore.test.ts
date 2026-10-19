import { describe, expect, it } from "vitest";

import { Semaphore } from "../src/tools/task.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Semaphore", () => {
  it("caps concurrency to the permit count", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const work = () =>
      sem.withPermit(async () => {
        running++;
        peak = Math.max(peak, running);
        await tick(20);
        running--;
      });
    await Promise.all([work(), work(), work(), work()]);
    expect(peak).toBe(2);
    expect(running).toBe(0);
  });

  it("releases the permit even when fn throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.withPermit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
 // If the permit leaked, this second acquire would hang forever.
    const ok = await sem.withPermit(async () => "ok");
    expect(ok).toBe("ok");
  });

  it("times out a stuck task and frees the permit for the next", async () => {
    const sem = new Semaphore(1);
    const slow = sem.withPermit(() => tick(1000).then(() => "slow"), { timeoutMs: 20 });
    await expect(slow).rejects.toThrow(/time budget/);
 // The permit must be back so a fresh task runs promptly.
    const fast = await sem.withPermit(async () => "fast", { timeoutMs: 1000 });
    expect(fast).toBe("fast");
  });

  it("rejects a queued acquire when its signal aborts, without losing the permit", async () => {
    const sem = new Semaphore(1);
 // Hold the only permit.
    let release!: () => void;
    const held = sem.withPermit(
      () => new Promise<void>((r) => { release = r; }),
    );
 // Queue a second acquire with an abort signal, then abort it.
    const ac = new AbortController();
    const queued = sem.acquire(ac.signal);
    await tick(5);
    ac.abort();
    await expect(queued).rejects.toThrow(/aborted/);
 // Let the holder finish; the permit must still be acquirable.
    release();
    await held;
    const after = await sem.withPermit(async () => "after");
    expect(after).toBe("after");
  });

  it("acquire rejects immediately if the signal is already aborted", async () => {
    const sem = new Semaphore(1);
    const ac = new AbortController();
    ac.abort();
    await expect(sem.acquire(ac.signal)).rejects.toThrow(/aborted/);
 // Permit was never consumed.
    const ok = await sem.withPermit(async () => "ok");
    expect(ok).toBe("ok");
  });
});
