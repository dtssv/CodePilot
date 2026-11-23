/**
 * Command palette — fuzzy-searchable command picker. Opened via Ctrl+K (empty
 * query) or `/` as the first input char (rest of line is the live query). Keys
 * while open: ↑/↓ or Ctrl+P/N move, Tab complete name (no run), Enter accept
 * and run, Esc close, typing refines. Pure controlled component: the parent
 * (InputBox) owns all key handling, so input focus logic stays in one place.
 */
import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "./theme.js";
import type { CommandInfo } from "./commands.js";
import { filterCommands } from "./palette.js";

export interface CommandPaletteProps {
 /** Current fuzzy query (text after the `/` or after Ctrl+K). */
  query: string;
 /** Full command list (built-ins + custom). */
  commands: readonly CommandInfo[];
 /** Currently selected index into the *filtered* list. */
  selected: number;
 /** Terminal rows available for the menu (we show at most maxRows). */
  maxRows?: number;
}

export interface PaletteState {
  filtered: readonly CommandInfo[];
  selected: number;
}

/** Filter + clamp selection. Pure; exported for tests. */
export function paletteState(
  commands: readonly CommandInfo[],
  query: string,
  selected: number,
): PaletteState {
  const filtered = filterCommands(commands, query);
  const clamped =
    filtered.length === 0 ? 0 : Math.min(Math.max(0, selected), filtered.length - 1);
  return { filtered, selected: clamped };
}

/**
 * Compute the scroll window so the selected row stays visible. Centres the
 * cursor and clamps to the list bounds. Pure; exported for tests.
 */
export function paletteWindow(
  total: number,
  selected: number,
  maxRows: number,
): { start: number; end: number } {
  if (total <= maxRows) return { start: 0, end: total };
  const start = Math.max(0, Math.min(selected - Math.floor(maxRows / 2), total - maxRows));
  return { start, end: start + maxRows };
}

export function CommandPalette(props: CommandPaletteProps): React.ReactElement {
  const { query, commands, selected, maxRows = 10 } = props;
  const { filtered, selected: sel } = paletteState(commands, query, selected);

  // Scroll the window to keep the selected row visible: centre the cursor and
  // clamp to the list bounds, so moving past maxRows follows the selection.
  const { start: windowStart, end: windowEnd } = paletteWindow(filtered.length, sel, maxRows);
  const windowed = filtered.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = filtered.length - windowEnd;
  // The box keeps a constant row count. The "n more" rows used to appear and
  // disappear as the selection crossed the window edge, which changed the box
  // height by a line mid-list; Ink repaints only what moved, so a step left a
  // stale blank row and the next appeared to skip an entry. The counts live in
  // the title row instead and the body is padded, so the height never changes
  // while the selection moves.
  const bodyRows = Math.min(maxRows, Math.max(filtered.length, 1));
  const padRows = Math.max(0, bodyRows - windowed.length);
  const overflow = hiddenAbove + hiddenBelow > 0 ? `${sel + 1}/${filtered.length}` : "";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color.accent}
      paddingX={1}
      marginBottom={0}
    >
      <Box flexShrink={0}>
        <Text color={color.accent}>{glyph.logo} </Text>
        <Text bold>Command</Text>
        <Text color={color.faint}>{query === "" ? " — type to filter" : ` — ${query}`}</Text>
        {overflow ? <Text color={color.info}>{`  ${overflow}`}</Text> : null}
        <Box flexGrow={1} />
        <Text color={color.faint} wrap="truncate-end">
          ↑↓ select · Tab complete · ↵ run · esc close
        </Text>
      </Box>
      {filtered.length === 0 ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text color={color.faint}>No matching command. Try /help.</Text>
          {Array.from({ length: Math.max(0, padRows - 1) }, (_, i) => (
            <Text key={`pad-${i}`}> </Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          {windowed.map((c, i) => {
            const idx = windowStart + i;
            const isSel = idx === sel;
            return (
              // Every row is exactly one line: a description long enough to wrap
              // added a line the parent box then clipped, which shifted the rows
              // below it and made an entry appear to vanish as the selection
              // moved. Truncation keeps the row count equal to maxRows.
              <Box key={c.name} flexShrink={0}>
                <Text color={isSel ? color.accent : color.faint} wrap="truncate-end">
                  {isSel ? "▸ " : "  "}
                </Text>
                <Text bold={isSel} color={isSel ? color.accent : undefined} wrap="truncate-end">
                  /{c.name}
                </Text>
                {c.args ? (
                  <Text color={color.info} wrap="truncate-end">
                    {" "}
                    {c.args}
                  </Text>
                ) : null}
                <Text color={color.faint} wrap="truncate-end">
                  {"  "}
                  {c.description}
                </Text>
              </Box>
            );
          })}
          {/* Padding keeps the body height fixed while the window slides. */}
          {Array.from({ length: padRows }, (_, i) => (
            <Text key={`pad-${i}`}> </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
