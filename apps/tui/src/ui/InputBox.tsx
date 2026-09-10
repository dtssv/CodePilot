/**
 * Multi-line input box with slash-command and @file autocomplete.
 *
 * Behavior:
 *  - Enter         → submit (calls onSubmit) — unless the autocomplete menu is
 *                    open, in which case Enter accepts the selected completion.
 *  - Shift+Enter   → insert newline
 *  - `\` + Enter   → insert newline (fallback when terminal doesn't pass Shift)
 *  - Backspace     → standard
 *  - Ctrl+C        → onCancel (cancels running prompt); if nothing running, exits TUI
 *  - Up/Down       → history navigation (in-memory only) — unless the
 *                    autocomplete menu is open, in which case they navigate it.
 *  - Tab           → accept the selected autocomplete completion.
 *  - Esc           → dismiss the autocomplete menu.
 *
 * Autocomplete triggers:
 *  - When the cursor token starts with `/` (and we're at the start of the
 *    input or after whitespace), we offer slash commands.
 *  - When the cursor token starts with `@`, we offer file paths under `cwd`.
 *
 * We implement this ourselves rather than using ink-text-input because we
 * need multi-line + key combinations that the latter doesn't expose.
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import type { CommandInfo } from "./commands.js";
import { listFilesForCompletion } from "./fileComplete.js";

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
  /** Working directory, for @file completion. */
  cwd?: string;
  /** Slash commands, for / completion. */
  commands?: readonly CommandInfo[];
}

/** The active completion context, derived from the current input + cursor. */
interface CompletionState {
  /** The kind of completion being offered. */
  kind: "command" | "file";
  /** The full token including the leading sigil (e.g. "/mod" or "@src/ind"). */
  token: string;
  /** Index of the token's start within `value` (the sigil's position). */
  start: number;
  /** The candidate strings to show, WITHOUT the sigil. */
  candidates: string[];
}

/** Extract the completion context from the current input value.
 *  Completion only triggers when the cursor (end of input) is inside a
 *  sigil token that starts at the beginning of input or after whitespace.
 *  Exported for unit testing. */
export function deriveCompletion(
  value: string,
  cwd: string | undefined,
  commands: readonly CommandInfo[] | undefined,
): CompletionState | null {
  // Find the token the cursor is in. Cursor = end of string (single-line bias).
  // Walk back from the end to find the start of the current whitespace-delimited token.
  let i = value.length - 1;
  while (i >= 0 && value[i] !== " " && value[i] !== "\n" && value[i] !== "\t") i--;
  const tokenStart = i + 1;
  const token = value.slice(tokenStart);
  if (token.length === 0) return null;
  const sigil = token[0];
  const body = token.slice(1);

  if (sigil === "/") {
    // Only complete if the token is the first thing in the input or follows whitespace.
    if (tokenStart !== 0 && !/\s/.test(value[tokenStart - 1])) return null;
    if (!commands) return null;
    const candidates = commands
      .filter((c) => c.name.startsWith(body))
      .map((c) => (c.args ? `${c.name} ${c.args}` : c.name));
    if (candidates.length === 0) return null;
    return { kind: "command", token, start: tokenStart, candidates };
  }
  if (sigil === "@") {
    if (!cwd) return null;
    const candidates = listFilesForCompletion(cwd, body);
    if (candidates.length === 0) return null;
    return { kind: "file", token, start: tokenStart, candidates };
  }
  return null;
}

export function InputBox(props: InputBoxProps): React.ReactElement {
  const { value, onChange, onSubmit, onCancel, disabled, placeholder, hint, cwd, commands } = props;
  const [history, setHistory] = React.useState<string[]>([]);
  const histIdxRef = React.useRef<number>(-1);
  const draftRef = React.useRef<string>("");
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [selected, setSelected] = React.useState(0);

  // Derive completion candidates from the current input.
  const completion = React.useMemo(
    () => deriveCompletion(value, cwd, commands),
    [value, cwd, commands],
  );

  // Keep the menu open while there's a completion context; close otherwise.
  React.useEffect(() => {
    if (completion) {
      setMenuOpen(true);
      setSelected(0);
    } else {
      setMenuOpen(false);
    }
  }, [completion]);

  const candidates = completion?.candidates ?? [];
  const clampedSelected = Math.min(selected, Math.max(0, candidates.length - 1));

  /** Replace the current sigil token with the accepted candidate. */
  const acceptCompletion = React.useCallback(
    (candidate: string) => {
      if (!completion) return;
      const before = value.slice(0, completion.start);
      const sigil = completion.kind === "command" ? "/" : "@";
      // For commands, we replace the whole token with "/name" (and a trailing
      // space if the command takes args). For files, we replace with "@path".
      let insertion: string;
      if (completion.kind === "command") {
        // candidate may be "name <args>" — we only want the name as the token,
        // since the args are a placeholder.
        const name = candidate.split(" ")[0];
        insertion = "/" + name + " ";
      } else {
        insertion = "@" + candidate;
        // If it's a directory, leave the cursor there so the user can keep typing;
        // otherwise add a trailing space.
        insertion += candidate.endsWith("/") ? "" : " ";
      }
      onChange(before + insertion);
      setMenuOpen(false);
    },
    [completion, value, onChange],
  );

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
      // Esc dismisses the autocomplete menu (if open).
      if (key.escape && menuOpen) {
        setMenuOpen(false);
        return;
      }
      // Tab accepts the currently-selected completion.
      if (key.tab && menuOpen && candidates.length > 0) {
        acceptCompletion(candidates[clampedSelected] ?? candidates[0]);
        return;
      }
      // When the menu is open, arrow up/down navigate it instead of history.
      if (menuOpen && candidates.length > 0) {
        if (key.upArrow) {
          setSelected((s) => (s <= 0 ? candidates.length - 1 : s - 1));
          return;
        }
        if (key.downArrow) {
          setSelected((s) => (s + 1) % candidates.length);
          return;
        }
        // Enter accepts the selected completion (does NOT submit the prompt).
        if (key.return && !key.shift) {
          acceptCompletion(candidates[clampedSelected] ?? candidates[0]);
          return;
        }
      }
      // Submit on Enter (no Shift held), when no menu is open.
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
      // History navigation (only when the menu is closed).
      if (!menuOpen && key.upArrow) {
        if (history.length === 0) return;
        const idx = histIdxRef.current;
        const next = idx === -1 ? history.length - 1 : Math.max(0, idx - 1);
        if (idx === -1) draftRef.current = value;
        const v = history[next];
        if (v !== undefined) onChange(v);
        histIdxRef.current = next;
        return;
      }
      if (!menuOpen && key.downArrow) {
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

  // Render the autocomplete menu (above the input box for visibility).
  const menu =
    menuOpen && candidates.length > 0 ? (
      <Box flexDirection="column" marginBottom={0} paddingLeft={2}>
        <Text dimColor>
          {completion?.kind === "command" ? "commands" : "files"} — ↑↓ select · ↵/⇥ accept · esc dismiss
        </Text>
        {candidates.slice(0, 8).map((c, i) => {
          const isSel = i === clampedSelected;
          const display =
            completion?.kind === "command"
              ? `/${c}`
              : `@${c}`;
          return (
            <Text key={`c-${i}`} color={isSel ? "cyan" : undefined} bold={isSel}>
              {isSel ? "▸ " : "  "}
              {display}
            </Text>
          );
        })}
        {candidates.length > 8 ? (
          <Text dimColor>  …{candidates.length - 8} more</Text>
        ) : null}
      </Box>
    ) : null;

  return (
    <Box flexDirection="column">
      {menu}
      <Box flexDirection="column" borderStyle="round" borderColor={disabled ? "gray" : "cyan"} paddingX={1}>
        {showPlaceholder ? (
          <Text dimColor>
            {placeholder ?? "Type a message. Enter to send, Shift+Enter for newline. / for commands, @ for files."}
          </Text>
        ) : (
          lines.map((line, i) => (
            <Text key={`l-${i}`}>
              {i === 0 ? "› " : "  "}
              {line.length === 0 ? " " : line}
            </Text>
          ))
        )}
        <Box justifyContent="space-between">
          <Text dimColor>
            {hint ?? "↵ send · ⇧↵ newline · \\↵ newline · ^C cancel · ↑↓ history · ⇥ complete"}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
