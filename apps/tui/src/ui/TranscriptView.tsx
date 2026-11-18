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

export function TranscriptItem({
  row,
  live = false,
  maxLines,
}: {
  row: Row;
  live?: boolean;
  /** Live only: cap for streaming text so the redrawn region stays short. */
  maxLines?: number;
}): React.ReactElement | null {
  switch (row.kind) {
    case "user":
      return <UserItem text={row.text} />;
    case "assistant":
      return <AssistantItem msg={row.msg} maxLines={live ? maxLines : undefined} />;
    case "tool":
      return row.tool.category === "plan" ? null : <ToolItem tool={row.tool} live={live} />;
    case "plan":
      return <PlanItem steps={row.plan} />;
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
  const label = (s: string): React.ReactElement => <Text color={color.faint}>{s.padEnd(8)}</Text>;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color.edge}
      paddingX={2}
      paddingY={0}
      width={Math.max(40, Math.min(width - 2, 76))}
      marginBottom={1}
    >
      <Box marginBottom={1}>
        <Text bold>
          <Text color={brand[0]}>{glyph.logo} </Text>
          <Text color={brand[0]}>Code</Text>
          <Text color={brand[2]}>Pilot</Text>
        </Text>
        <Text color={color.faint}>  v{version}</Text>
      </Box>
      <Text>
        {label("model")}
        {providerId ? <Text color={color.faint}>{providerId} · </Text> : null}
        <Text>{model ?? "not configured — run /connect"}</Text>
      </Text>
      <Text>
        {label("folder")}
        <Text>{shortPath(cwd)}</Text>
      </Text>
      <Text>
        {label("mode")}
        <Text color={color.accent}>{mode}</Text>
        <Text color={color.faint}> · {permissionMode}</Text>
        {connection ? <Text color={color.faint}> · {connection}</Text> : null}
      </Text>
      <Box marginTop={1}>
        <Text color={color.faint}>
          / commands {glyph.dot} @ files {glyph.dot} ⇧⇥ mode {glyph.dot} ^O tool details {glyph.dot} ^C stop
        </Text>
      </Box>
    </Box>
  );
}

/* ---------------- user / assistant ---------------- */

function UserItem({ text }: { text: string }): React.ReactElement {
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

function AssistantItem({ msg, maxLines }: { msg: MessageRow; maxLines?: number }): React.ReactElement {
  const streaming = msg.streaming;
  const body = maxLines !== undefined ? tailMarkdown(msg.text, Math.max(3, maxLines)) : { text: msg.text, hidden: 0 };
  const reasoning = msg.reasoning?.trim() ?? "";
  const showText = hasVisibleAssistantContent(msg.text);
  return (
    <Box marginTop={1} flexDirection="column">
      {reasoning ? <ThinkingItem text={reasoning} live={streaming && !showText} /> : null}
      {showText ? (
        <Box flexDirection="row">
          <Text color={color.accent}>{glyph.assistant} </Text>
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

function ThinkingItem({ text, live }: { text: string; live: boolean }): React.ReactElement {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const shown = live ? lines.slice(-3) : lines.slice(0, 3);
  const more = lines.length - shown.length;
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={color.faint} italic>
        ✻ Thinking{more > 0 ? ` · ${more} more lines` : ""}
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        {shown.map((l, i) => (
          <Text key={i} color={color.faint} italic wrap="truncate-end">
            {l}
          </Text>
        ))}
      </Box>
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

export function ToolItem({ tool, live = false }: { tool: ToolRow; live?: boolean }): React.ReactElement {
  useTick(live && tool.status === "running", 1000);
  const label = toolLabel(tool);
  const took = elapsed(tool, Date.now());
  const command = tool.category === "bash" ? bashCommand(tool) : undefined;
  const subject = command === undefined ? toolSubject(tool) : "";
  const kind = tool.category === "task" ? agentType(tool) : undefined;
  const multiLineCommand = command !== undefined && (command.includes("\n") || command.length > 70);

  return (
    <Box marginTop={1} flexDirection="column">
      <Box flexDirection="row">
        <StatusDot status={tool.status} live={live} />
        <Text> </Text>
        <Box flexDirection="row" flexShrink={1}>
          <Text bold>{label}</Text>
          {kind ? <Text color={color.info}> {kind}</Text> : null}
          {command !== undefined && !multiLineCommand ? (
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
      </Box>
      {multiLineCommand ? (
        <Box paddingLeft={2} marginTop={0}>
          <Box borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor={color.edge} paddingLeft={1}>
            <ShellCommand command={command!} maxLines={live ? 4 : 8} />
          </Box>
        </Box>
      ) : null}
      <ToolBody tool={tool} live={live} />
    </Box>
  );
}

function ToolBody({ tool, live }: { tool: ToolRow; live: boolean }): React.ReactElement | null {
  if (tool.category === "task" || (tool.subagents?.length ?? 0) > 0) {
    return <SubagentBody tool={tool} live={live} />;
  }
  if (tool.status === "running") {
    return live ? (
      <Result>
        <Text color={color.faint}>running…</Text>
      </Result>
    ) : null;
  }
  if ((tool.category === "edit" || tool.category === "write") && tool.status === "ok") {
    const diff = editDiff(tool, 10);
    if (diff.lines.length === 0) return null;
    return (
      <Result>
        {diff.lines.map((l, i) => (
          <Text key={i} color={l.sign === "+" ? color.add : l.sign === "-" ? color.remove : color.faint} wrap="truncate-end">
            {l.sign} {l.text}
          </Text>
        ))}
        {diff.hidden > 0 ? <Text color={color.faint}>… {diff.hidden} more lines · ^O to view</Text> : null}
      </Result>
    );
  }
  const preview = resultPreview(tool, 4);
  if (preview.lines.length === 0) return null;
  const tone = preview.tone === "error" ? color.remove : preview.tone === "faint" ? color.faint : undefined;
  return (
    <Result>
      {preview.lines.map((l, i) => (
        <Text key={i} color={tone} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
      {preview.hidden > 0 ? <Text color={color.faint}>… {preview.hidden} more lines · ^O to view</Text> : null}
    </Result>
  );
}

function stepLine(step: ToolRow): string {
  const subject = toolSubject(step);
  return `${toolLabel(step)}${subject ? `  ${oneLine(subject, 90)}` : ""}`;
}

function SubagentBody({ tool, live }: { tool: ToolRow; live: boolean }): React.ReactElement | null {
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
        <SubagentRunView key={run.index} run={run} multi={runs.length > 1} live={live} />
      ))}
    </Result>
  );
}

function SubagentRunView({ run, multi, live }: { run: SubagentRun; multi: boolean; live: boolean }): React.ReactElement {
  const keep = live ? 4 : 3;
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
      <Text>
        <Text color={stateColor}>◇ </Text>
        {multi ? <Text bold>#{(run.runSeq ?? run.index + 1)} </Text> : null}
        <Text color={color.faint}>{oneLine(run.objective, 80)}</Text>
      </Text>
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
        <Text color={color.faint}>
          <Text color={stateColor}>{stateWord}</Text>
          {" "}
          {glyph.dot} {run.steps.length} tool {run.steps.length === 1 ? "use" : "uses"}
          {ms >= 100 ? ` ${glyph.dot} ${formatDuration(ms)}` : ""}
          {run.background ? ` ${glyph.dot} background` : ""}
          {` ${glyph.dot} ^O to view`}
        </Text>
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

function PlanItem({ steps }: { steps: PlanStep[] }): React.ReactElement {
  const { done, total } = planProgress(steps);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        <Text color={color.info}>▤ </Text>
        <Text bold>Plan</Text>
        <Text color={color.faint}>  {done}/{total} done</Text>
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {steps.map((s) => (
          <Text key={s.id}>
            {s.status === "completed" ? (
              <Text color={color.add}>{glyph.ok} </Text>
            ) : s.status === "in_progress" ? (
              <Text color={color.accent}>{glyph.active} </Text>
            ) : s.status === "blocked" ? (
              <Text color={color.remove}>{glyph.fail} </Text>
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
