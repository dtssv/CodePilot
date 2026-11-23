/**
 * Full-screen help panel: the key map, general conventions, and the command
 * catalog.
 *
 * Keyboard: Tab / ←→ / h l switch pages, ↑↓ j k PgUp PgDn g G scroll, Esc (or q)
 * closes. Mouse: click a tab to switch, click a command to insert it into the
 * prompt, wheel to scroll.
 *
 * The panel owns its height so the frame never resizes between pages — a
 * resizing overlay leaves stale rows behind on a partial repaint. The frame is
 * anchored at the top of the screen while the panel is open, so a mouse row maps
 * straight onto a layout row with no scroll bookkeeping.
 */
import React from "react";
import { Box, Text, useInput } from "ink";

import { helpSections, type CommandInfo } from "./commands.js";
import { isEscape } from "./keys.js";
import { onTermMouse, type TermMouseEvent } from "./mouse.js";
import { color, glyph } from "./theme.js";
import { truncateToWidth, textWidth, wrapLine } from "./textWidth.js";

export type HelpPage = "help" | "general" | "commands";

export const HELP_PAGES: readonly HelpPage[] = ["help", "general", "commands"];

const PAGE_LABELS: Record<HelpPage, string> = {
  help: "Key map",
  general: "General",
  commands: "Commands",
};

/** Columns of the panel body. */
const PAD = 2;
/** Spaces between the two key-map columns. */
const COLUMN_GAP = 4;
/** Width reserved for a key chord before its description. */
const KEY_COLUMN = 13;
/** Spaces between a command label and its description. */
const COMMAND_GAP = 2;

/** Every entry here is a binding this TUI actually implements. */
const SHORTCUT_GROUPS: readonly {
  title: string;
  items: readonly { keys: string; what: string }[];
}[] = [
  {
    title: "Prompt",
    items: [
      { keys: "/", what: "command palette" },
      { keys: "@", what: "add files to the prompt" },
      { keys: "Enter", what: "send · open a card" },
      { keys: "Shift+Enter", what: "newline" },
      { keys: "Ctrl+R", what: "search prompt history" },
      { keys: "Ctrl+G", what: "edit the prompt in $EDITOR" },
    ],
  },
  {
    title: "Transcript",
    items: [
      { keys: "Tab", what: "focus the transcript" },
      { keys: "↑ ↓", what: "move focus · scroll" },
      { keys: "PgUp PgDn", what: "page the transcript" },
      { keys: "Ctrl+O", what: "tool call details" },
    ],
  },
  {
    title: "Session",
    items: [
      { keys: "Shift+Tab", what: "cycle collaboration mode" },
      { keys: "Ctrl+K", what: "command palette" },
      { keys: "Ctrl+C", what: "cancel the running turn" },
      { keys: "Esc", what: "close an overlay" },
    ],
  },
];

const GENERAL: readonly { title: string; lines: readonly string[] }[] = [
  {
    title: "What this is",
    lines: [
      "CodePilot runs a coding agent in your terminal. It reads and edits files and",
      "runs shell commands on your behalf; every session is stored as an append-only",
      "JSONL transcript you can resume later.",
    ],
  },
  {
    title: "Modes",
    lines: [
      "chat    read-only questions and answers; no edits, no shell",
      "plan    read-only research that produces a plan",
      "agent   full autonomy (default)",
    ],
  },
  {
    title: "Permissions",
    lines: [
      "ask       prompt before every tool call",
      "auto-edit approve file edits, prompt for the rest",
      "yolo      never prompt (only in sandboxes you trust)",
      "auto      classifier approves benign calls, prompts for risky ones",
      "dont-ask  refuse anything that would need a prompt",
    ],
  },
  {
    title: "Configuration",
    lines: [
      "Presets bundle a permission mode with the sandbox policy: safe, standard,",
      "full-access, supervised-auto. Switch with /preset.",
      "",
      "Settings live in ~/.codepilot/config.json. Project instructions are read from",
      "AGENTS.md (or CODEPILOT.md) in the working directory and its parents.",
      "",
      "Custom commands are Markdown files under .codepilot/commands/ and run as",
      "/<name>; they are not listed on the Commands page.",
    ],
  },
];

/** One laid-out line of the body. Only `command` rows are click targets. */
type Row =
  | { kind: "blank" }
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string }
  | { kind: "keys"; cells: readonly { keys: string; what: string }[] }
  | { kind: "command"; command: CommandInfo; labelWidth: number };

function shortcutRows(inner: number): Row[] {
  const columns = inner >= 76 ? 2 : 1;
  const cellWidth = Math.floor((inner - COLUMN_GAP * (columns - 1)) / columns);
  const rows: Row[] = [];
  for (const group of SHORTCUT_GROUPS) {
    rows.push({ kind: "heading", text: group.title });
    for (let i = 0; i < group.items.length; i += columns) {
      const cells: { keys: string; what: string }[] = [];
      for (let c = 0; c < columns; c++) {
        const item = group.items[i + c];
        if (item) cells.push({ keys: item.keys, what: item.what });
      }
      rows.push({ kind: "keys", cells });
    }
    rows.push({ kind: "blank" });
  }
  rows.pop();
  return rows;
}

function generalRows(inner: number): Row[] {
  const rows: Row[] = [];
  for (const section of GENERAL) {
    rows.push({ kind: "heading", text: section.title });
    for (const line of section.lines) {
      if (line === "") {
        rows.push({ kind: "blank" });
        continue;
      }
      for (const wrapped of wrapLine(line, inner)) rows.push({ kind: "text", text: wrapped });
    }
    rows.push({ kind: "blank" });
  }
  rows.pop();
  return rows;
}

function commandRows(inner: number): Row[] {
  const sections = helpSections();
  let labelWidth = 0;
  for (const section of sections) {
    for (const c of section.items) labelWidth = Math.max(labelWidth, commandLabel(c).length);
  }
  // One shared label column for every section, but always leave the description
  // a readable measure — a long argument hint truncates instead of squeezing it
  // out. RowLine must use this same width or the column stops lining up.
  const maxLabel = Math.max(18, inner - COMMAND_GAP - 24);
  labelWidth = Math.min(labelWidth, maxLabel);

  const rows: Row[] = [];
  for (const section of sections) {
    rows.push({ kind: "heading", text: section.title });
    for (const c of section.items) rows.push({ kind: "command", command: c, labelWidth });
    rows.push({ kind: "blank" });
  }
  rows.pop();
  return rows;
}

function commandLabel(c: CommandInfo): string {
  return c.args ? `/${c.name} ${c.args}` : `/${c.name}`;
}

function pageRows(page: HelpPage, inner: number): Row[] {
  if (page === "help") return shortcutRows(inner);
  if (page === "general") return generalRows(inner);
  return commandRows(inner);
}

/** The text clicking a command writes into the prompt. */
export function commandToInsert(c: CommandInfo): string {
  return c.args ? `/${c.name} ` : `/${c.name}`;
}

export function HelpPanel({
  width,
  height,
  version,
  model,
  onClose,
  onInsert,
}: {
  width: number;
  height: number;
  version: string;
  model: string | undefined;
  onClose(): void;
  onInsert(command: string): void;
}): React.ReactElement {
  const [page, setPage] = React.useState<HelpPage>("help");
  const [scroll, setScroll] = React.useState(0);

  const inner = Math.max(16, width - PAD * 2);
  const body = Math.max(4, height - 5);
  const rows = pageRows(page, inner);
  const maxScroll = Math.max(0, rows.length - body);

  const go = (delta: number): void => {
    const i = HELP_PAGES.indexOf(page);
    const next = HELP_PAGES[(i + delta + HELP_PAGES.length) % HELP_PAGES.length]!;
    setPage(next);
    setScroll(0);
  };

  const step = (delta: number): void =>
    setScroll((s) => Math.min(maxScroll, Math.max(0, s + delta)));

  useInput((ch, key) => {
    if (isEscape(ch, key) || ch === "q") {
      onClose();
      return;
    }
    if (key.tab || key.rightArrow || key.leftArrow || ch === "h" || ch === "l") {
      go(key.leftArrow || ch === "h" ? -1 : 1);
      return;
    }
    if (key.upArrow || ch === "k") step(-1);
    else if (key.downArrow || ch === "j") step(1);
    else if (key.pageUp) step(-Math.max(1, body - 1));
    else if (key.pageDown) step(Math.max(1, body - 1));
    else if (ch === "g") setScroll(0);
    else if (ch === "G") setScroll(maxScroll);
  });

  // Tab hit boxes, in screen columns. Rendered on layout row 1.
  const tabWidths = HELP_PAGES.map((p) => textWidth(PAGE_LABELS[p]) + 2);
  const tabBoxes: { page: HelpPage; x0: number; x1: number }[] = [];
  {
    let x = PAD;
    for (let i = 0; i < HELP_PAGES.length; i++) {
      const w = tabWidths[i]!;
      tabBoxes.push({ page: HELP_PAGES[i]!, x0: x, x1: x + w - 1 });
      x += w + 2;
    }
  }

  const top = Math.min(scroll, maxScroll);
  const view = rows.slice(top, top + body);

  // Read through a ref: the subscription is mounted once, the handler closes
  // over this render's geometry and page.
  const handlerRef = React.useRef<(e: TermMouseEvent) => void>(() => {});
  handlerRef.current = (e) => {
    if (e.action === "release") return;
    if (e.button === "wheelUp" || e.button === "wheelDown") {
      step(e.button === "wheelUp" ? -3 : 3);
      return;
    }
    if (e.button !== "left") return;
    if (e.y === 1) {
      const hit = tabBoxes.find((b) => e.x >= b.x0 && e.x <= b.x1);
      if (hit && hit.page !== page) {
        setPage(hit.page);
        setScroll(0);
      }
      return;
    }
    const offset = e.y - 3;
    if (offset < 0 || offset >= body) return;
    const row = view[offset];
    if (row?.kind === "command") onInsert(commandToInsert(row.command));
  };
  React.useEffect(() => onTermMouse((e) => handlerRef.current(e)), []);

  const hint =
    rows.length <= body
      ? `${glyph.dot} esc close ${glyph.dot} tab switch`
      : ` ${top + 1}-${top + view.length}/${rows.length} ${glyph.dot} esc close ${glyph.dot} tab switch`;

  return (
    <Box flexDirection="column" height={height} width="100%" overflow="hidden">
      <Box paddingX={PAD}>
        <Text color={color.accent} bold>
          {glyph.logo} Help
        </Text>
        <Box flexGrow={1} />
        <Text color={color.faint} wrap="truncate-end">
          {truncateToWidth(`${model ?? "no model"}${glyph.dot}v${version}`, Math.max(10, inner / 3))}
        </Text>
      </Box>

      <Box paddingX={PAD}>
        {tabBoxes.map((box, i) => (
          <Box key={box.page} marginRight={i === tabBoxes.length - 1 ? 0 : 2}>
            <Text inverse={box.page === page} bold={box.page === page} color={box.page === page ? undefined : color.faint}>
              {` ${PAGE_LABELS[box.page]} `}
            </Text>
          </Box>
        ))}
      </Box>

      <Box paddingX={PAD}>
        <Text color={color.edge}>{"─".repeat(inner)}</Text>
      </Box>

      <Box flexDirection="column" height={body} paddingX={PAD} flexShrink={0}>
        {view.map((row, i) => (
          <RowLine key={top + i} row={row} width={inner} />
        ))}
        {Array.from({ length: Math.max(0, body - view.length) }, (_, i) => (
          <Text key={`pad-${i}`}> </Text>
        ))}
      </Box>

      <Box paddingX={PAD}>
        <Text color={color.edge}>{"─".repeat(inner)}</Text>
      </Box>

      <Box paddingX={PAD}>
        <Text color={color.faint} wrap="truncate-end">
          {page === "commands" ? `${hint} ${glyph.dot} click to insert` : hint}
        </Text>
      </Box>
    </Box>
  );
}

function RowLine({ row, width }: { row: Row; width: number }): React.ReactElement {
  switch (row.kind) {
    case "blank":
      return <Text> </Text>;
    case "heading":
      return (
        <Text color={color.accent} bold wrap="truncate-end">
          {truncateToWidth(row.text, width)}
        </Text>
      );
    case "text":
      return (
        <Text color={color.faint} wrap="truncate-end">
          {truncateToWidth(row.text, width)}
        </Text>
      );
    case "keys": {
      const columns = row.cells.length;
      const cellWidth = Math.floor((width - COLUMN_GAP * (columns - 1)) / columns);
      const whatWidth = Math.max(6, cellWidth - KEY_COLUMN);
      return (
        <Box flexDirection="row">
          {row.cells.map((cell, i) => (
            <Box key={cell.keys} flexDirection="row" width={cellWidth}>
              <Text color={color.info}>{cell.keys.padEnd(KEY_COLUMN).slice(0, KEY_COLUMN)}</Text>
              <Text color={color.faint} wrap="truncate-end">
                {truncateToWidth(cell.what, whatWidth)}
              </Text>
              {i === row.cells.length - 1 ? null : <Text>{" ".repeat(COLUMN_GAP)}</Text>}
            </Box>
          ))}
        </Box>
      );
    }
    case "command": {
      const label = commandLabel(row.command);
      return (
        <Box flexDirection="row">
          <Box width={row.labelWidth} flexShrink={0}>
            <Text color={color.info} wrap="truncate-end">
              {truncateToWidth(label, row.labelWidth - COMMAND_GAP)}
            </Text>
          </Box>
          <Text color={color.faint} wrap="truncate-end">
            {truncateToWidth(row.command.description, width - row.labelWidth)}
          </Text>
        </Box>
      );
    }
  }
}
