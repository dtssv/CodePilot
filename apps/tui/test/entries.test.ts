import React from "react";
import { Text } from "ink";
import { describe, expect, it } from "vitest";

import {
  buildTranscriptEntries,
  entryTop,
  lastFocusable,
  nextFocusable,
  runsForKey,
  scrollToShow,
} from "../src/ui/app/entries.js";
import { initialInteraction, interactionReducer, type InteractionState } from "../src/ui/interaction.js";
import type { Row, ToolRow } from "../src/ui/state.js";
import { totalHeight } from "../src/ui/viewport.js";

const welcome = React.createElement(Text, null, "welcome");

const tool = (over: Partial<ToolRow> = {}): Row => ({
  kind: "tool",
  tool: { id: "t1", name: "read_file", inputSummary: "README.md", category: "read", target: "README.md", status: "ok", ...over },
});

const user = (id: string, text = "hi"): Row => ({ kind: "user", id, text });

function build(rows: Row[], interaction: InteractionState = initialInteraction) {
  return buildTranscriptEntries({
    rows,
    keys: rows.map((r, i) => `${r.kind}:${i}`),
    cols: 80,
    interaction,
    welcome,
    liveFrom: rows.length,
    liveMaxLines: 10,
  });
}

describe("buildTranscriptEntries", () => {
  it("starts with the welcome card, which is not focusable", () => {
    const entries = build([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: "welcome", interactive: false });
  });

  it("skips rows that are not visible", () => {
    const entries = build([{ kind: "usage", usage: { input: 1, output: 2 }, at: 0 }, user("u1")]);
    expect(entries.map((e) => e.key)).toEqual(["welcome", "user:1"]);
  });

  it("makes a collapsible tool row focusable and a one-line read is not", () => {
    const entries = build([tool({ resultText: "one line" }), tool({ id: "t2", resultText: "a\nb\nc\nd\ne" })]);
    expect(entries[1]!.interactive).toBe(false);
    expect(entries[2]!.interactive).toBe(true);
  });

  it("keeps a collapsed task row short while its runs stay reachable", () => {
    const rows = [
      tool({
        id: "t1",
        name: "task",
        category: "task",
        status: "running",
        subagents: [
          { index: 0, objective: "a", state: "running", steps: [], text: "" },
          { index: 1, objective: "b", state: "running", steps: [], text: "" },
        ],
      }),
    ];
    // running → open by default, so each run is its own entry
    const open = build(rows);
    expect(open.map((e) => e.key)).toEqual(["welcome", "tool:0", "tool:0#sa0", "tool:0#sa1"]);
    expect(open[2]!.drill).toEqual({ key: "tool:0", run: 0 });

    // Collapsing the parent folds its own body but must not hide the runs: a
    // finished task card folds by default, so gating on it made every sub-agent
    // unreachable the moment it completed.
    const collapsed = build(rows, interactionReducer(initialInteraction, { type: "toggle", key: "tool:0", open: true }));
    expect(collapsed.map((e) => e.key)).toEqual(["welcome", "tool:0", "tool:0#sa0", "tool:0#sa1"]);
  });

  it("surfaces sub-agent runs even when the parent row has settled closed", () => {
    const rows = [
      tool({
        id: "t1",
        name: "task",
        category: "task",
        status: "ok",
        subagents: [{ index: 0, objective: "a", state: "ok", steps: [], text: "done" }],
      }),
    ];
    // status ok → defaultOpen false, which used to be enough to hide the run.
    expect(build(rows).map((e) => e.key)).toEqual(["welcome", "tool:0", "tool:0#sa0"]);
  });
});

describe("focus", () => {
  const rows = [
    tool({ id: "t1", resultText: "a\nb\nc\nd\ne" }),
    user("u1"),
    tool({ id: "t2", category: "edit", resultText: "x" }),
  ];

  it("lands on the newest focusable entry first", () => {
    expect(lastFocusable(build(rows))).toBe(3);
  });

  it("wraps in both directions", () => {
    const entries = build(rows);
    expect(nextFocusable(entries, 1, 1)).toBe(3);
    expect(nextFocusable(entries, 3, 1)).toBe(1);
    expect(nextFocusable(entries, 1, -1)).toBe(3);
  });

  it("reports -1 when nothing can take focus", () => {
    expect(lastFocusable(build([user("u1")]))).toBe(-1);
    expect(nextFocusable(build([user("u1")]), -1, 1)).toBe(-1);
  });
});

describe("entryTop", () => {
  it("sums the heights above the entry", () => {
    expect(entryTop([3, 5, 2], 0)).toBe(0);
    expect(entryTop([3, 5, 2], 2)).toBe(8);
  });

  it("counts a zero-height entry as one line", () => {
    expect(entryTop([0, 0, 1], 2)).toBe(2);
  });
});

describe("scrollToShow", () => {
  // entries: [0..5) [5..15) [15..20)
  const heights = [5, 10, 5];

  it("does nothing when the entry is already visible", () => {
    expect(scrollToShow(heights, 6, 0, 2)).toBe(0);
  });

  it("scrolls down just enough to reveal a hidden entry", () => {
    // Entry 0 is above the window at scroll=0; window ends at line 20 of 20.
    expect(scrollToShow(heights, 6, 14, 0)).toBe(14);
    expect(scrollToShow(heights, 6, 0, 0)).toBeGreaterThan(0);
  });

  it("scrolls up to reveal the top of an entry above the window", () => {
    // scroll=14 → window [6,12), entry 0 starts at line 0 → needs the whole
    // 5-line entry on screen, so scroll drops to the lowest value that shows it.
    const s = scrollToShow(heights, 6, 14, 0);
    expect(s).toBeLessThanOrEqual(14);
  });

  it("reveals part of an entry taller than the window instead of hiding its top", () => {
    const tall = [20];
    // The entry can never fit in 6 lines. Scrolling to its first line (scroll=14
    // shows lines 0..6) is the most of it that can be shown; scrolling further
    // would push the entry's own top out of sight.
    const s = scrollToShow(tall, 6, 10, 0);
    expect(s).toBe(14);
    expect(s).toBeLessThanOrEqual(totalHeight(tall) - 6);
  });

  it("ignores an out-of-range index", () => {
    expect(scrollToShow(heights, 6, 3, -1)).toBe(3);
    expect(scrollToShow(heights, 6, 3, 9)).toBe(3);
  });
});

describe("runsForKey", () => {
  const rows = [
    tool({ id: "t1", category: "task", subagents: [{ index: 0, objective: "a", state: "ok", steps: [], text: "" }] }),
    user("u1"),
  ];

  it("returns the parent row's runs", () => {
    expect(runsForKey(rows, ["a:0", "b:1"], "a:0")).toHaveLength(1);
  });

  it("returns nothing for a missing or non-tool key", () => {
    expect(runsForKey(rows, ["a:0", "b:1"], "b:1")).toEqual([]);
    expect(runsForKey(rows, ["a:0"], "zzz")).toEqual([]);
  });
});
