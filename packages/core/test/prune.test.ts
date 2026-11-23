import { describe, expect, it, vi } from "vitest";
import type { Event } from "../src/types.js";
import {
  planToolResultPrune,
  applyToolResultPruneOverlays,
  microFoldEventFromPlan,
  liveTranscript,
} from "../src/compaction/compaction.js";
import { sessionMaybePruneToolResults } from "../src/compaction/sessionBind.js";

function makeTranscript(toolBodies: string[]): Event[] {
  const events: Event[] = [];
  for (let i = 0; i < toolBodies.length; i++) {
    events.push({
      type: "message",
      id: `u${i}`,
      role: "user",
      content: [{ type: "text", text: `ask ${i}` }],
    });
    events.push({
      type: "message",
      id: `a${i}`,
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `tc${i}`,
          name: "bash",
          input: { command: `echo ${i}` },
        },
      ],
    });
    events.push({
      type: "tool_result",
      toolCallId: `tc${i}`,
      name: "bash",
      content: toolBodies[i]!,
    });
  }
  return events;
}

describe("planToolResultPrune", () => {
  it("returns null when eligible chars are below the trigger", () => {
    const events = makeTranscript([
      "x".repeat(2_000),
      "y".repeat(2_000),
      "z".repeat(2_000),
      "a".repeat(2_000),
      "b".repeat(2_000),
      "c".repeat(2_000),
      "d".repeat(2_000),
      "e".repeat(2_000),
      "f".repeat(2_000),
      "g".repeat(2_000),
    ]);
    // 10 results × 2k = 20k, but keepRecentMessages=8 leaves only ~2 old
    // results eligible → under a high trigger.
    const plan = planToolResultPrune(events, {
      keepRecentMessages: 8,
      minChars: 1_200,
      triggerChars: 50_000,
    });
    expect(plan).toBeNull();
  });

  it("plans stubs for old large results past the keep window", () => {
    const bodies = Array.from({ length: 12 }, (_, i) => `body-${i}-` + "x".repeat(2_000));
    const events = makeTranscript(bodies);
    const plan = planToolResultPrune(events, {
      keepRecentMessages: 4,
      minChars: 1_200,
      triggerChars: 4_000,
    });
    expect(plan).not.toBeNull();
    expect(plan!.folds.length).toBeGreaterThan(0);
    expect(plan!.charsSaved).toBeGreaterThan(0);
    for (const f of plan!.folds) {
      expect(f.content.startsWith("[folded tool_result")).toBe(true);
      expect(f.originalChars).toBeGreaterThan(f.content.length);
    }
  });

  it("reuses stubMemo wording across plans", () => {
    const bodies = Array.from({ length: 12 }, (_, i) => `body-${i}-` + "x".repeat(2_000));
    const events = makeTranscript(bodies);
    const memo = new Map<string, string>();
    const first = planToolResultPrune(events, {
      keepRecentMessages: 4,
      triggerChars: 4_000,
      stubMemo: memo,
    });
    expect(first).not.toBeNull();
    const id = first!.folds[0]!.toolCallId;
    memo.set(id, memo.get(id)! + "\nFROZEN");
    const second = planToolResultPrune(events, {
      keepRecentMessages: 4,
      triggerChars: 4_000,
      stubMemo: memo,
    });
    const again = second!.folds.find((f) => f.toolCallId === id);
    expect(again?.content).toContain("FROZEN");
  });
});

describe("applyToolResultPruneOverlays", () => {
  it("overlays durable micro-fold stubs onto matching tool_results", () => {
    const events = makeTranscript([
      "x".repeat(3_000),
      "y".repeat(3_000),
      "z".repeat(3_000),
      "a".repeat(3_000),
      "b".repeat(3_000),
      "c".repeat(3_000),
      "d".repeat(3_000),
      "e".repeat(3_000),
      "f".repeat(3_000),
      "g".repeat(3_000),
    ]);
    const plan = planToolResultPrune(events, {
      keepRecentMessages: 4,
      triggerChars: 4_000,
    });
    expect(plan).not.toBeNull();
    const foldEv = microFoldEventFromPlan(plan!);
    const withFold = [...events, foldEv];
    const overlaid = applyToolResultPruneOverlays(withFold);
    for (const f of plan!.folds) {
      const tr = overlaid.find(
        (e): e is Event & { type: "tool_result" } =>
          e.type === "tool_result" && e.toolCallId === f.toolCallId,
      );
      expect(tr?.content).toBe(f.content);
    }
    // Original full body remains on the pre-overlay event object identity
    // in `events` (append-only); only the overlay copy is stubbed.
    const original = events.find(
      (e): e is Event & { type: "tool_result" } =>
        e.type === "tool_result" && e.toolCallId === plan!.folds[0]!.toolCallId,
    );
    expect(original?.content.length).toBe(plan!.folds[0]!.originalChars);
  });

  it("liveTranscript applies micro-fold overlays on resume rebuild", () => {
    const events = makeTranscript([
      "x".repeat(3_000),
      "y".repeat(3_000),
      "z".repeat(3_000),
      "a".repeat(3_000),
      "b".repeat(3_000),
      "c".repeat(3_000),
      "d".repeat(3_000),
      "e".repeat(3_000),
      "f".repeat(3_000),
      "g".repeat(3_000),
    ]);
    const plan = planToolResultPrune(events, {
      keepRecentMessages: 4,
      triggerChars: 4_000,
    });
    expect(plan).not.toBeNull();
    const live = liveTranscript([...events, microFoldEventFromPlan(plan!)]);
    const stubbed = live.filter(
      (e): e is Event & { type: "tool_result" } =>
        e.type === "tool_result" && e.content.startsWith("[folded tool_result"),
    );
    expect(stubbed.length).toBe(plan!.folds.length);
  });
});

describe("sessionMaybePruneToolResults — cache-safe default", () => {
  function hostWithEligibleBodies(prune?: boolean) {
    const events = makeTranscript(Array.from({ length: 12 }, () => "x".repeat(3_000)));
    return {
      disposed: false,
      config: {
        ...(prune === undefined ? {} : { toolResultPrune: prune }),
        autoCompact: false,
      },
      events,
      model: "claude-sonnet-4-5",
      foldedToolResultStubs: new Map<string, string>(),
      autoCompactDisabled: false,
      contextChangedForNextTurn: false,
      contextAnchor: null,
      lastProviderInputTokens: 0,
      persistEvent: vi.fn(async () => {}),
      notify: vi.fn(),
    };
  }

  it("does not micro-fold by default (unset toolResultPrune)", async () => {
    const host = hostWithEligibleBodies(undefined);
    const before = host.events.length;
    const pruned = await sessionMaybePruneToolResults(host as never);
    expect(pruned).toBe(false);
    expect(host.events.length).toBe(before);
    expect(host.contextChangedForNextTurn).toBe(false);
  });

  it("micro-folds only when toolResultPrune is explicitly true", async () => {
    const host = hostWithEligibleBodies(true);
    const before = host.events.length;
    const pruned = await sessionMaybePruneToolResults(host as never);
    expect(pruned).toBe(true);
    expect(host.events.length).toBeGreaterThan(before);
    expect(host.contextChangedForNextTurn).toBe(true);
  });
});
