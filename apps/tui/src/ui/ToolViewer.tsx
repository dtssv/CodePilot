/**
 * Ctrl+O detail viewer: every tool call of the session in a list, and for the
 * selected one its full command/input, full output and — for sub-agent calls —
 * each sub-agent's steps, results and conclusion. Every line is pre-wrapped to
 * the terminal width so the overlay's height is exact and always shorter than
 * the terminal (Ink reprints the whole screen otherwise).
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import type { Row, SubagentRun, ToolRow } from "./state.js";
import { color, formatDuration, glyph } from "./theme.js";
import { isEscape } from "./keys.js";
import { truncateToWidth, wrapLine } from "./textWidth.js";
import { agentType, bashCommand, outputLines, toolLabel, toolSubject } from "./toolDisplay.js";

export interface ViewLine {
  text: string;
  color?: string;
  bold?: boolean;
}

/** Tool calls in transcript order (plan bookkeeping excluded). */
export function viewerTools(rows: readonly Row[]): ToolRow[] {
  const out: ToolRow[] = [];
  for (const r of rows) if (r.kind === "tool" && r.tool.category !== "plan") out.push(r.tool);
  return out;
}

function duration(t: { startedAt?: number; finishedAt?: number }): string {
  return t.startedAt && t.finishedAt ? formatDuration(t.finishedAt - t.startedAt) : "";
}

function statusWord(s: ToolRow["status"]): ViewLine {
  return s === "running"
    ? { text: "running", color: color.accent }
    : s === "error"
      ? { text: "failed", color: color.remove }
      : { text: "succeeded", color: color.add };
}

function pretty(input: unknown): string[] {
  if (input === undefined) return [];
  try {
    return JSON.stringify(input, null, 2).split("\n");
  } catch {
    return [String(input)];
  }
}

function pushWrapped(out: ViewLine[], text: string, width: number, style: Omit<ViewLine, "text"> = {}, indent = ""): void {
  for (const logical of text.split("\n")) {
    for (const piece of wrapLine(logical, width - indent.length)) out.push({ text: indent + piece, ...style });
  }
}

function runLines(out: ViewLine[], run: SubagentRun, width: number): void {
  const seq = run.runSeq ?? run.index + 1;
  const state = run.state === "running" ? color.accent : run.state === "ok" ? color.add : color.remove;
  out.push({ text: "" });
  out.push({ text: `◇ Sub-agent #${seq} · ${run.state}${run.background ? " · background" : ""}`, color: state, bold: true });
  pushWrapped(out, run.objective, width, { color: color.faint }, "  ");
  if (run.sessionId) out.push({ text: `  session ${run.sessionId}`, color: color.faint });
  for (const step of run.steps) {
    const mark = step.status === "running" ? "◌" : step.status === "error" ? glyph.fail : glyph.ok;
    const tone = step.status === "error" ? color.remove : step.status === "running" ? color.accent : color.add;
    const subject = toolSubject(step);
    const took = duration(step);
    out.push({ text: "" });
    pushWrapped(out, `${mark} ${toolLabel(step)}${subject ? `  ${subject}` : ""}${took ? `  (${took})` : ""}`, width, { color: tone }, "  ");
    const res = outputLines(step.resultText);
    for (const l of res.slice(0, 30)) pushWrapped(out, l, width, { color: step.status === "error" ? color.remove : undefined }, "    ");
    if (res.length > 30) out.push({ text: `    … ${res.length - 30} more lines`, color: color.faint });
  }
  if (run.text) {
    out.push({ text: "" });
    out.push({ text: "  Conclusion", bold: true });
    pushWrapped(out, run.text, width, {}, "  ");
  }
}

/** Full detail of one tool call as pre-wrapped lines. */
export function detailLines(tool: ToolRow, width: number): ViewLine[] {
  const out: ViewLine[] = [];
  const kind = agentType(tool);
  const took = duration(tool);
  const st = statusWord(tool.status);
  out.push({ text: `${toolLabel(tool)}${kind ? ` · ${kind}` : ""}`, bold: true });
  out.push({ text: `${st.text}${took ? ` in ${took}` : ""} · ${tool.name} · ${tool.id}`, color: st.color });
  out.push({ text: "" });

  const command = tool.category === "bash" ? bashCommand(tool) : undefined;
  if (command !== undefined) {
    out.push({ text: "Command", bold: true });
    command.replace(/\n+$/, "").split("\n").forEach((l, i) => pushWrapped(out, `${i === 0 ? "$ " : "  "}${l}`, width, { color: color.info }, "  "));
    const rest = { ...(tool.input as Record<string, unknown>) };
    delete rest.command;
    delete rest.cmd;
    if (Object.keys(rest).length > 0) for (const l of pretty(rest)) pushWrapped(out, l, width, { color: color.faint }, "  ");
  } else if (tool.category === "task") {
    out.push({ text: "Objective", bold: true });
    pushWrapped(out, toolSubject(tool), width, {}, "  ");
  } else {
    out.push({ text: "Input", bold: true });
    for (const l of pretty(tool.input)) pushWrapped(out, l, width, { color: color.faint }, "  ");
  }

  for (const run of tool.subagents ?? []) runLines(out, run, width);

  out.push({ text: "" });
  out.push({ text: tool.category === "task" ? "Result returned to the agent" : "Output", bold: true });
  if (tool.status === "running") out.push({ text: "  (still running)", color: color.faint });
  else {
    const res = outputLines(tool.resultText);
    if (res.length === 0) out.push({ text: "  (no output)", color: color.faint });
    for (const l of res) pushWrapped(out, l, width, { color: tool.status === "error" ? color.remove : undefined }, "  ");
  }
  if (tool.artifactRef) {
    out.push({ text: "" });
    out.push({ text: `Full output stored as artifact ${tool.artifactRef}`, color: color.faint });
  }
  return out;
}

function listLine(tool: ToolRow, width: number): string {
  const mark = tool.status === "running" ? "◌" : tool.status === "error" ? glyph.fail : glyph.ok;
  const runs = tool.subagents?.length ?? 0;
  const steps = (tool.subagents ?? []).reduce((n, r) => n + r.steps.length, 0);
  const extra = runs > 0 ? `  [${runs > 1 ? `${runs} agents, ` : ""}${steps} steps]` : "";
  const took = duration(tool);
  const subject = toolSubject(tool).replace(/\s+/g, " ");
  return truncateToWidth(`${mark} ${toolLabel(tool).padEnd(10)} ${subject}${extra}${took ? `  ${took}` : ""}`, width);
}

export function ToolViewer({
  rows,
  width,
  height,
  onClose,
}: {
  rows: readonly Row[];
  width: number;
  /** Total rows the overlay may use, including its header and footer. */
  height: number;
  onClose: () => void;
}): React.ReactElement {
  const tools = viewerTools(rows);
  const [selected, setSelected] = React.useState(Math.max(0, tools.length - 1));
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [scroll, setScroll] = React.useState(0);
  const inner = Math.max(20, width - 2);
  const body = Math.max(3, height - 3);

  const open = openId ? tools.find((t) => t.id === openId) : undefined;
  const lines = open ? detailLines(open, inner) : [];
  const maxScroll = Math.max(0, lines.length - body);

  useInput((ch, key) => {
    if (open) {
      const page = Math.max(1, body - 1);
      if (isEscape(ch, key) || key.leftArrow || ch === "q") {
        setOpenId(null);
        setScroll(0);
      } else if (key.ctrl && ch === "o") onClose();
      else if (key.upArrow || ch === "k") setScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow || ch === "j") setScroll((s) => Math.min(maxScroll, s + 1));
      else if (key.pageUp || ch === "b") setScroll((s) => Math.max(0, s - page));
      else if (key.pageDown || ch === " ") setScroll((s) => Math.min(maxScroll, s + page));
      else if (ch === "g") setScroll(0);
      else if (ch === "G") setScroll(maxScroll);
      return;
    }
    if (isEscape(ch, key) || ch === "q" || (key.ctrl && ch === "o")) onClose();
    else if (key.upArrow || ch === "k") setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow || ch === "j") setSelected((i) => Math.min(tools.length - 1, i + 1));
    else if (key.pageUp) setSelected((i) => Math.max(0, i - body));
    else if (key.pageDown) setSelected((i) => Math.min(tools.length - 1, i + body));
    else if (ch === "g") setSelected(0);
    else if (ch === "G") setSelected(tools.length - 1);
    else if ((key.return || key.rightArrow) && tools[selected]) {
      setOpenId(tools[selected]!.id);
      setScroll(0);
    }
  });

  if (open) {
    const top = Math.min(scroll, maxScroll);
    const view = lines.slice(top, top + body);
    const pct = lines.length <= body ? "all" : `${Math.round(((top + view.length) / lines.length) * 100)}%`;
    return (
      <Box flexDirection="column" height={height}>
        <Text color={color.accent} bold wrap="truncate-end">
          {truncateToWidth(`${glyph.logo} Tool details · ${toolLabel(open)} ${toolSubject(open).replace(/\s+/g, " ")}`, inner)}
        </Text>
        <Box flexDirection="column" height={body} paddingLeft={1}>
          {view.map((l, i) => (
            <Text key={top + i} color={l.color} bold={l.bold} wrap="truncate-end">
              {l.text || " "}
            </Text>
          ))}
        </Box>
        <Text color={color.edge}>{"─".repeat(Math.min(inner, 120))}</Text>
        <Text color={color.faint} wrap="truncate-end">
          ↑↓/jk scroll {glyph.dot} PgUp/PgDn page {glyph.dot} g/G top/bottom {glyph.dot} esc back {glyph.dot} ^O close {glyph.dot} {pct}
        </Text>
      </Box>
    );
  }

  const first = Math.max(0, Math.min(selected - Math.floor(body / 2), tools.length - body));
  const visible = tools.slice(first, first + body);
  return (
    <Box flexDirection="column" height={height}>
      <Text color={color.accent} bold>
        {glyph.logo} Tool calls · {tools.length}
      </Text>
      <Box flexDirection="column" height={body} paddingLeft={1}>
        {tools.length === 0 ? <Text color={color.faint}>No tool calls in this session yet.</Text> : null}
        {visible.map((t, i) => {
          const idx = first + i;
          const sel = idx === selected;
          return (
            <Text
              key={t.id}
              color={sel ? color.accent : t.status === "error" ? color.remove : undefined}
              bold={sel}
              inverse={sel}
              wrap="truncate-end"
            >
              {listLine(t, inner - 1)}
            </Text>
          );
        })}
      </Box>
      <Text color={color.edge}>{"─".repeat(Math.min(inner, 120))}</Text>
      <Text color={color.faint} wrap="truncate-end">
        ↑↓ select {glyph.dot} ↵ open {glyph.dot} esc/^O close
      </Text>
    </Box>
  );
}
