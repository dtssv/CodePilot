import { describe, expect, it } from "vitest";

import { parseSse } from "../src/providers/sse.js";

/** A ReadableStream that emits the given chunks, then (optionally) stalls
 * forever without closing — modelling an LLM that stopped producing tokens
 * mid-generation. */
function makeStream(
  chunks: string[],
  { stallAfter = true }: { stallAfter?: boolean } = {},
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i]!));
        i++;
        return;
      }
      if (!stallAfter) controller.close();
 // else: return without enqueueing/closing → the next read blocks forever.
    },
  });
}

describe("parseSse abort handling", () => {
  it("parses frames normally to completion", async () => {
    const stream = makeStream(
      ["data: a\n\n", "data: b\n\n"],
      { stallAfter: false },
    );
    const frames: string[] = [];
    for await (const f of parseSse(stream)) frames.push(f.data);
    expect(frames).toEqual(["a", "b"]);
  });

  it("unblocks promptly when aborted while the stream is stalled mid-read", async () => {
    const ac = new AbortController();
 // Emits one frame, then stalls forever (never closes) — the classic
 // "model stopped sending tokens" case where read blocks.
    const stream = makeStream(["data: first\n\n"]);

    const got: string[] = [];
    const consume = (async () => {
      for await (const f of parseSse(stream, ac.signal)) got.push(f.data);
    })();

 // Let the first frame land, then abort while parseSse is blocked on read.
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();

 // The iterator must settle quickly (not hang). Race against a timeout:
 // before the fix this would never resolve.
    const settled = await Promise.race([
      consume.then(() => "done"),
      new Promise((r) => setTimeout(() => r("timeout"), 500)),
    ]);
    expect(settled).toBe("done");
    expect(got).toEqual(["first"]);
  });

  it("returns immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const stream = makeStream(["data: x\n\n"]);
    const got: string[] = [];
    const settled = await Promise.race([
      (async () => {
        for await (const f of parseSse(stream, ac.signal)) got.push(f.data);
        return "done";
      })(),
      new Promise((r) => setTimeout(() => r("timeout"), 500)),
    ]);
    expect(settled).toBe("done");
  });
});
