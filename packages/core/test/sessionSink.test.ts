import { describe, expect, it, vi } from "vitest";
import { BoundedSinkQueue, type SessionEventSink } from "../src/sessionSink.js";

/** Wait for the single-flight background drain to settle. */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("BoundedSinkQueue", () => {
  it("mirrors enqueued lines to the sink in order, on a background drain", async () => {
    const seen: Array<[string, string]> = [];
    const sink: SessionEventSink = {
      write: (sessionId, line) => {
        seen.push([sessionId, line]);
      },
    };
    const q = new BoundedSinkQueue(sink);
    q.enqueue("s1", "a");
    q.enqueue("s1", "b");
    // enqueue is synchronous; the sink hasn't necessarily run yet.
    await q.flush("s1");
    expect(seen).toEqual([
      ["s1", "a"],
      ["s1", "b"],
    ]);
  });

  it("never throws from enqueue even when the sink throws", async () => {
    const errors: Error[] = [];
    const sink: SessionEventSink = {
      write: () => {
        throw new Error("sink down");
      },
    };
    const q = new BoundedSinkQueue(sink, { onError: (e) => errors.push(e) });
    expect(() => q.enqueue("s1", "x")).not.toThrow();
    await q.flush("s1");
    expect(errors.some((e) => /sink down/.test(e.message))).toBe(true);
  });

  it("drops the oldest line when the queue is full and counts it", async () => {
    // A sink that blocks until released, so the queue fills up.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const written: string[] = [];
    const sink: SessionEventSink = {
      write: async (_s, line) => {
        if (line === "0") await gate; // hold the first write open
        written.push(line);
      },
    };
    const errors: Error[] = [];
    const q = new BoundedSinkQueue(sink, { maxQueue: 2, onError: (e) => errors.push(e) });
    // "0" starts draining and blocks; "1","2" queue; "3" overflows → drops "1".
    q.enqueue("s", "0");
    await tick();
    q.enqueue("s", "1");
    q.enqueue("s", "2");
    q.enqueue("s", "3");
    expect(q.dropped).toBe(1);
    expect(errors.some((e) => /queue full/.test(e.message))).toBe(true);
    release();
    await q.flush("s");
    // "1" was dropped; the rest were written.
    expect(written).toContain("0");
    expect(written).toContain("2");
    expect(written).toContain("3");
    expect(written).not.toContain("1");
  });

  it("flushes then closes the sink; enqueue after close is a no-op", async () => {
    const flush = vi.fn();
    const close = vi.fn();
    const written: string[] = [];
    const sink: SessionEventSink = {
      write: (_s, line) => {
        written.push(line);
      },
      flush,
      close,
    };
    const q = new BoundedSinkQueue(sink);
    q.enqueue("s", "a");
    await q.close();
    expect(close).toHaveBeenCalledOnce();
    expect(written).toEqual(["a"]);
    q.enqueue("s", "ignored");
    await tick();
    expect(written).toEqual(["a"]);
  });

  it("swallows a throwing flush/close (fail-soft)", async () => {
    const errors: Error[] = [];
    const sink: SessionEventSink = {
      write: () => undefined,
      flush: () => {
        throw new Error("flush boom");
      },
      close: () => {
        throw new Error("close boom");
      },
    };
    const q = new BoundedSinkQueue(sink, { onError: (e) => errors.push(e) });
    q.enqueue("s", "a");
    await expect(q.flush("s")).resolves.toBeUndefined();
    await expect(q.close()).resolves.toBeUndefined();
    expect(errors.some((e) => /flush boom/.test(e.message))).toBe(true);
    expect(errors.some((e) => /close boom/.test(e.message))).toBe(true);
  });
});
