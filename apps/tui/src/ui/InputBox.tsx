/**
 * Multi-line input box.
 *
 * Behavior:
 *  - Enter         → submit (calls onSubmit)
 *  - Shift+Enter   → insert newline
 *  - `\` + Enter   → insert newline (fallback when terminal doesn't pass Shift)
 *  - Backspace     → standard
 *  - Ctrl+C        → onCancel (cancels running prompt); if nothing running, exits TUI
 *  - Up/Down       → history navigation (in-memory only)
 *  - Left/Right    → cursor move
 *
 * We implement this ourselves rather than using ink-text-input because we
 * need multi-line + key combinations that the latter doesn't expose.
 */
import React from "react";
import { Box, Text, useInput } from "ink";

export interface InputBoxProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  /** When true, input is disabled (e.g. waiting for permission or busy). */
  disabled?: boolean;
  placeholder?: string;
  /** Hint shown on the right side. */
  hint?: string;
}

export function InputBox(props: InputBoxProps): React.ReactElement {
  const { value, onChange, onSubmit, onCancel, disabled, placeholder, hint } = props;
  const [history, setHistory] = React.useState<string[]>([]);
  const histIdxRef = React.useRef<number>(-1);
  const draftRef = React.useRef<string>("");

  useInput(
    (input, key) => {
      if (disabled) {
        if (key.ctrl && input === "c") {
          onCancel();
        }
        return;
      }
      // Ctrl+C always cancels.
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }
      // Submit on Enter (no Shift held).
      if (key.return && !key.shift) {
        const text = value.trim();
        if (text.length === 0) return;
        // Push to history if non-empty and not identical to the last entry.
        setHistory((h) => {
          if (h[h.length - 1] === text) return h;
          return [...h, text];
        });
        histIdxRef.current = -1;
        draftRef.current = "";
        onSubmit(text);
        return;
      }
      // Shift+Enter OR a trailing '\' + Enter → newline.
      if (key.return && key.shift) {
        onChange(value + "\n");
        return;
      }
      if (key.return && value.endsWith("\\")) {
        // Strip the trailing backslash and insert newline instead.
        onChange(value.slice(0, -1) + "\n");
        return;
      }
      // History navigation.
      if (key.upArrow) {
        if (history.length === 0) return;
        const idx = histIdxRef.current;
        const next = idx === -1 ? history.length - 1 : Math.max(0, idx - 1);
        if (idx === -1) draftRef.current = value;
        const v = history[next];
        if (v !== undefined) onChange(v);
        histIdxRef.current = next;
        return;
      }
      if (key.downArrow) {
        const idx = histIdxRef.current;
        if (idx === -1) return;
        const next = idx + 1;
        if (next >= history.length) {
          draftRef.current = "";
          onChange("");
          histIdxRef.current = -1;
          return;
        }
        const v = history[next];
        if (v !== undefined) onChange(v);
        histIdxRef.current = next;
        return;
      }
      // Standard editing.
      if (key.backspace || key.delete) {
        if (value.length > 0) onChange(value.slice(0, -1));
        return;
      }
      // Paste / printable input.
      if (input.length > 0 && !key.ctrl && !key.meta) {
        // Ink gives us the input string directly; multi-char pastes are supported.
        onChange(value + input);
        return;
      }
    },
    { isActive: true },
  );

  const lines = value.split("\n");
  const showPlaceholder = value.length === 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={disabled ? "gray" : "cyan"} paddingX={1}>
      {showPlaceholder ? (
        <Text dimColor>{placeholder ?? "Type a message. Enter to send, Shift+Enter for newline. / for commands."}</Text>
      ) : (
        lines.map((line, i) => (
          <Text key={`l-${i}`}>
            {i === 0 ? "› " : "  "}
            {line.length === 0 ? " " : line}
          </Text>
        ))
      )}
      <Box justifyContent="space-between">
        <Text dimColor>{hint ?? "↵ send · ⇧↵ newline · \\↵ newline · ^C cancel · ↑↓ history"}</Text>
      </Box>
    </Box>
  );
}