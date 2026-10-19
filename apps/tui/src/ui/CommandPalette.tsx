/**
 * Command palette — fuzzy-searchable command picker.
 *
 * Opened two ways:
 * 1. Ctrl+K anywhere (opens with an empty query),
 * 2. typing `/` as the first character of the input (opens with the text
 * after `/` as the live query — replaces the old prefix-only dropdown).
 *
 * Keys while open:
 * ↑/↓ or Ctrl+P/Ctrl+N move selection
 * Tab complete the command name into the input (no run)
 * Enter accept and run (or leave `/name ` for required args)
 * Esc close (and restore the pre-palette input)
 * typing refines the fuzzy query
 *
 * The palette is a pure controlled component: it owns no key handling of
 * its own — the parent (InputBox) feeds it keys and asks it to render.
 * That keeps all input focus logic in one place.
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

export function CommandPalette(props: CommandPaletteProps): React.ReactElement {
  const { query, commands, selected, maxRows = 10 } = props;
  const { filtered, selected: sel } = paletteState(commands, query, selected);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color.accent}
      paddingX={1}
      marginBottom={0}
    >
      <Box>
        <Text color={color.accent}>{glyph.logo} </Text>
        <Text bold>Command</Text>
        <Text color={color.faint}>{query === "" ? " — type to filter" : ` — ${query}`}</Text>
        <Box flexGrow={1} />
        <Text color={color.faint}>↑↓ select · Tab complete · ↵ run · esc close</Text>
      </Box>
      {filtered.length === 0 ? (
        <Box marginTop={1}>
          <Text color={color.faint}>No matching command. Try /help.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {filtered.slice(0, maxRows).map((c, i) => {
            const isSel = i === sel;
            return (
              <Box key={c.name}>
                <Text color={isSel ? color.accent : color.faint}>
                  {isSel ? "▸ " : "  "}
                </Text>
                <Text bold={isSel} color={isSel ? color.accent : undefined}>
                  /{c.name}
                </Text>
                {c.args ? <Text color={color.info}> {c.args}</Text> : null}
                <Text color={color.faint}>  {c.description}</Text>
              </Box>
            );
          })}
          {filtered.length > maxRows ? (
            <Text color={color.faint}>  … {filtered.length - maxRows} more — keep typing</Text>
          ) : null}
        </Box>
      )}
    </Box>
  );
}
