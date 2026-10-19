/**
 * Reverse-search popup for prompt history (Ctrl+R, bash-style).
 *
 * Pure controlled component: the parent (InputBox) owns the query string
 * and the selection; this only renders the ranked results.
 */
import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "./theme.js";
import type { HistoryEntry } from "./history.js";
import { searchHistory } from "./history.js";

export interface HistorySearchProps {
  query: string;
  entries: readonly HistoryEntry[];
  selected: number;
  maxRows?: number;
}

export function HistorySearch(props: HistorySearchProps): React.ReactElement {
  const { query, entries, selected, maxRows = 8 } = props;
  const matches = searchHistory(entries, query, 50);
  const sel = Math.min(Math.max(0, selected), Math.max(0, matches.length - 1));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color.info}
      paddingX={1}
      marginBottom={0}
    >
      <Box>
        <Text color={color.info}>reverse-search</Text>
        <Text color={color.faint}>{` — "${query}"`}</Text>
        <Box flexGrow={1} />
        <Text color={color.faint}>
          {matches.length} match{matches.length === 1 ? "" : "es"} · ↑↓ · ↵ run · esc cancel
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {matches.length === 0 ? (
          <Text color={color.faint}>  (no history matches)</Text>
        ) : (
          matches.slice(0, maxRows).map((e, i) => (
            <Text
              key={`${e.at}-${i}`}
              color={i === sel ? color.accent : undefined}
              bold={i === sel}
            >
              {i === sel ? "▸ " : "  "}
              {oneLine(e.text, 100)}
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={0}>
        <Text color={color.faint}>{glyph.dot} ctrl+R again cycles older matches</Text>
      </Box>
    </Box>
  );
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
