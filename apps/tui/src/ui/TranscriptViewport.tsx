/**
 * Scrolling transcript viewport.
 *
 * Replaces `Ink`'s `<Static>`. Rows printed through `<Static>` were flushed into
 * the terminal's own scrollback, which made them immutable (opening a card would
 * have required wiping the scrollback) and impossible to hit-test. Here every row
 * stays mounted inside a fixed-height box: rows can open and close, take focus,
 * and receive clicks, and scrolling is ours to drive.
 *
 * Rows are variable height, so each rendered row reports its measured height back
 * to the owner. Estimates alone would let a row whose real height came out shorter
 * than its guess scroll completely out of the clip, leaving a blank gap.
 */
import React from "react";
import { Box, Text, measureElement, type DOMElement } from "ink";

import { color, glyph } from "./theme.js";
import { rowsInWindow, viewportWindow, type ViewportWindow } from "./viewport.js";

export interface ViewportEntry {
  /** Stable identity (row key). */
  key: string;
  /** Estimated height, used until the row has been measured once. */
  height: number;
  render(): React.ReactElement;
}

export interface TranscriptViewportProps {
  entries: readonly ViewportEntry[];
  /** Resolved height per entry (measured where known). Same order as `entries`. */
  heights: readonly number[];
  /** Total lines the viewport may occupy. */
  height: number;
  /** Lines scrolled up from the live edge. */
  scroll: number;
  /** Reports real heights so the owner's layout math matches what is on screen. */
  onMeasure(next: ReadonlyMap<string, number>): void;
}

export interface ViewportLayout {
  window: ViewportWindow;
  /** Index of the first entry to render. */
  start: number;
  /** One past the last entry to render. */
  end: number;
  /** Lines of the first rendered entry that sit above the window. */
  offset: number;
  /** Screen line (0-based, inside the viewport) where the body begins. */
  bodyTop: number;
  bodyHeight: number;
  header: string | undefined;
  footer: string | undefined;
}

/** Pure layout math, shared by rendering and click hit-testing. */
export function viewportLayout(
  heights: readonly number[],
  height: number,
  scroll: number,
): ViewportLayout {
  const win = viewportWindow(heights, height, scroll);
  const header =
    win.above > 0
      ? `${glyph.arrow} ${win.above} ${win.above === 1 ? "line" : "lines"} above ${glyph.dot} PgDn to follow`
      : undefined;
  const footer = win.below > 0 ? `PgDn ${glyph.arrow} ${win.below} ${win.below === 1 ? "line" : "lines"} below` : undefined;
  const bodyTop = header ? 1 : 0;
  const bodyHeight = Math.max(1, height - bodyTop - (footer ? 1 : 0));
  const rows = rowsInWindow(heights, win.startLine, win.endLine);
  return { window: win, start: rows.start, end: rows.end, offset: rows.offset, bodyTop, bodyHeight, header, footer };
}

/**
 * Entry index under a viewport-local screen line, or -1.
 *
 * `screenY` is 0-based from the viewport's first line. A partially visible row at
 * the top still counts as a hit, which is what clicking it should do.
 */
export function entryAtScreenY(
  heights: readonly number[],
  layout: ViewportLayout,
  screenY: number,
): number {
  const local = screenY - layout.bodyTop;
  if (local < 0 || local >= layout.bodyHeight) return -1;
  const target = layout.window.startLine + local;
  let line = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = Math.max(1, heights[i]!);
    if (target >= line && target < line + h) {
      return i >= layout.start && i < layout.end ? i : -1;
    }
    line += h;
  }
  return -1;
}

export function TranscriptViewport({
  entries,
  heights,
  height,
  scroll,
  onMeasure,
}: TranscriptViewportProps): React.ReactElement {
  const layout = viewportLayout(heights, height, scroll);
  const visible = entries.slice(layout.start, layout.end);
  const nodes = React.useRef(new Map<string, DOMElement>());

  // Runs after every render (no dep array): a row's height changes when its
  // content does, and the owner needs that to keep the window honest.
  React.useEffect(() => {
    const next = new Map<string, number>();
    for (const [key, node] of nodes.current) {
      const h = measureElement(node).height;
      if (h > 0) next.set(key, h);
    }
    if (next.size > 0) onMeasure(next);
  });

  return (
    <Box flexDirection="column" height={height} width="100%" overflow="hidden">
      {layout.header ? (
        <Box paddingX={1}>
          <Text color={color.warn} wrap="truncate-end">
            {layout.header}
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column" height={layout.bodyHeight} width="100%" overflow="hidden">
        {visible.map((entry, i) => (
          <Box
            key={entry.key}
            ref={(node: DOMElement | null) => {
              if (node) nodes.current.set(entry.key, node);
              else nodes.current.delete(entry.key);
            }}
            flexDirection="column"
            flexShrink={0}
            // The first visible row starts above the window; a negative margin
            // lifts it so the clip cuts its top instead of pushing it out.
            {...(i === 0 && layout.offset > 0 ? { marginTop: -layout.offset } : {})}
          >
            {entry.render()}
          </Box>
        ))}
      </Box>
      {layout.footer ? (
        <Box paddingX={1}>
          <Text color={color.warn} wrap="truncate-end">
            {layout.footer}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
