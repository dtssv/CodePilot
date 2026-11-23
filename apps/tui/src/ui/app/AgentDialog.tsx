/**
 * Sub-agent detail dialog.
 *
 * Opened from a sub-agent row: replaces the transcript pane so the whole run —
 * every step, not the fixed tail the parent row prints — is readable, and shows
 * where the run is up to. Sibling runs stay one arrow key apart. Esc, Enter or
 * Space closes it and returns to the transcript.
 *
 * The box is sized to its content (capped by the pane) rather than filling the
 * pane: a dialog that stretches to the bottom edge reads as empty space, and a
 * finished run only needs a handful of rows.
 */
import React from "react";
import { Box, Text } from "ink";

import type { SubagentRun } from "../state.js";
import { color, formatDuration, glyph, oneLine, shortPath } from "../theme.js";
import { toolLabel, toolSubject } from "../toolDisplay.js";

export interface AgentDialogProps {
  runs: readonly SubagentRun[];
  /** Index into `runs` currently shown. */
  index: number;
  /** Rows available to the dialog, borders included. */
  height: number;
  width: number;
  /** Steps scrolled up from the newest one. 0 follows the run. */
  scroll?: number;
}

const STATE_WORD: Record<SubagentRun["state"], string> = {
  running: "working",
  ok: "done",
  failed: "failed",
  interrupted: "stopped",
};

/** Rows the dialog spends on everything but the step list and conclusion: two
 *  borders, header, objective, meta, the "Progress" heading with its gap, and
 *  the footer with its gap. */
const FIXED_ROWS = 9;

/** Conclusion block cost: its gap plus one row per line. */
function conclusionRows(run: SubagentRun): number {
  const lines = conclusionOf(run).length;
  return lines === 0 ? 0 : lines + 1;
}

function stateColor(state: SubagentRun["state"]): string {
  return state === "running" ? color.accent : state === "ok" ? color.add : color.remove;
}

/** Last lines of the sub-agent's answer, flattened to plain text. */
function conclusionOf(run: SubagentRun): string[] {
  if (!run.text) return [];
  return run.text
    .split("\n")
    .map((l) => l.replace(/\*\*|__|`/g, "").replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .slice(-2);
}

/**
 * Step rows the dialog shows and how far ↑/↓ may scroll. Shared with the key
 * handler so the scroll stops exactly where the list ends.
 */
export function dialogWindow(
  run: SubagentRun | undefined,
  height: number,
): { body: number; maxScroll: number } {
  if (!run) return { body: 0, maxScroll: 0 };
  const body = Math.max(1, height - FIXED_ROWS - conclusionRows(run));
  return { body, maxScroll: Math.max(0, run.steps.length - body) };
}

/**
 * Height the dialog box requests: its content, capped by the pane. A box that
 * stretches to the pane's bottom edge reads as empty space, and a finished run
 * only needs a handful of rows.
 */
function dialogHeight(run: SubagentRun, height: number): number {
  const body = Math.min(Math.max(1, run.steps.length), dialogWindow(run, height).body);
  return Math.min(height, FIXED_ROWS + body + conclusionRows(run));
}

function Sep(): React.ReactElement {
  return <Text color={color.faint}>{` ${glyph.dot} `}</Text>;
}

export function AgentDialog({
  runs,
  index,
  height,
  width,
  scroll = 0,
}: AgentDialogProps): React.ReactElement {
  const run = runs[index];
  if (!run) {
    return (
      <Box paddingX={1}>
        <Text color={color.faint}>This run was cleared. Esc to close.</Text>
      </Box>
    );
  }

  const inner = Math.max(12, width - 4);
  const conclusion = conclusionOf(run);
  const steps = run.steps.length;
  const { body, maxScroll } = dialogWindow(run, height);
  const offset = Math.min(Math.max(0, scroll), maxScroll);
  // A running run is read from its tail: the newest step is what is pending.
  const end = Math.max(0, steps - offset);
  const start = Math.max(0, end - body);
  const visible = run.steps.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = steps - end;
  const ms = run.startedAt ? (run.finishedAt ?? Date.now()) - run.startedAt : 0;
  const tone = stateColor(run.state);
  const seq = run.runSeq ?? run.index + 1;

  const boxHeight = dialogHeight(run, height);

  return (
    <Box paddingX={1}>
      <Box
        flexDirection="column"
        width="100%"
        height={boxHeight}
        borderStyle="round"
        borderColor={color.edge}
        paddingX={1}
        overflow="hidden"
      >
        {/* Every fixed row refuses to shrink. Ink's default flexShrink of 1 lets
            a fixed-height box squeeze them to zero rows on short terminals,
            which silently swallowed the title and the Progress heading. */}
        <Box flexShrink={0}>
          <Text bold color={color.accent}>
            {glyph.logo} sub-agent
          </Text>
          {run.runSeq !== undefined || runs.length > 1 ? (
            <Text bold color={color.info}>
              {" "}
              #{seq}
            </Text>
          ) : null}
          <Box flexGrow={1} />
          <Text color={color.faint}>
            {STATE_WORD[run.state]}
            {runs.length > 1 ? ` ${glyph.dot} ${index + 1}/${runs.length} ←/→` : ""}
          </Text>
        </Box>

        <Box flexShrink={0}>
          <Text wrap="truncate-end">{oneLine(run.objective, inner)}</Text>
        </Box>

        <Box flexShrink={0}>
          <Text color={color.faint}>
            {steps} {steps === 1 ? "step" : "steps"}
            {ms >= 100 ? ` ${glyph.dot} ${formatDuration(ms)}` : ""}
            {run.background ? ` ${glyph.dot} background` : ""}
            {run.sessionId ? ` ${glyph.dot} ${shortPath(run.sessionId)}` : ""}
            {maxScroll > 0 ? ` ${glyph.dot} ${offset}/${maxScroll} scrolled` : ""}
          </Text>
        </Box>

        <Box marginTop={1} flexShrink={0}>
          <Text bold color={color.faint}>
            Progress
          </Text>
        </Box>

        <Box flexDirection="column">
          {hiddenAbove > 0 ? (
            <Text color={color.faint}>
              {glyph.arrow} {hiddenAbove} earlier {hiddenAbove === 1 ? "step" : "steps"}
            </Text>
          ) : null}
          {visible.map((s, i) => {
            const active = s.status === "running";
            const last = active && i === visible.length - 1;
            const mark = s.status === "error" ? glyph.fail : active ? glyph.active : glyph.ok;
            const tint = s.status === "error" ? color.remove : active ? color.accent : color.add;
            return (
              <Text key={s.id} wrap="truncate-end">
                <Text color={last ? color.accent : color.faint}>{last ? `${glyph.arrow} ` : "  "}</Text>
                <Text color={tint}>{mark} </Text>
                <Text bold={active} color={active ? undefined : color.faint}>
                  {toolLabel(s)}
                </Text>
                <Text color={color.faint}> {oneLine(toolSubject(s), Math.max(12, inner - 22))}</Text>
              </Text>
            );
          })}
          {steps === 0 ? (
            <Text color={color.faint}>
              {run.state === "running" ? "waiting for the first step…" : "no steps recorded"}
            </Text>
          ) : null}
          {hiddenBelow > 0 ? (
            <Text color={color.faint}>
              {glyph.arrow} {hiddenBelow} newer{" "}
              {hiddenBelow === 1 ? "step — ↓ to follow" : "steps — ↓ to follow"}
            </Text>
          ) : null}
        </Box>

        {conclusion.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {conclusion.map((l, i) => (
              <Text
                key={i}
                wrap="truncate-end"
                color={run.state === "running" ? color.faint : undefined}
              >
                {oneLine(l, inner)}
              </Text>
            ))}
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Text color={color.faint}>
            esc close
            <Sep />
            ←/→ switch run
            {maxScroll > 0 ? (
              <>
                <Sep />
                ↑↓ scroll
              </>
            ) : null}
          </Text>
        </Box>
        <Box flexGrow={1} />
      </Box>
    </Box>
  );
}
