import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentStore } from "../src/subagentStore.js";
import type { Event } from "../src/types.js";

const msg = (id: string, text: string): Event => ({
  type: "message",
  id,
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("SubagentStore", () => {
  it("round-trips replayable events for a sub-agent id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sas-"));
    try {
      const store = new SubagentStore(dir);
      expect(await store.load("sub_a")).toEqual([]);
      expect(await store.exists("sub_a")).toBe(false);
      await store.append("sub_a", msg("m1", "hello"));
      await store.append("sub_a", msg("m2", "world"));
      const loaded = await store.load("sub_a");
      expect(loaded.map((e) => (e.type === "message" ? e.content[0] : null))).toEqual([
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]);
      expect(await store.exists("sub_a")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops live-only events (deltas / activity), keeps the transcript clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sas-"));
    try {
      const store = new SubagentStore(dir);
      await store.appendAll("sub_b", [
        msg("m1", "kept"),
        { type: "activity", phase: "model", since: 0 } as Event,
        { type: "message_delta", messageId: "m1", delta: { type: "text", text: "x" } } as Event,
        { type: "tool_result", toolCallId: "t1", name: "echo", content: "r" } as Event,
      ]);
      const loaded = await store.load("sub_b");
      expect(loaded.map((e) => e.type)).toEqual(["message", "tool_result"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replace() supersedes a prior (discarded) transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sas-"));
    try {
      const store = new SubagentStore(dir);
      await store.appendAll("sub_c", [msg("m1", "attempt1 garbage")]);
      await store.replace("sub_c", [msg("m2", "adopted")]);
      const loaded = await store.load("sub_c");
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.type === "message" && loaded[0]!.content[0]).toEqual({ type: "text", text: "adopted" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isolates ids and skips corrupt lines on load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sas-"));
    try {
      const store = new SubagentStore(dir);
      await store.append("sub_x", msg("m1", "x"));
      await store.append("sub_y", msg("m1", "y"));
      expect((await store.load("sub_x")).length).toBe(1);
      expect((await store.load("sub_y")).length).toBe(1);
      // A missing id is simply empty.
      expect(await store.load("sub_missing")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
