/**
 * Transcript blocks. Presentation only: rows come from `state.ts`, grouping
 * from `transcript.ts`, colors and wording from `theme.ts` — the same
 * vocabulary as the web, desktop and IDE clients.
 */
import React from "react";
import { Box, Text } from "ink";
import type { PlanStep } from "@codepilot/core";
import { Markdown } from "./Markdown.js";
import type { Row, ToolRow } from "./state.js";
import { CATEGORY_VERB, color, formatDuration, glyph, oneLine } from "./theme.js";
import { planProgress, type Block, type TurnPart } from "./transcript.js";

/** Finished groups longer than this show only their last steps. */
const MAX_STEPS_SHOWN = 8;

export function BlockView({ block }: { block: Block }): React.ReactElement | null {
  switch (block.kind) {
    case "user":
      return <UserBlock text={block.text} />;
    case "assistant_turn":
      return <AssistantTurnBlock parts={block.parts} />;
  }
}

/** One assistant glyph for the whole post-user turn. */
function AssistantTurnBlock({ parts }: { parts: TurnPart[] }): React.ReactElement | null {
  if (parts.length === 0) return null;
  return (
    <Box marginTop={1} flexDirection="row">
      <Text color={color.accent}>{glyph.assistant} </Text>
      <Box flexDirection="column" flexGrow={1}>
        {parts.map((p, i) => {
          switch (p.kind) {
            case "message":
              return (
                <Box key={p.msg.id} flexDirection="column">
                  {p.msg.reasoning ? <ReasoningBlock text={p.msg.reasoning} /> : null}
                  <Markdown dimColor={false}>{p.msg.text}</Markdown>
                </Box>
              );
            case "steps":
              return <StepsBlock key={`s-${p.tools[0]?.id ?? i}`} tools={p.tools} nested />;
            case "plan":
              return p.latest ? (
                <PlanBlock key={`p-${i}`} steps={p.steps} nested />
              ) : (
                <PlanMarker key={`p-${i}`} steps={p.steps} />
              );
            case "row":
              return <RowView key={`r-${p.row.kind}-${i}`} row={p.row} />;
          }
        })}
      </Box>
    </Box>
  );
}

/** Extended-thinking shown dimmed above the answer. Kept compact: the
 * terminal has no collapse affordance, so we label it and let the model's
 * reasoning read as a muted preamble rather than competing with the answer. */
function ReasoningBlock({ text }: { text: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color.faint}>
        {glyph.dot} thinking
      </Text>
      <Text color={color.faint} dimColor>
        {text.trim()}
      </Text>
    </Box>
  );
}

function UserBlock({ text }: { text: string }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={color.accent} bold>
        {glyph.user}{" "}
      </Text>
      <Box flexGrow={1}>
        <Text bold>{text || " "}</Text>
      </Box>
    </Box>
  );
}

/* ---------------- steps ---------------- */

function StepsBlock({ tools, nested }: { tools: ToolRow[]; nested?: boolean }): React.ReactElement {
  const running = tools.some((t) => t.status === "running");
  const failed = tools.filter((t) => t.status === "error").length;
  const started = Math.min(...tools.map((t) => t.startedAt ?? Number.POSITIVE_INFINITY));
  const finished = Math.max(...tools.map((t) => t.finishedAt ?? 0));
  const took = Number.isFinite(started) && finished - started >= 100 ? ` ${glyph.dot} ${formatDuration(finished - started)}` : "";
  const count = `${tools.length} ${tools.length === 1 ? "step" : "steps"}`;
  const hidden = !running && tools.length > MAX_STEPS_SHOWN ? tools.length - MAX_STEPS_SHOWN : 0;
  const shown = hidden > 0 ? tools.slice(hidden) : tools;

  return (
    <Box flexDirection="column" marginTop={nested ? 0 : 1}>
      {running ? (
        <Text color={color.accent}>
          {glyph.running} Working {glyph.dot} {count}
        </Text>
      ) : failed > 0 ? (
        <Text color={color.warn}>
          {glyph.warn} {count} {glyph.dot} {failed} failed<Text color={color.faint}>{took}</Text>
        </Text>
      ) : (
        <Text color={color.faint}>
          <Text color={color.add}>{glyph.ok}</Text> {count}{took}
        </Text>
      )}
      <Box flexDirection="column" paddingLeft={2}>
        {hidden > 0 ? <Text color={color.faint}>{glyph.dot}{glyph.dot}{glyph.dot} {hidden} earlier</Text> : null}
        {shown.map((t) => (
          <StepLine key={t.id} tool={t} />
        ))}
      </Box>
    </Box>
  );
}

function StepLine({ tool }: { tool: ToolRow }): React.ReactElement {
  const mark =
    tool.status === "running" ? <Text color={color.accent}>{glyph.running}</Text>
    : tool.status === "error" ? <Text color={color.remove}>{glyph.fail}</Text>
    : <Text color={color.add}>{glyph.ok}</Text>;
  const verb = tool.category === "other" ? tool.name : CATEGORY_VERB[tool.category];
  const ms = tool.startedAt && tool.finishedAt ? tool.finishedAt - tool.startedAt : 0;
  const took = ms >= 100 ? formatDuration(ms) : "";
  const result = tool.resultText ?? "";
  const detail =
    tool.status === "error" ? tailLines(result, 2, false)
    : tool.category === "bash" && tool.status === "ok" ? tailLines(result, 3, true)
    : [];

  return (
    <Box flexDirection="column">
      <Box>
        {mark}
        <Text> </Text>
        <Text color={tool.status === "running" ? undefined : color.faint}>{verb}</Text>
        {tool.target !== "" ? <Text> {tool.target}</Text> : null}
        {tool.added ? <Text color={color.add}> +{tool.added}</Text> : null}
        {tool.removed ? <Text color={color.remove}> −{tool.removed}</Text> : null}
        {took ? <Text color={color.faint}> {glyph.dot} {took}</Text> : null}
      </Box>
      {detail.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {detail.map((line, i) => (
            <Text key={i} color={tool.status === "error" ? color.remove : color.faint}>
              {glyph.bar} {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function tailLines(text: string, n: number, fromEnd: boolean): string[] {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const picked = fromEnd ? lines.slice(-n) : lines.slice(0, n);
  return picked.map((l) => oneLine(l, 140));
}

/* ---------------- plan ---------------- */

export function ProgressBar({ done, total, width = 16 }: { done: number; total: number; width?: number }): React.ReactElement {
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  return (
    <Text>
      <Text color={color.accent}>{"━".repeat(filled)}</Text>
      <Text color={color.edge}>{"━".repeat(width - filled)}</Text>
    </Text>
  );
}

function PlanBlock({ steps, nested }: { steps: PlanStep[]; nested?: boolean }): React.ReactElement {
  const { done, total } = planProgress(steps);
  return (
    <Box flexDirection="column" marginTop={nested ? 0 : 1} borderStyle="round" borderColor={color.edge} paddingX={1}>
      <Box>
        <Text bold>Plan </Text>
        <Text color={color.faint}>
          {done}/{total}{" "}
        </Text>
        <ProgressBar done={done} total={total} />
      </Box>
      {steps.map((s) => (
        <PlanStepLine key={s.id} step={s} />
      ))}
    </Box>
  );
}

function PlanStepLine({ step }: { step: PlanStep }): React.ReactElement {
  switch (step.status) {
    case "completed":
      return (
        <Text color={color.faint}>
          <Text color={color.add}>{glyph.ok}</Text> {step.title}
        </Text>
      );
    case "in_progress":
      return (
        <Text color={color.accent} bold>
          {glyph.active} {step.title}
        </Text>
      );
    case "blocked":
      return (
        <Text color={color.remove}>
          {glyph.fail} {step.title}
        </Text>
      );
    default:
      return (
        <Text>
          <Text color={color.faint}>{glyph.pending}</Text> {step.title}
        </Text>
      );
  }
}

function PlanMarker({ steps }: { steps: PlanStep[] }): React.ReactElement {
  const { done, total, current } = planProgress(steps);
  return (
    <Box marginTop={1}>
      <Text color={color.faint}>
        {glyph.dot} plan updated {done}/{total}
        {current ? ` ${glyph.dot} ${current.title}` : ""}
      </Text>
    </Box>
  );
}

/* ---------------- other rows ---------------- */

function RowView({ row }: { row: Extract<TurnPart, { kind: "row" }>["row"] }): React.ReactElement | null {
  switch (row.kind) {
    case "retry": {
      const wait = row.delayMs > 0 ? ` in ${formatDuration(row.delayMs)}` : "";
      const showReason =
        row.reason.trim() !== "" &&
        !/\b429\b|rate.?limit|too many requests|overloaded/i.test(row.reason);
      return (
        <Box marginTop={1}>
          <Text color={color.warn}>
            {glyph.retry} Retrying ({row.attempt}/{row.maxAttempts}){wait}
          </Text>
          {showReason ? (
            <Text color={color.faint}> {glyph.dot} {oneLine(row.reason, 120)}</Text>
          ) : null}
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
          <Text color={color.faint}>Type /retry to send the last prompt again.</Text>
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
    case "team":
      return <TeamBlock row={row} />;
  }
}

/** One line of team traffic: who sent it, to whom, and what.
 * Assignments and conflicts are worth reading in full; a worker's
 * conclusion is long and already summarised by the team report, so it is
 * clipped to a couple of lines here. */
function TeamBlock({ row }: { row: Extract<Row, { kind: "team" }> }): React.ReactElement {
  const palette: Record<string, string> = {
    assignment: color.info,
    conclusion: color.add,
    conflict: color.warn,
    summary: color.accent,
    status: color.faint,
  };
  const tint = palette[row.msgKind ?? "status"] ?? color.faint;
  const label = row.msgKind ?? "msg";
  const full = row.msgKind === "assignment" || row.msgKind === "conflict";
  const body = full ? row.text : clipLines(row.text, 2, 160);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={tint}>
        ⇄ {label} {glyph.dot} {row.from} {glyph.arrow} {row.to}
      </Text>
      <Box marginLeft={2}>
        <Text color={color.faint}>{body}</Text>
      </Box>
    </Box>
  );
}

function clipLines(text: string, maxLines: number, maxChars: number): string {
  const lines = text.split("\n");
  const kept = lines.slice(0, maxLines).join("\n");
  const clipped = kept.length > maxChars ? `${kept.slice(0, maxChars)}…` : kept;
  return lines.length > maxLines ? `${clipped}\n  … (${lines.length - maxLines} more lines)` : clipped;
}
