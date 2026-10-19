/**
 * Scroll-viewport tests: the App-level windowing logic, exercised through
 * the pure pieces (offset clamping + ScrollArea slicing). Ink rendering is
 * covered by the existing component layer; here we pin the math.
 */
import { describe, expect, it } from "vitest";
import type { Row } from "../src/ui/state.js";

// Mirror of the slicing math in App.tsx's ScrollArea.
const WINDOW = 100;
const MAX_RENDERED_ROWS = 500;

function sliceRows(rows: Row[], offset: number): { start: number; end: number; visible: Row[] } {
  const capped =
    rows.length > MAX_RENDERED_ROWS ? rows.slice(rows.length - MAX_RENDERED_ROWS) : rows;
  const end = Math.max(1, capped.length - offset);
  const start = Math.max(0, end - WINDOW);
  return { start, end, visible: capped.slice(start, end) };
}

function clampOffset(offset: number, rowCount: number): number {
  return Math.min(Math.max(0, offset), Math.max(0, rowCount - 1));
}

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ kind: "user", id: `r${i}`, text: `row ${i}` }));
}

describe("scroll viewport math", () => {
  it("offset 0 renders the tail (live edge)", () => {
    const rows = makeRows(250);
    const { visible } = sliceRows(rows, 0);
    expect(visible).toHaveLength(WINDOW);
    expect((visible[visible.length - 1] as { text: string }).text).toBe("row 249");
  });

  it("offset N shifts the window up by N rows", () => {
    const rows = makeRows(250);
    const { visible } = sliceRows(rows, 30);
    expect((visible[visible.length - 1] as { text: string }).text).toBe("row 219");
    expect(visible).toHaveLength(WINDOW);
  });

  it("huge offset pins the window at the top", () => {
    const rows = makeRows(250);
    const clamped = clampOffset(10_000, rows.length);
    const { start, visible } = sliceRows(rows, clamped);
    expect(start).toBe(0);
    expect((visible[0] as { text: string }).text).toBe("row 0");
  });

  it("short transcripts render fully regardless of offset", () => {
    const rows = makeRows(12);
    const { visible } = sliceRows(rows, 0);
    expect(visible).toHaveLength(12);
  });

  it("clamps negative and overflowing offsets", () => {
    expect(clampOffset(-5, 100)).toBe(0);
    expect(clampOffset(500, 100)).toBe(99);
    expect(clampOffset(0, 0)).toBe(0);
  });
});
