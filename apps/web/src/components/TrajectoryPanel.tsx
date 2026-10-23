import { useEffect, useMemo, useRef, useState } from "react";

import type { PlanStep, UsageInfo } from "@codepilot/core";
import type { Row, ToolRow } from "../state/rows.js";
import { CATEGORY_VERB, toolCategory, toolTarget } from "../state/selectors.js";
import { t } from "../i18n.js";
import { ListIcon, XIcon } from "./Icons.js";

/**
 * Session execution trajectory: one chronological step per transcript row
 * (user → assistant → tools → …), not a collapsed “all replies in one blob”.
 */
export function TrajectoryPanel({
  rows,
  sessionId,
  usage,
  onClose,
}: {
  rows: Row[];
  sessionId: string;
  usage: UsageInfo;
  onClose(): void;
}): React.ReactElement {
  const steps = useMemo(() => buildSteps(rows), [rows]);
  const scroller = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);

  // Follow the live end of the trajectory when new steps arrive.
  useEffect(() => {
    if (steps.length > prevLen.current) {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    prevLen.current = steps.length;
  }, [steps.length]);

  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-[var(--color-edge-subtle)] bg-[var(--color-surface)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-edge-subtle)] px-3">
        <ListIcon className="h-4 w-4 text-[var(--color-accent)]" />
        <span className="text-[13px] font-semibold text-[var(--color-ink)]">{t("Trajectory")}</span>
        <span className="ml-1 truncate font-mono text-[10.5px] text-[var(--color-ink-faint)]">
          {sessionId.slice(0, 8)}
        </span>
        <span className="ml-1 font-mono text-[10.5px] text-[var(--color-ink-faint)]">
          {steps.length}
        </span>
        <button type="button" className="cp-icon-btn ml-auto" title={t("Close")} onClick={onClose}>
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="shrink-0 border-b border-[var(--color-edge-subtle)] px-3 py-2">
        <div className="cp-eyebrow mb-1">{t("Session totals")}</div>
        <TokenGrid usage={usage} />
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {steps.length === 0 ? (
          <div className="text-[12px] leading-5 text-[var(--color-ink-faint)]">
            {t("No steps yet — send a message to start this session’s trajectory.")}
          </div>
        ) : (
          <ol className="space-y-2">
            {steps.map((step, i) => (
              <li key={step.id}>
                <StepCard step={step} index={i + 1} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

type Step =
  | { kind: "user"; id: string; at: number; text: string }
  | {
      kind: "assistant";
      id: string;
      at: number;
      text: string;
      model?: string;
      streaming?: boolean;
      firstTokenAt?: number;
      turnStartedAt?: number;
    }
  | { kind: "tool"; id: string; at: number; tool: ToolRow }
  | { kind: "usage"; id: string; at: number; usage: UsageInfo }
  | { kind: "error"; id: string; at: number; message: string; recoverable: boolean }
  | { kind: "plan"; id: string; at: number; steps: PlanStep[] }
  | { kind: "compaction"; id: string; at: number; summary: string }
  | { kind: "mode"; id: string; at: number; mode: string }
  | { kind: "retry"; id: string; at: number; attempt: number; maxAttempts: number; reason: string }
  | { kind: "team"; id: string; at: number; from: string; to: string; text: string };

function buildSteps(rows: Row[]): Step[] {
  const steps: Step[] = [];
  /** Last user message time — for TTFT on the next assistant chunk. */
  let lastUserAt: number | undefined;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.kind === "message" && row.msg.role === "user") {
      lastUserAt = row.at;
      steps.push({
        kind: "user",
        id: `user-${row.msg.id}`,
        at: row.at,
        text: row.msg.text,
      });
    } else if (row.kind === "message" && row.msg.role === "assistant") {
      steps.push({
        kind: "assistant",
        id: `asst-${row.msg.id}-${i}`,
        at: row.at,
        text: row.msg.text,
        model: row.msg.model,
        streaming: row.msg.streaming,
        firstTokenAt: row.msg.firstTokenAt,
        turnStartedAt: lastUserAt,
      });
    } else if (row.kind === "tool") {
      steps.push({
        kind: "tool",
        id: `tool-${row.tool.id}`,
        at: row.at,
        tool: row.tool,
      });
    } else if (row.kind === "usage") {
      steps.push({
        kind: "usage",
        id: `usage-${row.at}-${i}`,
        at: row.at,
        usage: row.usage,
      });
    } else if (row.kind === "error") {
      steps.push({
        kind: "error",
        id: `err-${row.at}-${i}`,
        at: row.at,
        message: row.message,
        recoverable: row.recoverable,
      });
    } else if (row.kind === "plan") {
      steps.push({
        kind: "plan",
        id: `plan-${row.at}-${i}`,
        at: row.at,
        steps: row.steps,
      });
    } else if (row.kind === "compaction") {
      steps.push({
        kind: "compaction",
        id: `compact-${row.at}-${i}`,
        at: row.at,
        summary: row.summary,
      });
    } else if (row.kind === "mode") {
      steps.push({
        kind: "mode",
        id: `mode-${row.at}-${i}`,
        at: row.at,
        mode: row.mode,
      });
    } else if (row.kind === "retry") {
      steps.push({
        kind: "retry",
        id: `retry-${row.at}-${i}`,
        at: row.at,
        attempt: row.retry.attempt,
        maxAttempts: row.retry.maxAttempts,
        reason: row.retry.reason,
      });
    } else if (row.kind === "team") {
      steps.push({
        kind: "team",
        id: `team-${row.at}-${i}`,
        at: row.at,
        from: row.team.from,
        to: row.team.to,
        text: row.team.text,
      });
    }
  }
  return steps;
}

function StepCard({ step, index }: { step: Step; index: number }): React.ReactElement {
  switch (step.kind) {
    case "user":
      return (
        <Block
          index={index}
          label={t("Request")}
          tone="info"
          right={formatClock(step.at)}
        >
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-[var(--color-ink)]">
            {step.text || "(empty)"}
          </pre>
        </Block>
      );
    case "assistant": {
      const ttft =
        step.firstTokenAt !== undefined && step.turnStartedAt !== undefined
          ? Math.max(0, step.firstTokenAt - step.turnStartedAt)
          : step.turnStartedAt !== undefined && !step.streaming
            ? Math.max(0, step.at - step.turnStartedAt)
            : undefined;
      return (
        <Block
          index={index}
          label={t("Response")}
          tone={step.streaming ? "running" : "ok"}
          right={[formatClock(step.at), ttft !== undefined ? `TTFT ${formatMs(ttft)}` : ""]
            .filter(Boolean)
            .join(" · ")}
        >
          {step.model && (
            <div className="mb-1 font-mono text-[10.5px] text-[var(--color-ink-faint)]">{step.model}</div>
          )}
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-[var(--color-ink)]">
            {step.text || (step.streaming ? "…" : "(empty)")}
          </pre>
        </Block>
      );
    }
    case "tool":
      return <ToolStep index={index} tool={step.tool} at={step.at} />;
    case "usage":
      return (
        <Block index={index} label={t("Metrics")} tone="info" right={formatClock(step.at)}>
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-[var(--color-ink-dim)]">
            <span>{t("Input tokens")}</span>
            <span className="text-right text-[var(--color-ink)]">{step.usage.input}</span>
            <span>{t("Output tokens")}</span>
            <span className="text-right text-[var(--color-ink)]">{step.usage.output}</span>
            <span>{t("Cache read")}</span>
            <span className="text-right text-[var(--color-ink)]">{step.usage.cacheRead ?? 0}</span>
            <span>{t("Cache write")}</span>
            <span className="text-right text-[var(--color-ink)]">{step.usage.cacheWrite ?? 0}</span>
            {step.usage.costUSD !== undefined && (
              <>
                <span>{t("Cost")}</span>
                <span className="text-right text-[var(--color-ink)]">${step.usage.costUSD.toFixed(4)}</span>
              </>
            )}
          </div>
        </Block>
      );
    case "error":
      return (
        <Block
          index={index}
          label={step.recoverable ? t("Error") : t("Error")}
          tone="error"
          right={formatClock(step.at)}
        >
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-[var(--color-ink)]">
            {step.message}
          </pre>
        </Block>
      );
    case "plan":
      return (
        <Block index={index} label={t("Updated plan")} tone="info" right={formatClock(step.at)}>
          <ul className="space-y-0.5 font-mono text-[11px] text-[var(--color-ink)]">
            {step.steps.map((s) => (
              <li key={s.id}>
                <span className="text-[var(--color-ink-faint)]">[{s.status}]</span> {s.title}
              </li>
            ))}
          </ul>
        </Block>
      );
    case "compaction":
      return (
        <Block index={index} label={t("Compaction")} tone="info" right={formatClock(step.at)}>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[var(--color-ink-dim)]">
            {step.summary}
          </pre>
        </Block>
      );
    case "mode":
      return (
        <Block index={index} label={t("Mode")} tone="info" right={formatClock(step.at)}>
          <span className="font-mono text-[11px] text-[var(--color-ink)]">{step.mode}</span>
        </Block>
      );
    case "retry": {
      const showReason =
        step.reason.trim() !== "" &&
        !/\b429\b|rate.?limit|too many requests|overloaded/i.test(step.reason);
      return (
        <Block
          index={index}
          label={`${t("Retry")} ${step.attempt}/${step.maxAttempts}`}
          tone="running"
          right={formatClock(step.at)}
        >
          {showReason ? (
            <pre className="whitespace-pre-wrap font-mono text-[11px] text-[var(--color-ink-dim)]">
              {step.reason}
            </pre>
          ) : (
            <span className="text-[11px] text-[var(--color-ink-dim)]">{t("Connection hiccup, retrying")}</span>
          )}
        </Block>
      );
    }
    case "team":
      return (
        <Block
          index={index}
          label={`${step.from} → ${step.to}`}
          tone="info"
          right={formatClock(step.at)}
        >
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[var(--color-ink)]">
            {step.text}
          </pre>
        </Block>
      );
  }
}

function ToolStep({ index, tool, at }: { index: number; tool: ToolRow; at: number }): React.ReactElement {
  const [showResult, setShowResult] = useState(false);
  const cat = toolCategory(tool.name);
  const target = toolTarget(tool.input) || tool.name;
  const cmd =
    tool.name === "bash" || tool.name === "shell" || tool.name === "run_command"
      ? extractCommand(tool.input)
      : undefined;
  const dur =
    tool.startedAt && tool.finishedAt ? tool.finishedAt - tool.startedAt : undefined;
  const tone =
    tool.status === "error" ? "error" : tool.status === "running" ? "running" : "ok";

  return (
    <Block
      index={index}
      label={`${t(CATEGORY_VERB[cat])} · ${tool.name}`}
      tone={tone}
      right={[
        formatClock(tool.startedAt ?? at),
        dur !== undefined ? formatMs(dur) : tool.status === "running" ? "…" : "",
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <div className="font-mono text-[11px] text-[var(--color-ink)]">{cmd || target}</div>
      {tool.input !== undefined && !cmd && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10.5px] text-[var(--color-ink-faint)]">
            {t("Input")}
          </summary>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] text-[var(--color-ink-dim)]">
            {safeJson(tool.input)}
          </pre>
        </details>
      )}
      {tool.result !== undefined && (
        <div className="mt-1">
          <button
            type="button"
            className="text-[10.5px] text-[var(--color-accent)] hover:underline"
            onClick={() => setShowResult((v) => !v)}
          >
            {showResult ? t("Hide result") : t("Show result")}
            {` (${tool.result.length} chars)`}
          </button>
          {showResult && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--color-bg)] p-1.5 font-mono text-[10.5px] text-[var(--color-ink-dim)]">
              {tool.result}
            </pre>
          )}
        </div>
      )}
    </Block>
  );
}

function Block({
  index,
  label,
  tone,
  right,
  children,
}: {
  index: number;
  label: string;
  tone: "ok" | "error" | "running" | "info";
  right?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const dot =
    tone === "error"
      ? "bg-[var(--color-remove)]"
      : tone === "running"
        ? "bg-[var(--color-accent)]"
        : tone === "ok"
          ? "bg-[var(--color-add)]"
          : "bg-[var(--color-ink-faint)]";
  return (
    <div className="rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-bg)] px-2 py-1.5">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="w-5 shrink-0 text-right font-mono text-[10px] text-[var(--color-ink-faint)]">
          {index}
        </span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="text-[11px] font-medium text-[var(--color-ink-dim)]">{label}</span>
        {right && (
          <span className="ml-auto font-mono text-[10.5px] text-[var(--color-ink-faint)]">{right}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function TokenGrid({ usage }: { usage: UsageInfo }): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-[var(--color-ink-dim)]">
      <span>{t("Input tokens")}</span>
      <span className="text-right text-[var(--color-ink)]">{usage.input}</span>
      <span>{t("Output tokens")}</span>
      <span className="text-right text-[var(--color-ink)]">{usage.output}</span>
      <span>{t("Cache read")}</span>
      <span className="text-right text-[var(--color-ink)]">{usage.cacheRead ?? 0}</span>
      <span>{t("Cache write")}</span>
      <span className="text-right text-[var(--color-ink)]">{usage.cacheWrite ?? 0}</span>
      {usage.costUSD !== undefined && (
        <>
          <span>{t("Cost")}</span>
          <span className="text-right text-[var(--color-ink)]">${usage.costUSD.toFixed(4)}</span>
        </>
      )}
    </div>
  );
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(0);
  return `${m}m ${s}s`;
}

function extractCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const c = (input as Record<string, unknown>).command;
  return typeof c === "string" ? c : undefined;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
