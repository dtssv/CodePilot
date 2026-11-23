/**
 * Viewport math for the transcript.
 *
 * Rows are variable height, so everything here works in *lines* and converts to
 * row indices with a prefix sum. `scroll` counts lines scrolled up from the live
 * edge, which makes PgUp/PgDn and the wheel exact regardless of row heights.
 */

export interface ViewportWindow {
  /** First visible line, inclusive. */
  startLine: number;
  /** Last visible line, exclusive. */
  endLine: number;
  /** Lines hidden above the window. */
  above: number;
  /** Lines hidden below the window (0 while following the live edge). */
  below: number;
  /** Largest legal `scroll` for this content. */
  maxScroll: number;
  totalLines: number;
}

export function totalHeight(heights: readonly number[]): number {
  let n = 0;
  for (const h of heights) n += Math.max(1, h);
  return n;
}

export function viewportWindow(heights: readonly number[], height: number, scroll: number): ViewportWindow {
  const total = totalHeight(heights);
  const maxScroll = Math.max(0, total - Math.max(1, height));
  const clamped = Math.max(0, Math.min(maxScroll, Math.round(scroll)));
  const endLine = Math.max(0, total - clamped);
  const startLine = Math.max(0, endLine - Math.max(1, height));
  return {
    startLine,
    endLine,
    above: startLine,
    below: total - endLine,
    maxScroll,
    totalLines: total,
  };
}

export interface RowWindow {
  /** First row index to render, inclusive. */
  start: number;
  /** Last row index to render, exclusive. */
  end: number;
  /** Lines to blank above the first row (it is partially scrolled off). */
  offset: number;
}

/** Rows intersecting `[startLine, endLine)`. */
export function rowsInWindow(heights: readonly number[], startLine: number, endLine: number): RowWindow {
  let line = 0;
  let start = -1;
  let offset = 0;
  let end = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = Math.max(1, heights[i]!);
    const rowStart = line;
    const rowEnd = line + h;
    if (start === -1 && rowEnd > startLine) {
      start = i;
      offset = Math.max(0, Math.min(h - 1, startLine - rowStart));
    }
    if (rowStart < endLine) end = i + 1;
    line = rowEnd;
  }
  if (start === -1) return { start: heights.length, end: heights.length, offset: 0 };
  return { start, end, offset };
}

/** Row index whose line range contains `line`, or -1. */
export function rowAtLine(heights: readonly number[], line: number): number {
  let acc = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = Math.max(1, heights[i]!);
    if (line >= acc && line < acc + h) return i;
    acc += h;
  }
  return -1;
}

/**
 * Map a screen row inside the viewport to a transcript row index.
 * `screenY` is 0-based and relative to the viewport's first line.
 */
export function rowAtScreenY(
  heights: readonly number[],
  window: ViewportWindow,
  screenY: number,
): number {
  if (screenY < 0) return -1;
  return rowAtLine(heights, window.startLine + screenY);
}
