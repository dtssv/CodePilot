/**
 * Multi-line input box with command palette, history search and @file
 * completion.
 *
 * Key map:
 * - Enter → submit (or accept the highlighted palette/completion
 * entry when a menu is open)
 * - Shift+Enter, `\`+Enter → newline
 * - Ctrl+K → open/close the command palette
 * - `/` at col 0 → open the command palette with the rest of the line as
 * the fuzzy query
 * - Ctrl+R → open reverse history search; again cycles older hits
 * - Up/Down → history navigation (menus closed) / menu navigation
 * - Tab → complete slash command into the input (palette);
 * accept the highlighted entry for history / @file
 * - Enter → submit, or accept+run the highlighted palette command
 * - Esc → close menu (restore pre-menu input)
 * - Ctrl+C → cancel the running prompt; exit when idle
 *
 * The component owns three mutually-exclusive menus (palette / history
 * search / @file completion) and is the only place that interprets keys.
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import { color as palette } from "./theme.js";
import type { CommandInfo } from "./commands.js";
import { listFilesForCompletion } from "./fileComplete.js";
import { CommandPalette, paletteState } from "./CommandPalette.js";
import { HistorySearch } from "./HistorySearch.js";
import { tabCompleteCommand } from "./palette.js";
import {
  appendHistory,
  loadHistory,
  searchHistory,
  type HistoryEntry,
} from "./history.js";

export interface InputBoxProps {
  value: string;
  onChange: (next: string) => void;
  /** Second arg: `steer` injects into the current run (Ctrl+Enter while busy). */
  onSubmit: (text: string, delivery?: "auto" | "steer") => void;
  onCancel: () => void;
 /** When true, input is disabled (e.g. waiting for permission). Busy runs
  * stay editable so the user can queue or inject. */
  disabled?: boolean;
  /** When true, Enter queues / Ctrl+Enter injects (composer stays enabled). */
  busy?: boolean;
  placeholder?: string;
 /** Hint shown below the box. */
  hint?: string;
 /** Working directory, for @file completion. */
  cwd?: string;
 /** Slash commands, for the palette. */
  commands?: readonly CommandInfo[];
 /** Path of the history file (defaults to ~/.codepilot/tui-history.jsonl).
 * Overridable for tests; pass null to disable persistence. */
  historyPath?: string | null;
}

/** Which overlay menu (if any) is open. */
type Menu =
  | { kind: "palette"; query: string; selected: number; priorValue: string }
  | { kind: "history"; query: string; selected: number; priorValue: string }
  | { kind: "files"; start: number; token: string; candidates: string[]; selected: number };

/** Derive the @file completion context (only when no other menu is open). */
function deriveFileCompletion(
  value: string,
  cwd: string | undefined,
): { start: number; token: string; candidates: string[] } | null {
  if (!cwd) return null;
  let i = value.length - 1;
  while (i >= 0 && value[i] !== " " && value[i] !== "\n" && value[i] !== "\t") i--;
  const tokenStart = i + 1;
  const token = value.slice(tokenStart);
  if (token.length === 0 || token[0] !== "@") return null;
  const candidates = listFilesForCompletion(cwd, token.slice(1));
  if (candidates.length === 0) return null;
  return { start: tokenStart, token, candidates };
}

export function InputBox(props: InputBoxProps): React.ReactElement {
  const {
    value,
    onChange,
    onSubmit,
    onCancel,
    disabled,
    busy = false,
    placeholder,
    hint,
    cwd,
    commands,
    historyPath,
  } = props;

 // ---- persistent history -------------------------------------------------
  const historyRef = React.useRef<HistoryEntry[] | null>(null);
  if (historyRef.current === null) {
    historyRef.current =
      historyPath === null ? [] : loadHistory(historyPath ?? undefined);
  }
  const histNavIdxRef = React.useRef<number>(-1);
  const draftRef = React.useRef<string>("");

  const [menu, setMenu] = React.useState<Menu | null>(null);

 // Auto-open the palette when the input starts with `/`. The fuzzy query is
 // the first whitespace-delimited token after the sigil; anything beyond
 // (already-typed args) doesn't narrow the list.
  React.useEffect(() => {
    if (menu?.kind === "palette") {
      const q = value.startsWith("/") ? value.slice(1).split(/\s/)[0] ?? "" : "";
      if (q !== menu.query) setMenu({ ...menu, query: q });
      return;
    }
    if (
      menu === null &&
      value.startsWith("/") &&
      !value.includes("\n") &&
      !value.includes(" ") && // args typed → palette's job is done
      commands !== undefined
    ) {
      setMenu({ kind: "palette", query: value.slice(1), selected: 0, priorValue: value });
    }
 // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const fileCompletion = menu === null ? deriveFileCompletion(value, cwd) : null;

 // -------------------------------------------------------------------------
 // Menu helpers
 // -------------------------------------------------------------------------
  const closeMenu = React.useCallback(
    (restorePrior: boolean) => {
 // Never call onChange inside a setState updater — that updates App
 // while InputBox is still reconciling and triggers the React warning.
      setMenu((m) => {
        if (m !== null && restorePrior && "priorValue" in m) {
          const prior = m.priorValue;
          queueMicrotask(() => onChange(prior));
        }
        return null;
      });
    },
    [onChange],
  );

  const acceptPalette = React.useCallback(
    (m: Extract<Menu, { kind: "palette" }>) => {
      if (!commands) return;
      const { filtered, selected } = paletteState(commands, m.query, m.selected);
      const cmd = filtered[selected];
      if (!cmd) return;
      setMenu(null);
 // Optional args `[…]` or no args → run immediately (e.g. /model, /connect).
 // Required args `<…>` → leave a trailing space for the user to type.
      const optionalOrNone = !cmd.args || cmd.args.trimStart().startsWith("[");
      if (optionalOrNone) {
        queueMicrotask(() => onSubmit(`/${cmd.name}`));
      } else {
        queueMicrotask(() => onChange(`/${cmd.name} `));
      }
    },
    [commands, onChange, onSubmit],
  );

 /** Tab: fill `/name` into the input without executing. */
  const completePalette = React.useCallback(
    (m: Extract<Menu, { kind: "palette" }>) => {
      if (!commands) return;
      const result = tabCompleteCommand(commands, m.query, m.selected);
      if (!result) return;
      onChange(result.nextInput);
      if (result.closePalette) {
        setMenu(null);
      } else {
        const nextQuery = result.nextInput.startsWith("/")
          ? result.nextInput.slice(1).split(/\s/)[0] ?? ""
          : result.nextInput;
        setMenu({
          ...m,
          query: nextQuery,
          selected: result.nextSelected,
        });
      }
    },
    [commands, onChange],
  );

  const acceptHistory = React.useCallback(
    (m: Extract<Menu, { kind: "history" }>) => {
      const entries = historyRef.current ?? [];
      const matches = searchHistory(entries, m.query, 50);
      const hit = matches[Math.min(m.selected, matches.length - 1)];
      if (hit) onChange(hit.text);
      setMenu(null);
    },
    [onChange],
  );

  const acceptFile = React.useCallback(
    (m: Extract<Menu, { kind: "files" }>) => {
      const candidate = m.candidates[Math.min(m.selected, m.candidates.length - 1)];
      if (candidate === undefined) return;
      const before = value.slice(0, m.start);
      let insertion = "@" + candidate;
      insertion += candidate.endsWith("/") ? "" : " ";
      onChange(before + insertion);
      setMenu(null);
    },
    [value, onChange],
  );

 // -------------------------------------------------------------------------
 // Keys
 // -------------------------------------------------------------------------
  useInput(
    (input, key) => {
 // Ctrl+C always cancels / exits.
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }
      if (disabled) return;

 // Ctrl+K toggles the command palette (works with any input content —
 // the palette restores the prior input on Esc).
      if (key.ctrl && input === "k") {
        if (menu?.kind === "palette") {
          closeMenu(true);
        } else {
          setMenu({
            kind: "palette",
            query: value.startsWith("/") ? value.slice(1) : "",
            selected: 0,
            priorValue: value,
          });
          if (!value.startsWith("/")) onChange("/");
        }
        return;
      }

 // Ctrl+R opens/cycles reverse history search.
      if (key.ctrl && input === "r") {
        if (menu?.kind === "history") {
 // Cycle to the next older match.
          const entries = historyRef.current ?? [];
          const matches = searchHistory(entries, menu.query, 50);
          if (matches.length > 1) {
            setMenu({ ...menu, selected: (menu.selected + 1) % matches.length });
          }
        } else {
          setMenu({ kind: "history", query: "", selected: 0, priorValue: value });
        }
        return;
      }

 // ---- menu key routing ---------------------------------------------
      if (menu !== null) {
        if (key.escape) {
 // Restore whatever the user had before the menu opened.
          closeMenu(true);
          return;
        }
 // Menu size for wrap-around navigation.
        const size =
          menu.kind === "palette" && commands
            ? paletteState(commands, menu.query, menu.selected).filtered.length
            : menu.kind === "history"
              ? searchHistory(historyRef.current ?? [], menu.query, 50).length
              : menu.kind === "files"
                ? menu.candidates.length
                : 0;
        if (key.upArrow || (key.ctrl && input === "p")) {
          setMenu({ ...menu, selected: menu.selected <= 0 ? Math.max(0, size - 1) : menu.selected - 1 });
          return;
        }
        if (key.downArrow || (key.ctrl && input === "n")) {
          setMenu({ ...menu, selected: size === 0 ? 0 : (menu.selected + 1) % size });
          return;
        }
        if (key.tab) {
          if (menu.kind === "palette") completePalette(menu);
          else if (menu.kind === "history") acceptHistory(menu);
          else acceptFile(menu);
          return;
        }
        if (key.return && !key.shift) {
          if (menu.kind === "palette") acceptPalette(menu);
          else if (menu.kind === "history") acceptHistory(menu);
          else acceptFile(menu);
          return;
        }
 // Typing refines palette/history queries; for the file menu we let
 // normal editing continue and re-derive candidates below.
        if (menu.kind === "palette") {
          if (key.backspace || key.delete) {
            if (value === "/") {
 // Deleting the sigil closes the palette entirely.
              onChange("");
              setMenu(null);
            } else if (value.length > 0) {
              onChange(value.slice(0, -1));
            }
            return;
          }
          if (input.length > 0 && !key.ctrl && !key.meta) {
            onChange(value + input);
            return;
          }
          return; // swallow everything else while the palette is open
        }
        if (menu.kind === "history") {
          if (key.backspace || key.delete) {
            setMenu({ ...menu, query: menu.query.slice(0, -1), selected: 0 });
            return;
          }
          if (input.length > 0 && !key.ctrl && !key.meta) {
            setMenu({ ...menu, query: menu.query + input, selected: 0 });
            return;
          }
          return;
        }
 // files menu: fall through to normal editing; candidates re-derive.
      }

 // ---- plain editing ---------------------------------------------------
 // Ink maps \r → key.return and \n → key.enter. Raw-mode terminals send
 // \r, but PTYs/paste paths may deliver \n — treat both as submit.
      if ((key.return || (key as { enter?: boolean }).enter) && !key.shift) {
        const text = value.trim();
        if (text.length === 0) return;
 // Persist to history (skip exact duplicates of the latest entry).
        const entries = historyRef.current ?? [];
        if (entries[0]?.text !== text) {
          const entry: HistoryEntry = { text, cwd: cwd ?? "", at: Date.now() };
          historyRef.current = [entry, ...entries];
          if (historyPath !== null) {
            appendHistory(entry, historyPath ?? undefined);
          }
        }
        histNavIdxRef.current = -1;
        draftRef.current = "";
        const delivery = busy && key.ctrl ? "steer" : "auto";
        onSubmit(text, delivery);
        return;
      }
      if (key.return && key.shift) {
        onChange(value + "\n");
        return;
      }
      if (key.return && value.endsWith("\\")) {
        onChange(value.slice(0, -1) + "\n");
        return;
      }

 // History navigation (menus closed).
      if (key.upArrow) {
        const entries = historyRef.current ?? [];
        if (entries.length === 0) return;
        const idx = histNavIdxRef.current;
        const next = idx === -1 ? 0 : Math.min(entries.length - 1, idx + 1);
        if (idx === -1) draftRef.current = value;
        const v = entries[next];
        if (v !== undefined) onChange(v.text);
        histNavIdxRef.current = next;
        return;
      }
      if (key.downArrow) {
        const idx = histNavIdxRef.current;
        if (idx === -1) return;
        const next = idx - 1;
        if (next < 0) {
          onChange(draftRef.current);
          draftRef.current = "";
          histNavIdxRef.current = -1;
          return;
        }
        const entries = historyRef.current ?? [];
        const v = entries[next];
        if (v !== undefined) onChange(v.text);
        histNavIdxRef.current = next;
        return;
      }

      if (key.backspace || key.delete) {
        if (value.length > 0) onChange(value.slice(0, -1));
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        onChange(value + input);
        return;
      }
    },
    { isActive: true },
  );

 // Keep the @file menu in sync with the input.
  React.useEffect(() => {
    if (fileCompletion && menu === null) {
      setMenu({
        kind: "files",
        start: fileCompletion.start,
        token: fileCompletion.token,
        candidates: fileCompletion.candidates,
        selected: 0,
      });
    } else if (!fileCompletion && menu?.kind === "files") {
      setMenu(null);
    }
 // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileCompletion?.token, fileCompletion?.candidates.length]);

 // -------------------------------------------------------------------------
 // Render
 // -------------------------------------------------------------------------
  const lines = value.split("\n");
  const showPlaceholder = value.length === 0;

  return (
    <Box flexDirection="column">
      {menu?.kind === "palette" && commands ? (
        <CommandPalette
          query={menu.query}
          commands={commands}
          selected={menu.selected}
        />
      ) : null}
      {menu?.kind === "history" ? (
        <HistorySearch
          query={menu.query}
          entries={historyRef.current ?? []}
          selected={menu.selected}
        />
      ) : null}
      {menu?.kind === "files" ? (
        <Box flexDirection="column" marginBottom={0} paddingLeft={2}>
          <Text dimColor>files — ↑↓ select · ↵/⇥ accept · esc dismiss</Text>
          {menu.candidates.slice(0, 8).map((c, i) => (
            <Text key={c} color={i === menu.selected ? palette.accent : undefined} bold={i === menu.selected}>
              {i === menu.selected ? "▸ " : "  "}@{c}
            </Text>
          ))}
          {menu.candidates.length > 8 ? (
            <Text dimColor>  …{menu.candidates.length - 8} more</Text>
          ) : null}
        </Box>
      ) : null}

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={disabled ? palette.edge : palette.accent}
        paddingX={1}
      >
        {showPlaceholder ? (
          <Text dimColor>
            {placeholder ??
              "Type a message. / for commands, @ for files, Ctrl+R history."}
          </Text>
        ) : (
          lines.map((line, i) => (
            <Text key={`l-${i}`}>
              <Text color={palette.accent}>{i === 0 ? "› " : "  "}</Text>
              {line.length === 0 ? " " : line}
            </Text>
          ))
        )}
        <Box justifyContent="space-between">
          <Text dimColor>
            {hint ??
              (busy
                ? "↵ queue · ⌃↵ inject into run · ^C cancel"
                : "↵ send · ⇧↵ newline · ^K commands · ^R history · ↑↓ history · ^C cancel")}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
