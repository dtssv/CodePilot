/**
 * Generic ↑/↓ + Enter picker used by /mode, /agent, /provider, /resume, etc.
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import { color as palette } from "./theme.js";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface SelectMenuProps {
  title: string;
  options: readonly SelectOption[];
 /** Currently active value (shown with *). */
  current?: string;
  emptyText?: string;
  onPick: (value: string) => void;
  onCancel: () => void;
}

export function SelectMenu(props: SelectMenuProps): React.ReactElement {
  const { title, options, current, emptyText, onPick, onCancel } = props;
  const initial = Math.max(
    0,
    options.findIndex((o) => o.value === current),
  );
  const [cursor, setCursor] = React.useState(initial < 0 ? 0 : initial);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }
    if (options.length === 0) return;
    if (key.upArrow || (key.ctrl && input === "p")) {
      setCursor((i) => (i - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
      setCursor((i) => (i + 1) % options.length);
      return;
    }
    const n = Number.parseInt(input, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= options.length && String(n) === input) {
      onPick(options[n - 1]!.value);
      return;
    }
    if (key.return) onPick(options[cursor]!.value);
  });

  const window = 14;
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(window / 2), options.length - window),
  );
  const end = Math.min(options.length, start + window);
  const visible = options.slice(start, end);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1}>
      <Box>
        <Text bold color={palette.accent}>
          {title}{" "}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>↑↓ · ↵ · Esc</Text>
      </Box>
      {options.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>{emptyText ?? "Nothing to choose."}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((opt, vi) => {
            const i = start + vi;
            const selected = i === cursor;
            const active = opt.value === current;
            return (
              <Text
                key={opt.value}
                inverse={selected}
                color={active && !selected ? palette.add : undefined}
              >
                {selected ? "▶ " : "  "}
                {active ? "* " : "  "}
                {opt.label}
                {opt.description ? <Text dimColor> — {opt.description}</Text> : null}
              </Text>
            );
          })}
          {options.length > window ? (
            <Text dimColor>
              {"  "}… {cursor + 1}/{options.length}
            </Text>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

/** Single-line free-text prompt (e.g. /goal objective). */
export function TextPrompt(props: {
  title: string;
  placeholder?: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { title, placeholder, onSubmit, onCancel } = props;
  const [value, setValue] = React.useState("");

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }
    if (key.return) {
      const text = value.trim();
      if (text.length === 0) return;
      onSubmit(text);
      return;
    }
    if (key.backspace || key.delete) {
      if (value.length > 0) setValue(value.slice(0, -1));
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) setValue(value + input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1}>
      <Box>
        <Text bold color={palette.accent}>
          {title}{" "}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>↵ submit · Esc cancel</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          › {value.length === 0 ? <Text dimColor>{placeholder ?? ""}</Text> : value}
        </Text>
      </Box>
    </Box>
  );
}
