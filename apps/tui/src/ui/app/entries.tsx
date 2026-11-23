/**
 * Transcript → viewport entries.
 *
 * The viewport needs one entry per focusable thing plus its height. Rows holding
 * sub-agent runs contribute each run as its own entry, so a run can be focused
 * and opened on its own instead of being buried in a fixed-size preview.
 */
import React from "react";
import { Box } from "ink";

import { SubagentRunView, TranscriptItem, defaultOpen, isCollapsibleRow, isVisibleRow } from "../TranscriptView.js";
import type { ViewportEntry } from "../TranscriptViewport.js";
import { isOpen, type InteractionState } from "../interaction.js";
import { totalHeight, viewportWindow } from "../viewport.js";
import type { Row, SubagentRun } from "../state.js";
import { rowHeight } from "./helpers.js";

/** The welcome card is a fixed shape: border, four labelled lines, hint. */
const WELCOME_HEIGHT = 10;
/** A sub-agent entry: objective, a tail of steps, and a footer. */
const SUBAGENT_HEIGHT = 7;

export interface TranscriptEntry extends ViewportEntry {
  /** Whether ↑/↓ stops here. */
  interactive: boolean;
  /** How the entry currently renders, so ↵ can flip it. */
  open: boolean;
  /** Set when ↵ should open this sub-agent run. */
  drill?: { key: string; run: number };
}

export interface BuildEntriesArgs {
  rows: readonly Row[];
  keys: readonly string[];
  cols: number;
  interaction: InteractionState;
  welcome: React.ReactElement;
  /** First row index still streaming; those render in live mode. */
  liveFrom: number;
  /** Cap for streaming text, so one long answer cannot fill the viewport. */
  liveMaxLines: number;
}

export function buildTranscriptEntries({
  rows,
  keys,
  cols,
  interaction,
  welcome,
  liveFrom,
  liveMaxLines,
}: BuildEntriesArgs): TranscriptEntry[] {
  const out: TranscriptEntry[] = [
    {
      key: "welcome",
      height: WELCOME_HEIGHT,
      interactive: false,
      open: true,
      render: () => <Box paddingX={1}>{welcome}</Box>,
    },
  ];

  rows.forEach((row, i) => {
    if (!isVisibleRow(row)) return;
    const key = keys[i]!;
    const live = i >= liveFrom;
    const open = isOpen(interaction, key, defaultOpen(row));
    const focused = interaction.focus === out.length;
    const runs = row.kind === "tool" ? (row.tool.subagents ?? []) : [];
    // Sub-agent runs are their own rows, so the parent card must not print them.
    const nested = runs.length > 0;
    out.push({
      key,
      height: rowHeight(row, cols, { open, focused }),
      interactive: isCollapsibleRow(row),
      open,
      render: () => (
        <Box paddingX={1} flexDirection="column">
          <TranscriptItem
            row={row}
            live={live}
            view={{ open, focused, runsNested: nested }}
            maxLines={liveMaxLines}
          />
        </Box>
      ),
    });

    // Runs are always listed, even under a collapsed parent: a finished task card
    // folds to one line, so gating this on the parent's open state would make a
    // sub-agent unreachable the moment it completed.
    for (const run of runs) {
      const childFocused = interaction.focus === out.length;
      out.push({
        key: `${key}#sa${run.index}`,
        height: SUBAGENT_HEIGHT,
        interactive: true,
        open: false,
        drill: { key, run: run.index },
        render: () => (
          <Box paddingLeft={3} paddingRight={1}>
            <SubagentRunView
              run={run}
              multi={runs.length > 1}
              live={run.state === "running"}
              open={childFocused}
              focused={childFocused}
              drillable
            />
          </Box>
        ),
      });
    }
  });

  return out;
}

/** Indices ↑/↓ may land on. */
function focusable(entries: readonly TranscriptEntry[]): number[] {
  const out: number[] = [];
  entries.forEach((e, i) => {
    if (e.interactive || e.drill) out.push(i);
  });
  return out;
}

/** Next focusable entry in `delta` direction, wrapping. -1 when there is none. */
export function nextFocusable(
  entries: readonly TranscriptEntry[],
  from: number,
  delta: number,
): number {
  const candidates = focusable(entries);
  if (candidates.length === 0) return -1;
  const at = candidates.indexOf(from);
  if (at === -1) return delta > 0 ? candidates[0]! : candidates[candidates.length - 1]!;
  return candidates[(at + delta + candidates.length) % candidates.length]!;
}

/** Newest focusable entry — where Tab should land first. */
export function lastFocusable(entries: readonly TranscriptEntry[]): number {
  const candidates = focusable(entries);
  return candidates.length === 0 ? -1 : candidates[candidates.length - 1]!;
}

/** Sub-agent runs of the tool row with `key`, for the drill-down view. */
export function runsForKey(
  rows: readonly Row[],
  keys: readonly string[],
  key: string,
): readonly SubagentRun[] {
  const i = keys.indexOf(key);
  const row = i >= 0 ? rows[i] : undefined;
  return row && row.kind === "tool" ? (row.tool.subagents ?? []) : [];
}

/** Line offset of an entry from the top of the transcript. */
export function entryTop(heights: readonly number[], index: number): number {
  let start = 0;
  for (let i = 0; i < index && i < heights.length; i++) start += Math.max(1, heights[i]!);
  return start;
}

/**
 * Scroll value that brings `index` fully into the window, moving as little as
 * possible. Returns `scroll` unchanged when it is already visible, so moving the
 * cursor follows it instead of jumping around.
 */
export function scrollToShow(
  heights: readonly number[],
  height: number,
  scroll: number,
  index: number,
): number {
  if (index < 0 || index >= heights.length) return scroll;
  const start = entryTop(heights, index);
  const h = Math.max(1, heights[index]!);
  const total = totalHeight(heights);
  const win = viewportWindow(heights, height, scroll);
  const clamp = (v: number): number => Math.max(0, Math.min(win.maxScroll, v));
  if (start < win.startLine) return clamp(total - start - height);
  if (start + h > win.endLine) {
    // A row taller than the window can never be fully revealed; show as much of
    // it as fits rather than scrolling its own top out of sight.
    return clamp(total - start - Math.min(h, height));
  }
  return scroll;
}
