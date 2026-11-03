// Unit tests for the shared artifact-spill helper. Several tools (bash,
// grep, web_fetch, code_mode) rely on a single spill threshold + head+tail
// shape; this pins the helper's contract so none of them can drift.

import { describe, it, expect } from "vitest";
import { spillHeadTail, ARTIFACT_THRESHOLD } from "../src/tools/_shared.js";
import type { ToolContext } from "../src/tools/types.js";

function captureCtx(): { ctx: ToolContext; store: Map<string, string> } {
  const store = new Map<string, string>();
  let n = 0;
  const ctx = {
    cwd: "/tmp",
    async artifact(blob: string | Uint8Array, _hint?: string) {
      const ref = `art_${n++}`;
      store.set(ref, String(blob));
      return ref;
    },
    async readArtifact() {
      return "";
    },
  } as unknown as ToolContext;
  return { ctx, store };
}

describe("spillHeadTail", () => {
  it("returns content verbatim and writes no artifact at/below the threshold", async () => {
    const { ctx, store } = captureCtx();
    const body = "x".repeat(ARTIFACT_THRESHOLD);
    const r = await spillHeadTail(ctx, body, "hint");
    expect(r.content).toBe(body);
    expect(r.artifactRef).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("spills above the threshold, keeping a bounded head+tail with a gap marker", async () => {
    const { ctx, store } = captureCtx();
    const head = "H".repeat(100);
    const tail = "T".repeat(100);
    const middle = "m".repeat(ARTIFACT_THRESHOLD);
    const body = head + middle + tail;
    const r = await spillHeadTail(ctx, body, "hint", { head: 100, tail: 100 });
    expect(r.artifactRef).toBeTruthy();
    expect(store.get(r.artifactRef!)).toBe(body); // full body preserved in artifact
    expect(r.content.startsWith(head)).toBe(true);
    expect(r.content.endsWith(tail)).toBe(true);
    expect(r.content).toContain("chars omitted");
    expect(r.content).toContain(r.artifactRef!);
    expect(r.content.length).toBeLessThan(body.length);
  });

  it("degenerate guard: when head+tail would cover the whole body, returns it verbatim with the ref", async () => {
    const { ctx, store } = captureCtx();
    // Over threshold so it spills, but head+tail windows exceed the length →
    // slicing would duplicate content, so the helper returns the full body.
    const body = "z".repeat(ARTIFACT_THRESHOLD + 10);
    const r = await spillHeadTail(ctx, body, "hint", {
      head: ARTIFACT_THRESHOLD,
      tail: ARTIFACT_THRESHOLD,
    });
    expect(r.artifactRef).toBeTruthy();
    expect(store.get(r.artifactRef!)).toBe(body);
    expect(r.content).toBe(body);
    expect(r.content).not.toContain("chars omitted");
  });
});
