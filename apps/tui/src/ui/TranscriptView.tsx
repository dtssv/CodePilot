/**
 * Transcript rendering. Each row renders on its own: finished rows are printed
 * once into terminal scrollback through Ink's `<Static>`, and only rows still
 * changing (streaming text, running tools, active sub-agents) live in the
 * redrawn region at the bottom. The same components serve both; `live` only
 * switches on animation and the compact "tail" views.
 */
import React from "react";
import { Box, Text, useStdout } from "ink";
import { hasVisibleAssistantContent, type PlanStep } from "@codepilot/core";
import { Markdown } from "./Markdown.js";
import type { MessageRow, Row, SubagentRun, ToolRow } from "./state.js";
import { brand, color, formatDuration, glyph, oneLine, shortPath } from "./theme.js";
import { tokenizeLine, type TokenKind } from "./highlight.js";
import { syntax } from "./theme.js";
import { planProgress } from "./transcript.js";
import { agentType, bashCommand, editDiff, resultPreview, toolLabel, toolSubject } from "./toolDisplay.js";
import { wrapLine } from "./textWidth.js";

const SYNTAX_COLOR: Record<TokenKind, string | undefined> = {
  plain: undefined,
  comment: syntax.comment,
  string: syntax.string,
  number: syntax.number,
  keyword: syntax.keyword,
};

/** Rows that never render anything (bookkeeping only). */
export function isVisibleRow(row: Row): boolean {
  switch (row.kind) {
    case "usage":
      return false;
    case "assistant":
      return hasVisibleAssistantContent(row.msg.text) || !!row.msg.reasoning?.trim();
    case "tool":
      return row.tool.category !== "plan";
    default:
      return true;
  }
}

export interface RowView {
  /** Expanded state; `undefined` keeps the row's own default. */
  open?: boolean;
  focused?: boolean;
  /** The window renders each sub-agent run as its own row, so the parent card
   * must not print them again. */
  runsNested?: boolean;
}

export function TranscriptItem({
  row,
  live = false,
  maxLines,
  view,
}: {
  row: Row;
  live?: boolean;
  /** Live only: cap for streaming text so the redrawn region stays short. */
  maxLines?: number;
  /** Window state: expanded/focused. Omitted for one-shot renders. */
  view?: RowView;
}): React.ReactElement | null {
  switch (row.kind) {
    case "user":
      return <UserItem text={row.text} steer={row.steer} />;
    case "assistant":
      return (
        <AssistantItem
          msg={row.msg}
          maxLines={live ? maxLines : undefined}
          open={view?.open}
          focused={view?.focused}
        />
      );
    case "tool":
      return row.tool.category === "plan" ? null : (
        <ToolItem
          tool={row.tool}
          live={live}
          open={view?.open}
          focused={view?.focused}
          runsNested={view?.runsNested}
        />
      );
    case "plan":
      return <PlanItem steps={row.plan} open={view?.open} focused={view?.focused} />;
    case "usage":
      return null;
    default:
      return <NoticeItem row={row} />;
  }
}

/* ---------------- welcome ---------------- */

export function WelcomeBanner({
  version,
  model,
  providerId,
  cwd,
  agentMode,
  permissionMode,
  connection,
  width,
}: {
  version: string;
  model?: string;
  providerId?: string;
  cwd: string;
  agentMode: string;
  permissionMode: string;
  connection?: string;
  width: number;
}): React.ReactElement {
  const mode = agentMode === "plan" ? "Plan" : agentMode === "chat" ? "Ask" : "Agent";
  // No surrounding box: a bordered card competes with the prompt below it for
  // the eye and costs four lines of chrome. A logo line plus a hairline rule
  // separates the header from the conversation just as clearly.
  const inner = Math.max(32, Math.min(width - 2, 78));
  const label = (s: string): React.ReactElement => <Text color={color.faint}>{s.padEnd(7)}</Text>;
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} marginBottom={1} width={inner}>
      <Box marginBottom={1}>
        <Text bold>
          <Text color={brand[0]}>{glyph.logo} </Text>
          <Text color={brand[0]}>Code</Text>
          <Text color={brand[2]}>Pilot</Text>
        </Text>
        <Text color={color.faint}>  v{version}</Text>
        <Box flexGrow={1} />
        <Text color={color.accent}>{mode}</Text>
        <Text color={color.faint}> {glyph.dot} {permissionMode}</Text>
        {connection ? <Text color={color.faint}> {glyph.dot} {connection}</Text> : null}
      </Box>
      <Text>
        {label("model")}
        {providerId ? <Text color={color.faint}>{providerId} {glyph.dot} </Text> : null}
        <Text>{model ?? "not configured — run /connect"}</Text>
      </Text>
      <Text>
        {label("folder")}
        <Text>{shortPath(cwd)}</Text>
      </Text>
      {/* A drawn box border, not a repeated string: the rule then follows the
          box's real content width instead of overflowing it and wrapping. */}
      <Box marginTop={1} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderColor={color.edge} width="100%" />
      <Box marginTop={1}>
        <Text color={color.faint}>
          / commands {glyph.dot} @ files {glyph.dot} ⇧⇥ mode {glyph.dot} ^O details {glyph.dot} ^C stop
        </Text>
      </Box>
    </Box>
  );
}

/* ---------------- user / assistant ---------------- */

function UserItem({ text, steer }: { text: string; steer?: boolean }): React.ReactElement {
  if (steer) {
    return (
      <Box marginTop={1} flexDirection="row">
        <Text color={color.accent} dimColor>
          ✶{" "}
        </Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={color.accent} dimColor>
            inject ·{" "}
          </Text>
          <Text dimColor>{text.trim() || " "}</Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box marginTop={1} flexDirection="row">
      <Text color={color.accent} bold>
        {glyph.user}{" "}
      </Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text bold>{text.trim() || " "}</Text>
      </Box>
    </Box>
  );
}

/** Last `n` lines of streaming markdown, reopening a code fence cut in half. */
export function tailMarkdown(text: string, n: number): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= n) return { text, hidden: 0 };
  const cut = lines.length - n;
  const head = lines.slice(0, cut);
  const fences = head.filter((l) => /^\s*(```|~~~)/.test(l)).length;
  const tail = lines.slice(cut);
  return { text: (fences % 2 === 1 ? "```\n" : "") + tail.join("\n"), hidden: cut };
}

function AssistantItem({
  msg,
  maxLines,
  open,
  focused,
}: {
  msg: MessageRow;
  maxLines?: number;
  open?: boolean;
  focused?: boolean;
}): React.ReactElement {
  const streaming = msg.streaming;
  const body = maxLines !== undefined ? tailMarkdown(msg.text, Math.max(3, maxLines)) : { text: msg.text, hidden: 0 };
  const reasoning = msg.reasoning?.trim() ?? "";
  const showText = hasVisibleAssistantContent(msg.text);
  return (
    <Box marginTop={1} flexDirection="column">
      {reasoning ? <ThinkingItem text={reasoning} live={streaming && !showText} open={open} focused={focused} /> : null}
      {showText ? (
        <Box flexDirection="row">
          <Text color={focused ? color.accent : color.accent}>{focused ? "▸" : glyph.assistant} </Text>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} width="100%">
            {body.hidden > 0 ? <Text color={color.faint}>… {body.hidden} lines above</Text> : null}
            {streaming && maxLines !== undefined ? (
              <LivePlain text={body.text} />
            ) : (
              <Markdown dimColor={false} final={!streaming}>{body.text}</Markdown>
            )}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

/** Streaming tail rendered as hard-wrapped plain lines. Avoids Ink/yoga wrap
 * edge cases on CJK that can make a frame one column wider than the terminal
 * and scroll blank lines into scrollback. */
function LivePlain({ text }: { text: string }): React.ReactElement {
  const { stdout } = useStdout();
  const width = Math.max(20, (stdout.columns || 80) - 8);
  const lines: string[] = [];
  for (const logical of text.split("\n")) {
    for (const piece of wrapLine(logical, width)) lines.push(piece);
  }
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>{l || " "}</Text>
      ))}
    </Box>
  );
}

function ThinkingItem({
  text,
  live,
  open = false,
  focused = false,
}: {
  text: string;
  live: boolean;
  open?: boolean;
  focused?: boolean;
}): React.ReactElement {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  // Open rows show the reasoning in full; collapsed rows keep the tail while
  // streaming (progress is the point) and the head once it has settled.
  const shown = open ? lines : live ? lines.slice(-2) : lines.slice(0, 1);
  const more = lines.length - shown.length;
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={focused ? color.accent : color.faint} italic>
        {open ? "▾" : "▸"} ✻ Thinking{focused ? " · ↵ open" : ""}
        {more > 0 && !open ? ` · ${more} more lines` : ""}
      </Text>
      {shown.length > 0 ? (
        <Box paddingLeft={2} flexDirection="column">
          {shown.map((l, i) => (
            <Text key={i} color={color.faint} italic wrap="truncate-end">
              {l}
            </Text>
          ))}
        </Box>
      ) : null}
      {open && more > 0 ? (
        <Box paddingLeft={2}>
          <Text color={color.faint}>… {more} more lines</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/* ---------------- tools ---------------- */

const BLINK = ["●", "○"];

function useTick(active: boolean, ms: number): number {
  const [n, setN] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((i) => i + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return n;
}

function StatusDot({ status, live }: { status: ToolRow["status"]; live: boolean }): React.ReactElement {
  const tick = useTick(live && status === "running", 500);
  if (status === "running") return <Text color={color.accent}>{BLINK[tick % 2]}</Text>;
  if (status === "error") return <Text color={color.remove}>●</Text>;
  return <Text color={color.add}>●</Text>;
}

function elapsed(tool: Pick<ToolRow, "startedAt" | "finishedAt" | "status">, now: number): string {
  if (!tool.startedAt) return "";
  const end = tool.finishedAt ?? (tool.status === "running" ? now : undefined);
  if (end === undefined) return "";
  const ms = end - tool.startedAt;
  return ms >= 100 ? formatDuration(ms) : "";
}

export function ShellCommand({ command, maxLines }: { command: string; maxLines?: number }): React.ReactElement {
  const all = command.replace(/\n+$/, "").split("\n");
  const lines = maxLines !== undefined ? all.slice(0, maxLines) : all;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>
          <Text color={color.faint}>{i === 0 ? "$ " : "  "}</Text>
          {tokenizeLine(line, "bash").map((tok, j) => (
            <Text key={j} color={SYNTAX_COLOR[tok.kind]}>
              {tok.text}
            </Text>
          ))}
        </Text>
      ))}
      {all.length > lines.length ? <Text color={color.faint}>  … {all.length - lines.length} more lines</Text> : null}
    </Box>
  );
}

/** "⎿" gutter for a tool's result lines. */
function Result({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="row" paddingLeft={2}>
      <Text color={color.faint}>⎿  </Text>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

export function ToolHeader({
  tool,
  live = false,
  open = false,
  focused = false,
}: {
  tool: ToolRow;
  live?: boolean;
  /** Open state, only used for the fold marker. */
  open?: boolean;
  /** Keyboard focus, drawn as a caret so the row is discoverable. */
  focused?: boolean;
}): React.ReactElement {
  useTick(live && tool.status === "running", 1000);
  const label = toolLabel(tool);
  const took = elapsed(tool, Date.now());
  const command = tool.category === "bash" ? bashCommand(tool) : undefined;
  const subject = command === undefined ? toolSubject(tool) : "";
  const kind = tool.category === "task" ? agentType(tool) : undefined;
  const multiLine = command !== undefined && (command.includes("\n") || command.length > 70);
  const collapsible = isCollapsible(tool);

  return (
    <Box flexDirection="row">
      <Text color={focused ? color.accent : color.faint}>{focused ? "▸ " : "  "}</Text>
      <StatusDot status={tool.status} live={live} />
      <Text> </Text>
      <Box flexDirection="row" flexShrink={1}>
        <Text bold>{label}</Text>
        {kind ? <Text color={color.info}> {kind}</Text> : null}
        {command !== undefined && !multiLine ? (
          <Text>
            {"  "}
            {tokenizeLine(command, "bash").map((tok, j) => (
              <Text key={j} color={SYNTAX_COLOR[tok.kind]}>
                {tok.text}
              </Text>
            ))}
          </Text>
        ) : subject ? (
          <Box flexShrink={1}>
            <Text color={tool.category === "task" ? undefined : color.faint}>  {subject}</Text>
          </Box>
        ) : null}
        {tool.added ? <Text color={color.add}>  +{tool.added}</Text> : null}
        {tool.removed ? <Text color={color.remove}> −{tool.removed}</Text> : null}
      </Box>
      {took ? <Text color={color.faint}> {glyph.dot} {took}</Text> : null}
      {collapsible ? (
        <Text color={color.faint}>
          {"  "}
          {open ? "▾" : "▸"}
          {focused && !open ? " ↵" : ""}
        </Text>
      ) : null}
    </Box>
  );
}

/** A tool card: header line plus the body the viewport decided to show. */
export function ToolItem({
  tool,
  live = false,
  open = false,
  focused = false,
  runsNested = false,
}: {
  tool: ToolRow;
  live?: boolean;
  open?: boolean;
  focused?: boolean;
  runsNested?: boolean;
}): React.ReactElement {
  const command = tool.category === "bash" ? bashCommand(tool) : undefined;
  const multiLine = command !== undefined && (command.includes("\n") || command.length > 70);
  return (
    <Box flexDirection="column">
      <ToolHeader tool={tool} live={live} open={open} focused={focused} />
      {multiLine && (open || live) ? (
        <Box paddingLeft={2} marginTop={0}>
          <Box
            borderStyle="single"
            borderLeft
            borderRight={false}
            borderTop={false}
            borderBottom={false}
            borderColor={color.edge}
            paddingLeft={1}
          >
            <ShellCommand command={command!} maxLines={open ? 24 : live ? 4 : 8} />
          </Box>
        </Box>
      ) : null}
      <ToolBody tool={tool} live={live} open={open} runsNested={runsNested} />
    </Box>
  );
}

/** Whether a row has anything to fold away. */
export function isCollapsibleRow(row: Row): boolean {
  switch (row.kind) {
    case "tool":
      return isCollapsible(row.tool);
    case "assistant":
      return !!row.msg.reasoning?.trim();
    case "plan":
      return row.plan.length > 2;
    default:
      return false;
  }
}

/** Rows that show their body without the user asking. */
export function defaultOpen(row: Row): boolean {
  switch (row.kind) {
    case "plan":
      return true;
    case "tool":
      return row.tool.status === "running";
    default:
      return false;
  }
}

/** Sub-agent runs nested in a tool row, for the drill-down view. */
export function subagentRuns(row: Row): readonly SubagentRun[] {
  return row.kind === "tool" ? (row.tool.subagents ?? []) : [];
}

/** Tools whose body is worth folding: anything with output, a diff, or children. */
function isCollapsible(tool: ToolRow): boolean {
  if ((tool.subagents?.length ?? 0) > 0) return true;
  if (tool.status === "running") return false;
  if (tool.category === "edit" || tool.category === "write") return true;
  const lines = (tool.resultText ?? "").split("\n").length;
  return lines > 4;
}

function ToolBody({
  tool,
  live,
  open,
  runsNested = false,
}: {
  tool: ToolRow;
  live: boolean;
  open: boolean;
  runsNested?: boolean;
}): React.ReactElement | null {
  if (tool.category === "task" || (tool.subagents?.length ?? 0) > 0) {
    // Nested rows already print every run below this header; repeating them here
    // is what made one delegation read as three identical objectives.
    return runsNested ? null : <SubagentBody tool={tool} live={live} open={open} />;
  }
  if (tool.status === "running") {
    return live ? (
      <Result>
        <Text color={color.faint}>running…</Text>
      </Result>
    ) : null;
  }
  if ((tool.category === "edit" || tool.category === "write") && tool.status === "ok") {
    const diff = editDiff(tool, open ? 200 : 10);
    if (diff.lines.length === 0) return null;
    return (
      <Result>
        {diff.lines.map((l, i) => (
          <Text key={i} color={l.sign === "+" ? color.add : l.sign === "-" ? color.remove : color.faint} wrap="truncate-end">
            {l.sign} {l.text}
          </Text>
        ))}
        {diff.hidden > 0 ? <Text color={color.faint}>… {diff.hidden} more lines · ↵ to open</Text> : null}
      </Result>
    );
  }
  const preview = resultPreview(tool, open ? 200 : 4);
  if (preview.lines.length === 0) return null;
  const tone = preview.tone === "error" ? color.remove : preview.tone === "faint" ? color.faint : undefined;
  return (
    <Result>
      {preview.lines.map((l, i) => (
        <Text key={i} color={tone} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
      {preview.hidden > 0 ? <Text color={color.faint}>… {preview.hidden} more lines · ↵ to open</Text> : null}
    </Result>
  );
}

function stepLine(step: ToolRow): string {
  const subject = toolSubject(step);
  return `${toolLabel(step)}${subject ? `  ${oneLine(subject, 90)}` : ""}`;
}

function SubagentBody({
  tool,
  live,
  open,
}: {
  tool: ToolRow;
  live: boolean;
  open: boolean;
}): React.ReactElement | null {
  const runs = tool.subagents ?? [];
  if (runs.length === 0) {
    if (tool.status === "running") {
      return live ? (
        <Result>
          <Text color={color.faint}>starting sub-agent…</Text>
        </Result>
      ) : null;
    }
    const preview = resultPreview({ ...tool, category: "other" }, 3);
    return preview.lines.length > 0 ? (
      <Result>
        {preview.lines.map((l, i) => (
          <Text key={i} color={tool.status === "error" ? color.remove : color.faint} wrap="truncate-end">
            {l}
          </Text>
        ))}
      </Result>
    ) : null;
  }
  return (
    <Result>
      {runs.map((run) => (
        <SubagentRunView key={run.index} run={run} multi={runs.length > 1} live={live} open={open} />
      ))}
    </Result>
  );
}

export function SubagentRunView({
  run,
  multi,
  live,
  open,
  focused = false,
  drillable = false,
}: {
  run: SubagentRun;
  multi: boolean;
  live: boolean;
  open: boolean;
  focused?: boolean;
  /** Adds the ↵ affordance; the parent owns what ↵ does. */
  drillable?: boolean;
}): React.ReactElement {
  // Open cards keep the whole step list; collapsed ones stay a glance (progress
  // plus the tail) so a long sub-agent run cannot swallow the viewport.
  const keep = open ? run.steps.length : live ? 4 : 3;
  const hidden = Math.max(0, run.steps.length - keep);
  const shown = run.steps.slice(hidden);
  const ms = run.startedAt ? (run.finishedAt ?? Date.now()) - run.startedAt : 0;
  const stateColor = run.state === "running" ? color.accent : run.state === "ok" ? color.add : color.remove;
  const stateWord = run.state === "running" ? "working" : run.state === "ok" ? "done" : run.state;
  const previewLines = run.text
    ? run.text
        .split("\n")
        .map((l) => l.replace(/\*\*|__|`/g, "").replace(/^#+\s*/, ""))
        .filter((l) => l.trim())
        .slice(0, run.state === "running" ? 1 : 2)
    : [];
  return (
    <Box flexDirection="column">
      {/* Header: the objective is the content, so it gets the normal foreground
          and the whole width; state and cost move to a right-aligned tail. */}
      <Box flexDirection="row">
        <Text color={focused ? color.accent : stateColor}>{focused ? "▸ " : "◇ "}</Text>
        {multi ? <Text bold color={color.info}>#{(run.runSeq ?? run.index + 1)} </Text> : null}
        <Box flexGrow={1} flexShrink={1} marginRight={1}>
          <Text bold={focused} wrap="truncate-end">
            {run.objective.replace(/\s+/g, " ").trim()}
          </Text>
        </Box>
        <Text color={color.faint}>
          <Text color={stateColor}>{stateWord}</Text>
          {" "}
          {run.steps.length} {run.steps.length === 1 ? "step" : "steps"}
          {ms >= 100 ? ` ${glyph.dot} ${formatDuration(ms)}` : ""}
          {run.background ? ` ${glyph.dot} bg` : ""}
          {drillable ? (focused ? ` ${glyph.dot} ↵ open` : ` ${glyph.dot} ↵`) : ""}
        </Text>
      </Box>
      {/* A hairline gutter ties the steps to the run without another indent
          level, and keeps sibling runs visibly separate. */}
      <Box flexDirection="column" paddingLeft={2}>
        {hidden > 0 ? <Text color={color.faint}>… {hidden} earlier steps</Text> : null}
        {shown.map((s) => {
          const open = s.status === "running" && run.state === "running";
          const mark = open ? "◌" : s.status === "error" ? glyph.fail : s.status === "running" ? glyph.dot : glyph.ok;
          const tint = open ? color.accent : s.status === "error" ? color.remove : s.status === "running" ? color.faint : color.add;
          return (
            <Text key={s.id} wrap="truncate-end">
              <Text color={tint}>{mark} </Text>
              <Text color={open ? undefined : color.faint}>{stepLine(s)}</Text>
            </Text>
          );
        })}
        {previewLines.map((l, i) => (
          <Text key={i} wrap="truncate-end" color={run.state === "running" ? color.faint : undefined}>
            {l}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/* ---------------- plan & notices ---------------- */

function PlanItem({
  steps,
  open = true,
  focused = false,
}: {
  steps: PlanStep[];
  open?: boolean;
  focused?: boolean;
}): React.ReactElement {
  const { done, total } = planProgress(steps);
  const shown = open ? steps : steps.filter((s) => s.status !== "completed");
  const folded = steps.length - shown.length;
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        <Text color={focused ? color.accent : color.info}>{focused ? "▸ " : "▤ "}</Text>
        <Text bold>Plan</Text>
        <Text color={color.faint}>  {done}/{total} done</Text>
        <Text color={color.faint}>
          {"  "}
          {open ? "▾" : "▸"}
          {folded > 0 ? ` ${folded} hidden` : ""}
        </Text>
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {shown.map((s) => (
          <Text key={s.id}>
            {s.status === "completed" ? (
              <Text color={color.add}>{glyph.ok} </Text>
            ) : s.status === "in_progress" ? (
              <Text color={color.accent}>{glyph.active} </Text>
            ) : (
              <Text color={color.faint}>{glyph.pending} </Text>
            )}
            <Text
              color={s.status === "completed" ? color.faint : s.status === "in_progress" ? color.accent : undefined}
              bold={s.status === "in_progress"}
              strikethrough={s.status === "completed"}
            >
              {s.title}
            </Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function NoticeItem({ row }: { row: Exclude<Row, { kind: "user" | "assistant" | "tool" | "plan" | "usage" }> }): React.ReactElement | null {
  switch (row.kind) {
    case "retry": {
      const wait = row.delayMs > 0 ? ` in ${formatDuration(row.delayMs)}` : "";
      return (
        <Box marginTop={1}>
          <Text color={color.warn}>
            {glyph.retry} Retrying ({row.attempt}/{row.maxAttempts}){wait}
          </Text>
          {row.reason.trim() ? <Text color={color.faint}> {glyph.dot} {oneLine(row.reason, 100)}</Text> : null}
        </Box>
      );
    }
    case "error":
      return (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={row.recoverable ? color.warn : color.remove} paddingX={1}>
          <Text color={row.recoverable ? color.warn : color.remove} bold>
            {row.recoverable ? `${glyph.warn} Something went wrong` : `${glyph.fail} The run stopped`}
          </Text>
          <Text>{row.message}</Text>
          <Text color={color.faint}>/retry sends the last prompt again.</Text>
        </Box>
      );
    case "compaction":
      return (
        <Box marginTop={1}>
          <Text color={color.faint}>
            {glyph.compact} Context compacted {glyph.dot} {oneLine(row.summary, 100)}
          </Text>
        </Box>
      );
    case "system":
      return (
        <Box marginTop={1}>
          <Text color={color.faint}>
            {glyph.dot} {row.text}
          </Text>
        </Box>
      );
    case "goal": {
      const cap = row.maxRounds ? `/${row.maxRounds}` : "";
      const head =
        row.status === "running"
          ? `${glyph.active} Goal · round ${row.round}${cap} · running…`
          : row.status === "completed"
            ? `${glyph.ok} Goal · completed after round ${row.round}${cap}`
            : row.status === "blocked"
              ? `${glyph.warn} Goal · blocked at round ${row.round}${cap}`
              : `${glyph.warn} Goal · round limit (${row.round}${cap})`;
      const tint = row.status === "completed" ? color.add : row.status === "running" ? color.accent : color.warn;
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={tint}>{head}</Text>
          {row.detail ? <Text color={color.faint}>  {oneLine(row.detail, 120)}</Text> : null}
        </Box>
      );
    }
    case "team": {
      const tint =
        row.msgKind === "assignment" ? color.info
        : row.msgKind === "conclusion" ? color.add
        : row.msgKind === "conflict" ? color.warn
        : row.msgKind === "summary" ? color.accent
        : color.faint;
      const full = row.msgKind === "assignment" || row.msgKind === "conflict";
      const lines = row.text.split("\n");
      const body = full ? row.text : lines.slice(0, 2).join("\n") + (lines.length > 2 ? `\n… ${lines.length - 2} more lines` : "");
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={tint}>
            ⇄ {row.msgKind ?? "msg"} {glyph.dot} {row.from} {glyph.arrow} {row.to}
          </Text>
          <Box marginLeft={2}>
            <Text color={color.faint}>{body}</Text>
          </Box>
        </Box>
      );
    }
  }
}
