import { describe, expect, it } from "vitest";

import {
  initialInteraction,
  interactionReducer,
  isOpen,
  type InteractionState,
} from "../src/ui/interaction.js";

const open = (s: InteractionState, key: string, byDefault = false): boolean => isOpen(s, key, byDefault);

describe("toggle", () => {
  it("opens a row that renders closed", () => {
    const s = interactionReducer(initialInteraction, { type: "toggle", key: "t:1", open: false });
    expect(open(s, "t:1")).toBe(true);
  });

  it("closes a row that renders open by default", () => {
    // A plan row defaults open, so the first press must close it rather than no-op.
    const s = interactionReducer(initialInteraction, { type: "toggle", key: "plan:1", open: true });
    expect(open(s, "plan:1", true)).toBe(false);
    expect(open(s, "plan:1", false)).toBe(false);
  });

  it("round-trips", () => {
    let s = interactionReducer(initialInteraction, { type: "toggle", key: "t:1", open: false });
    s = interactionReducer(s, { type: "toggle", key: "t:1", open: true });
    expect(open(s, "t:1")).toBe(false);
    s = interactionReducer(s, { type: "toggle", key: "t:1", open: false });
    expect(open(s, "t:1")).toBe(true);
  });

  it("does not leak state between rows", () => {
    const s = interactionReducer(initialInteraction, { type: "toggle", key: "t:1", open: false });
    expect(open(s, "t:2")).toBe(false);
    expect(open(s, "t:2", true)).toBe(true);
  });
});

describe("scroll", () => {
  it("clamps to [0, max]", () => {
    let s = interactionReducer(initialInteraction, { type: "scroll", delta: 5, max: 10 });
    expect(s.scroll).toBe(5);
    s = interactionReducer(s, { type: "scroll", delta: 100, max: 10 });
    expect(s.scroll).toBe(10);
    s = interactionReducer(s, { type: "scroll", delta: -100, max: 10 });
    expect(s.scroll).toBe(0);
  });

  it("resets when entering and leaving a sub-agent", () => {
    let s = interactionReducer(initialInteraction, { type: "scroll", delta: 7, max: 10 });
    s = interactionReducer(s, { type: "enter", key: "t:1", run: 0 });
    expect(s.scroll).toBe(0);
    expect(s.viewing).toEqual({ key: "t:1", run: 0 });
    expect(s.focus).toBe(-1);
    s = interactionReducer(s, { type: "back" });
    expect(s.viewing).toBeUndefined();
    expect(s.scroll).toBe(0);
  });
});

describe("sub-agent switching", () => {
  const viewing = interactionReducer(initialInteraction, { type: "enter", key: "t:1", run: 0 });

  it("wraps forward and backward", () => {
    expect(interactionReducer(viewing, { type: "run", delta: 1, count: 3 }).viewing?.run).toBe(1);
    expect(interactionReducer(viewing, { type: "run", delta: -1, count: 3 }).viewing?.run).toBe(2);
  });

  it("is a no-op when no run is open", () => {
    expect(interactionReducer(initialInteraction, { type: "run", delta: 1, count: 3 })).toBe(
      initialInteraction,
    );
  });
});
