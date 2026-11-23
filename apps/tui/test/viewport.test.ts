import { describe, expect, it } from "vitest";

import {
  rowsInWindow,
  rowAtLine,
  rowAtScreenY,
  totalHeight,
  viewportWindow,
} from "../src/ui/viewport.js";

const heights = [3, 5, 2, 10];

describe("viewportWindow", () => {
  it("shows the last `height` lines while following the live edge", () => {
    const win = viewportWindow(heights, 6, 0);
    expect(totalHeight(heights)).toBe(20);
    expect(win.endLine).toBe(20);
    expect(win.startLine).toBe(14);
    expect(win.below).toBe(0);
    expect(win.above).toBe(14);
  });

  it("clamps scroll to the content and reports what is hidden below", () => {
    const win = viewportWindow(heights, 6, 999);
    expect(win.startLine).toBe(0);
    expect(win.endLine).toBe(6);
    expect(win.below).toBe(14);
    expect(win.maxScroll).toBe(14);
  });

  it("leaves no dead scroll range when the content is shorter than the window", () => {
    const win = viewportWindow([2, 2], 10, 0);
    expect(win.maxScroll).toBe(0);
    expect(win.startLine).toBe(0);
    expect(win.endLine).toBe(4);
    expect(win.below).toBe(0);
  });

  it("treats a zero-height row as one line so rows never disappear", () => {
    expect(totalHeight([0, 0])).toBe(2);
  });
});

describe("rowsInWindow", () => {
  it("returns the rows intersecting the window", () => {
    // lines: [0..3) [3..8) [8..10) [10..20)
    expect(rowsInWindow(heights, 3, 9)).toMatchObject({ start: 1, end: 3, offset: 0 });
  });

  it("reports how many lines of the first row are scrolled off", () => {
    expect(rowsInWindow(heights, 5, 12)).toMatchObject({ start: 1, end: 4, offset: 2 });
  });

  it("returns an empty window past the end", () => {
    expect(rowsInWindow(heights, 40, 50)).toMatchObject({ start: 4, end: 4 });
  });
});

describe("rowAtLine / rowAtScreenY", () => {
  it("maps a line to its row", () => {
    expect(rowAtLine(heights, 0)).toBe(0);
    expect(rowAtLine(heights, 2)).toBe(0);
    expect(rowAtLine(heights, 3)).toBe(1);
    expect(rowAtLine(heights, 9)).toBe(2);
    expect(rowAtLine(heights, 99)).toBe(-1);
  });

  it("maps a screen line through the window offset", () => {
    const win = viewportWindow(heights, 6, 0);
    expect(win.startLine).toBe(14);
    // Line 14 is inside row 3 (which spans 10..20).
    expect(rowAtScreenY(heights, win, 0)).toBe(3);
    expect(rowAtScreenY(heights, win, -1)).toBe(-1);
  });
});
