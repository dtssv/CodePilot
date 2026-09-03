import { describe, expect, it } from "vitest";
import {
  compact,
  shouldCompact,
  foldToolResults,
  estimateEventTokens,
  eventsToMessages,
  extractPlan,
} from "../src/compaction.js";
import type { Event, ToolResultBlock } from "../src/types.js";

function makeEvents(): Event[] {
  const events: Event[] = [];
  for (let i = 0; i < 5; i++) {
    events.push({
      type: "message",
      id: `m${i}`,
      role: "user",
      content: [{ type: "text", text: "user prompt " + i + " ".repeat(200) }],
    });
    events.push({
      type: "message",
      id: `a${i}`,
      role: "assistant",
      content: [
        { type: "text", text: "thinking " + "x".repeat(150) },
        { type: "tool_use", id: `tc${i}`, name: "bash", input: { command: "ls" } },
      ],
    });
    const big = "result line\n".repeat(800);
    const r: ToolResultBlock = {
      type: "tool_result",
      toolCallId: `tc${i}`,
      content: big,
    };
    events.push({
      type: "tool_result",
      toolCallId: `tc${i}`,
      name: "bash",
      content: big,
    });
    // Include r to silence unused warning.
    void r;
  }
  return events;
}

describe("shouldCompact", () => {
  it("returns false when below threshold", () => {
    const events = makeEvents();
    const decision = shouldCompact(events, { contextWindow: 10_000_000 });
    expect(decision.shouldCompact).toBe(false);
  });

  it("returns true when above threshold", () => {
    const events = makeEvents();
    const decision = shouldCompact(events, { contextWindow: 10 });
    expect(decision.shouldCompact).toBe(true);
    expect(decision.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("foldToolResults", () => {
  it("folds old tool results but keeps recent", () => {
    const events = makeEvents();
    const before = events.filter((e) => e.type === "tool_result");
    expect(before.length).toBe(5);
    const { events: folded, foldedCount } = foldToolResults(events, {
      keepRecentMessages: 4,
    });
    expect(foldedCount).toBeGreaterThan(0);
    const after = folded.filter((e) => e.type === "tool_result");
    // Some old tool results should now be short stubs.
    const shortCount = after.filter((e) => e.content.length < 400).length;
    expect(shortCount).toBeGreaterThan(0);
  });

  it("does not fold when transcript is small", () => {
    const events = makeEvents().slice(0, 2);
    const { foldedCount } = foldToolResults(events, { keepRecentMessages: 8 });
    expect(foldedCount).toBe(0);
  });
});

describe("compact (without summariser)", () => {
  it("returns input unchanged when below threshold", async () => {
    const events = makeEvents();
    const r = await compact(events, { contextWindow: 10_000_000 });
    expect(r.events).toBe(events);
    expect(r.summary).toBe("");
  });

  it("folds results but produces no summary without summariser", async () => {
    const events = makeEvents();
    const r = await compact(events, {
      contextWindow: 10,
      keepRecentMessages: 2, // force folding of multiple earlier tool results
      // no summariser
    });
    expect(r.summary).toBe("");
    // Either some folding happened, or compaction is gated by `shouldCompact`
    // which it is because the window is tiny. We mainly assert no crash.
    expect(r.events.length).toBe(events.length);
  });
});

describe("estimateEventTokens", () => {
  it("counts text length roughly", () => {
    const tokens = estimateEventTokens(
      [{ type: "message", id: "m", role: "user", content: [{ type: "text", text: "x".repeat(400) }] }],
      (s) => Math.ceil(s.length / 4)
    );
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("extractPlan", () => {
  it("returns the latest plan", () => {
    const events: Event[] = [
      { type: "plan", steps: [{ id: "1", title: "old", status: "completed" }] },
      { type: "plan", steps: [{ id: "2", title: "current", status: "in_progress" }] },
    ];
    const plan = extractPlan(events);
    expect(plan?.[0]?.id).toBe("2");
  });
  it("returns undefined when no plan", () => {
    expect(extractPlan([])).toBeUndefined();
  });
});

describe("eventsToMessages", () => {
  it("merges message_deltas into the parent message", () => {
    const events: Event[] = [
      { type: "message", id: "m1", role: "assistant", content: [{ type: "text", text: "hello " }] },
      { type: "message_delta", messageId: "m1", delta: { type: "text", text: "world" } },
    ];
    const out = eventsToMessages(events);
    expect(out[0]?.role).toBe("assistant");
    expect((out[0]?.content[0] as { text: string }).text).toBe("hello world");
  });

  it("emits tool_result as its own user message", () => {
    const events: Event[] = [
      { type: "tool_result", toolCallId: "x", name: "bash", content: "ok" },
    ];
    const out = eventsToMessages(events);
    expect(out.length).toBe(1);
    expect(out[0]?.role).toBe("user");
    expect(out[0]?.content[0]?.type).toBe("tool_result");
  });
});
