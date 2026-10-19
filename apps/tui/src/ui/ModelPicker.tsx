/**
 * Interactive `/model` picker — ↑/↓ to move, Enter to switch, Esc to cancel.
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import type { SelectableModel } from "@codepilot/core";
import { color as palette } from "./theme.js";

export interface ModelPickerProps {
  models: readonly SelectableModel[];
  currentModel?: string;
  currentProviderId?: string;
  onPick: (model: SelectableModel) => void;
  onCancel: () => void;
}

export function ModelPicker(props: ModelPickerProps): React.ReactElement {
  const { models, currentModel, currentProviderId, onPick, onCancel } = props;

  const initial = Math.max(
    0,
    models.findIndex(
      (m) =>
        m.model === currentModel &&
        (currentProviderId === undefined || m.providerId === currentProviderId),
    ),
  );
  const [cursor, setCursor] = React.useState(initial < 0 ? 0 : initial);

 // Group for display labels.
  const rows = models;

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }
    if (rows.length === 0) return;
    if (key.upArrow || (key.ctrl && input === "p")) {
      setCursor((i) => (i - 1 + rows.length) % rows.length);
      return;
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
      setCursor((i) => (i + 1) % rows.length);
      return;
    }
    const n = Number.parseInt(input, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= rows.length && String(n) === input) {
      onPick(rows[n - 1]!);
      return;
    }
    if (key.return) {
      onPick(rows[cursor]!);
    }
  });

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1}>
        <Text bold color={palette.accent}>
          /model
        </Text>
        <Text dimColor>No selectable models — run /connect first.</Text>
        <Text dimColor>Esc to close</Text>
      </Box>
    );
  }

 // Show a window around the cursor so long lists stay usable.
  const window = 12;
  const start = Math.max(0, Math.min(cursor - Math.floor(window / 2), rows.length - window));
  const end = Math.min(rows.length, start + window);
  const visible = rows.slice(start, end);

  let lastLabel = "";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1}>
      <Box>
        <Text bold color={palette.accent}>
          /model{" "}
        </Text>
        <Text bold>Select model</Text>
        <Box flexGrow={1} />
        <Text dimColor>↑↓ · ↵ · Esc</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((m, vi) => {
          const i = start + vi;
          const selected = i === cursor;
          const active =
            m.model === currentModel &&
            (currentProviderId === undefined || m.providerId === currentProviderId);
          const showGroup = m.providerLabel !== lastLabel;
          lastLabel = m.providerLabel;
          return (
            <Box key={m.id} flexDirection="column">
              {showGroup ? (
                <Text dimColor>
                  {showGroup && i > start ? " " : ""}
                  {m.providerLabel}
                </Text>
              ) : null}
              <Text inverse={selected} color={active && !selected ? palette.add : undefined}>
                {selected ? "▶ " : "  "}
                {active ? "* " : "  "}
                {m.model}
              </Text>
            </Box>
          );
        })}
        {rows.length > window ? (
          <Text dimColor>
            {"  "}… {cursor + 1}/{rows.length}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
