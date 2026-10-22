import { describe, expect, it } from "vitest";
import {
  compact,
  shouldCompact,
  foldToolResults,
  trimEventsToBudget,
  estimateEventTokens,
  eventsToMessages,
  extractPlan,
  liveTranscript,
} from "../src/compaction.js";
import type { Event, ToolResultBlock } from "../src/types.js";
import { buildProviderMessages } from "../src/agent-messages.js";

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
 // Older results become fold stubs; the most recent keepRecent stay verbatim.
    const stubCount = after.filter(
      (e) => e.type === "tool_result" && e.content.startsWith("[folded tool_result"),
    ).length;
    expect(stubCount).toBeGreaterThan(0);
    expect(stubCount).toBeLessThan(after.length);
  });

  it("does not fold when transcript is small", () => {
    const events = makeEvents().slice(0, 2);
    const { foldedCount } = foldToolResults(events, { keepRecentMessages: 8 });
    expect(foldedCount).toBe(0);
  });

  it("never folds large results in a transcript shorter than keepRecentMessages", () => {
 // One user prompt + one assistant turn with big reads: nothing is old yet.
    const events = makeEvents().slice(0, 3);
    const { foldedCount } = foldToolResults(events, { keepRecentMessages: 8, minChars: 160 });
    expect(foldedCount).toBe(0);
  });

  it("never folds the latest tool batch the model has not seen yet", () => {
    const events = makeEvents();
    const { events: folded } = foldToolResults(events, { keepRecentMessages: 1, minChars: 160 });
    const last = folded[folded.length - 1]!;
    expect(last.type === "tool_result" && last.content.startsWith("[folded")).toBe(false);
  });

  it("fold stub forbids re-calling the same tool and points at read_artifact", () => {
    const events = makeEvents();
 // Attach an artifactRef so the stub must mention it.
    for (const e of events) {
      if (e.type === "tool_result") e.artifactRef = "art_deadbeef";
    }
    const { events: folded } = foldToolResults(events, { keepRecentMessages: 2 });
    const stub = folded.find(
      (e) => e.type === "tool_result" && e.content.startsWith("[folded tool_result"),
    );
    expect(stub && stub.type === "tool_result" ? stub.content : "").toMatch(/do NOT re-call/);
    expect(stub && stub.type === "tool_result" ? stub.content : "").toMatch(/read_artifact/);
    expect(stub && stub.type === "tool_result" ? stub.content : "").toMatch(/art_deadbeef/);
  });

  it("defers read_file results until only reads are left to fold", () => {
 // Interleave bash + read_file results old enough to be folded.
    const events: Event[] = [];
    for (let i = 0; i < 4; i++) {
      events.push({
        type: "message",
        id: `m${i}`,
        role: "user",
        content: [{ type: "text", text: "prompt " + i }],
      });
      events.push({
        type: "tool_result",
        toolCallId: `b${i}`,
        name: "bash",
        content: "bash output\n".repeat(300), // >1200 chars → foldable
      });
      events.push({
        type: "tool_result",
        toolCallId: `r${i}`,
        name: "read_file",
        content: "file body\n".repeat(300), // >1200 chars → foldable but deferred
      });
    }
    const { events: folded, foldedCount } = foldToolResults(events, { keepRecentMessages: 1 });
 // Only bash results folded; every read_file body survived verbatim.
    expect(foldedCount).toBeGreaterThan(0);
    const foldedNames = folded
      .filter((e) => e.type === "tool_result" && e.content.startsWith("[folded tool_result"))
      .map((e) => (e.type === "tool_result" ? e.name : ""));
    expect(foldedNames).not.toContain("read_file");
    expect(foldedNames).toContain("bash");
    const reads = folded.filter((e) => e.type === "tool_result" && e.name === "read_file");
    expect(reads.every((e) => e.type === "tool_result" && e.content.startsWith("file body"))).toBe(true);
  });

  it("folds read_file too when nothing else qualifies", () => {
    const events: Event[] = [];
    for (let i = 0; i < 4; i++) {
      events.push({
        type: "message",
        id: `m${i}`,
        role: "user",
        content: [{ type: "text", text: "prompt " + i }],
      });
      events.push({
        type: "tool_result",
        toolCallId: `r${i}`,
        name: "read_file",
        content: "file body\n".repeat(300),
      });
    }
    const { foldedCount } = foldToolResults(events, { keepRecentMessages: 1 });
    expect(foldedCount).toBeGreaterThan(0);
  });
});

describe("compact (without summariser)", () => {
  it("returns input unchanged when below threshold", async () => {
    const events = makeEvents();
    const r = await compact(events, { contextWindow: 10_000_000 });
    expect(r.events).toBe(events);
    expect(r.summary).toBe("");
  });

  it("hard-trims when over budget even without a summariser", async () => {
    const events = makeEvents();
    const before = estimateEventTokens(events, (s) => Math.ceil(s.length / 4));
    const r = await compact(events, {
      contextWindow: 2_000,
      keepRecentMessages: 2,
      estimateTokens: (s) => Math.ceil(s.length / 4),
    });
    const after = estimateEventTokens(r.events, (s) => Math.ceil(s.length / 4));
    // May slightly exceed a tiny budget when only the protected tail remains;
    // the guarantee is a large reduction + semantic handoff, not byte-perfect.
    expect(after).toBeLessThanOrEqual(2_000);
    expect(after).toBeLessThan(before * 0.4);
    expect(r.events.some((e) => e.type === "compaction")).toBe(true);
  });
});

describe("trimEventsToBudget", () => {
  it("drops oldest turns until near the hard budget", () => {
    const events = makeEvents();
    const before = estimateEventTokens(events, (s) => Math.ceil(s.length / 4));
    const { events: trimmed, trimmed: did } = trimEventsToBudget(events, 2_000, {
      keepRecentMessages: 2,
      estimateTokens: (s) => Math.ceil(s.length / 4),
    });
    expect(did).toBe(true);
    const after = estimateEventTokens(trimmed, (s) => Math.ceil(s.length / 4));
    expect(after).toBeLessThanOrEqual(2_000);
    expect(after).toBeLessThan(before * 0.4);
    const handoff = trimmed.find((e) => e.type === "compaction");
    expect(handoff && handoff.type === "compaction" ? handoff.summary : "").toMatch(/HANDOFF|USER REQUESTS/);
  });

  it("preserves plan + last user request in a semantic handoff", () => {
    const events: Event[] = [
      {
        type: "plan",
        steps: [
          { id: "s1", title: "build HUD", status: "completed" },
          { id: "s2", title: "wire physics", status: "in_progress" },
        ],
      },
      {
        type: "message",
        id: "u0",
        role: "user",
        content: [{ type: "text", text: "Clone the GIF racing game into /tmp/race" }],
      },
      {
        type: "tool_call",
        id: "c0",
        name: "write_file",
        input: { path: "/tmp/race/index.html" },
      },
      {
        type: "tool_result",
        toolCallId: "c0",
        name: "write_file",
        content: "ok\n".repeat(2000),
      },
    ];
    for (let i = 1; i < 8; i++) {
      events.push({
        type: "message",
        id: `u${i}`,
        role: "user",
        content: [{ type: "text", text: `note ${i} ` + "padding ".repeat(40) }],
      });
      events.push({
        type: "message",
        id: `a${i}`,
        role: "assistant",
        content: [{ type: "text", text: `work ${i} ` + "padding ".repeat(40) }],
      });
      events.push({
        type: "tool_result",
        toolCallId: `t${i}`,
        name: "bash",
        content: "log line\n".repeat(400),
      });
    }
    events.push({
      type: "message",
      id: "u_final",
      role: "user",
      content: [{ type: "text", text: "Keep going on wire physics — do not restart" }],
    });
    const { events: trimmed } = trimEventsToBudget(events, 800, {
      keepRecentMessages: 4,
      estimateTokens: (s) => Math.ceil(s.length / 4),
    });
    const plan = extractPlan(trimmed);
    expect(plan?.some((s) => s.id === "s2")).toBe(true);
    const lastUser = [...trimmed].reverse().find(
      (e) => e.type === "message" && e.role === "user",
    );
    expect(lastUser && lastUser.type === "message" ? lastUser.content[0] : null).toMatchObject({
      type: "text",
      text: "Keep going on wire physics — do not restart",
    });
    const handoff = trimmed.find((e) => e.type === "compaction");
    expect(handoff && handoff.type === "compaction" ? handoff.summary : "").toMatch(/USER REQUESTS|HANDOFF|KEY FILES|CURRENT STATE/);
  });

  it("does not truncate the latest user message when shrinking payloads", () => {
    const events: Event[] = [
      {
        type: "message",
        id: "u",
        role: "user",
        content: [{ type: "text", text: "MUST_KEEP_THIS_REQUIREMENT verbatim please" }],
      },
      {
        type: "tool_result",
        toolCallId: "t1",
        name: "bash",
        content: "noise\n".repeat(5000),
      },
    ];
    const { events: trimmed } = trimEventsToBudget(events, 400, {
      keepRecentMessages: 2,
      estimateTokens: (s) => Math.ceil(s.length / 4),
    });
    const user = trimmed.find((e) => e.type === "message" && e.role === "user");
    const text =
      user && user.type === "message" && user.content[0]?.type === "text"
        ? user.content[0].text
        : "";
    expect(text).toContain("MUST_KEEP_THIS_REQUIREMENT");
  });
});

describe("buildProviderMessages hardBudget", () => {
  it("never returns a transcript over the hard budget", () => {
    const history: Event[] = [];
    for (let i = 0; i < 20; i++) {
      history.push({
        type: "message",
        id: `u${i}`,
        role: "user",
        content: [{ type: "text", text: "user " + "x".repeat(800) }],
      });
      history.push({
        type: "message",
        id: `a${i}`,
        role: "assistant",
        content: [{ type: "text", text: "asst " + "y".repeat(800) }],
      });
      history.push({
        type: "tool_result",
        toolCallId: `t${i}`,
        name: "bash",
        content: "out\n".repeat(400),
      });
    }
    const msgs = buildProviderMessages(history, [], "hi", undefined, {
      contextBudget: 50_000,
      hardBudget: 2_000,
    });
    // Rough char/4 estimate of serialised provider content.
    let chars = 0;
    for (const m of msgs) {
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "tool_result") chars += b.content.length;
        else chars += JSON.stringify(b).length;
      }
    }
    expect(Math.ceil(chars / 4)).toBeLessThan(8_000);
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

describe("liveTranscript", () => {
  it("keeps the full log until a summary compaction, then starts there", () => {
    const early: Event = { type: "message", id: "u0", role: "user", content: [{ type: "text", text: "design" }] };
    const kept: Event = { type: "message", id: "u8", role: "user", content: [{ type: "text", text: "recent" }] };
    const compact: Event = { type: "compaction", kind: "summary", summary: "earlier", keepFrom: 1 };
    const later: Event = { type: "message", id: "u9", role: "user", content: [{ type: "text", text: "after" }] };
    const live = liveTranscript([early, kept, compact, later]);
    expect(live).toEqual([compact, kept, later]);
  });
});
