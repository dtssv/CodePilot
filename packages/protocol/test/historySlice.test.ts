import { describe, expect, it } from "vitest";
import type { Event } from "@codepilot/core";
import { sliceHistoryBefore, sliceHistoryTail } from "../src/server.js";

function msg(role: "user" | "assistant", text: string): Event {
  return {
    type: "message",
    id: `${role}-${text}`,
    role,
    content: [{ type: "text", text }],
  };
}

describe("sliceHistoryTail", () => {
  it("returns the full history when under the limit", () => {
    const events = [msg("user", "a"), msg("assistant", "b")];
    expect(sliceHistoryTail(events, 10)).toEqual({
      events,
      historyTruncated: false,
    });
  });

  it("truncates to a user-message boundary near the tail", () => {
    const events: Event[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(msg("user", `u${i}`), msg("assistant", `a${i}`));
    }
    // 20 events; limit 5 → raw start at index 15 (assistant a7). Prefer the
    // preceding user message at index 14 (u7).
    const sliced = sliceHistoryTail(events, 5);
    expect(sliced.historyTruncated).toBe(true);
    expect(sliced.historyBefore).toBe(14);
    expect(sliced.events[0]).toMatchObject({ type: "message", role: "user" });
    expect(sliced.events.length).toBe(6); // u7 + a7 + u8 + a8 + u9 + a9
  });

  it("limit 0 returns the full history", () => {
    const events = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    expect(sliceHistoryTail(events, 0).historyTruncated).toBe(false);
    expect(sliceHistoryTail(events, 0).events).toHaveLength(3);
  });
});

describe("sliceHistoryBefore", () => {
  it("returns the older page ending at before", () => {
    const events: Event[] = [];
    for (let i = 0; i < 6; i++) {
      events.push(msg("user", `u${i}`), msg("assistant", `a${i}`));
    }
    // before=8 → events[0..8); with limit 4 prefer user boundary.
    const page = sliceHistoryBefore(events, 8, 4);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.every((e) => events.includes(e))).toBe(true);
    expect(page.events.at(-1)).toBe(events[7]);
  });

  it("reports no truncation at the start of history", () => {
    const events = [msg("user", "a"), msg("assistant", "b")];
    const page = sliceHistoryBefore(events, 2, 10);
    expect(page.historyTruncated).toBe(false);
    expect(page.events).toHaveLength(2);
  });
});
