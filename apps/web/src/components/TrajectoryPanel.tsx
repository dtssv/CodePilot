import { useMemo, useState } from "react";

import type { UsageInfo } from "@codepilot/core";
import type { Row, ToolRow } from "../state/rows.js";
import { CATEGORY_VERB, toolCategory, toolTarget } from "../state/selectors.js";
import { t } from "../i18n.js";
import { ChevronIcon, ListIcon, XIcon } from "./Icons.js";

/** Session-bound execution timeline with request/response/tool/token detail. */
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
  const turns = useMemo(() => buildTurns(rows), [rows]);

  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-[var(--color-edge-subtle)] bg-[var(--color-surface)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-edge-subtle)] px-3">
        <ListIcon className="h-4 w-4 text-[var(--color-accent)]" />
        <span className="text-[13px] font-semibold text-[var(--color-ink)]">{t("Trajectory")}</span>
        <span className="ml-1 truncate font-mono text-[10.5px] text-[var(--color-ink-faint)]">
          {sessionId.slice(0, 8)}
        </span>
        <button type="button" className="cp-icon-btn ml-auto" title={t("Close")} onClick={onClose}>
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="shrink-0 border-b border-[var(--color-edge-subtle)] px-3 py-2">
        <div className="cp-eyebrow mb-1">{t("Session totals")}</div>
        <TokenGrid usage={usage} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {turns.length === 0 ? (
          <div className="text-[12px] leading-5 text-[var(--color-ink-faint)]">
            {t("No steps yet — send a message to start this session’s trajectory.")}
          </div>
        ) : (
          <div className="space-y-3">
            {/* Newest first: the turn in flight is what the user is watching. */}
            {turns
              .map((turn, i) => ({ turn, index: i + 1 }))
              .reverse()
              .map(({ turn, index }) => (
                <TurnCard key={turn.id} turn={turn} index={index} latest={index === turns.length} />
              ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function TurnCard({ turn, index, latest }: { turn: Turn; index: number; latest: boolean }): React.ReactElement {
  const [userOpen, setOpen] = useState<boolean | undefined>(undefined);
  const open = userOpen ?? latest;
  return (
    <section className="rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <ChevronIcon open={open} className="h-3.5 w-3.5 shrink-0 text-[var(--color-ink-faint)]" />
        <span className="text-[12px] font-semibold text-[var(--color-ink)]">
          {t("Turn")} {index}
        </span>
        <span className="font-mono text-[10.5px] text-[var(--color-ink-faint)]">{formatClock(turn.startedAt)}</span>
        <span className="ml-auto font-mono text-[10.5px] text-[var(--color-ink-faint)]">
          {turn.durationMs !== undefined ? formatMs(turn.durationMs) : ""}
          {turn.ttftMs !== undefined ? ` · TTFT ${formatMs(turn.ttftMs)}` : ""}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-[var(--color-edge-subtle)] px-2.5 py-2">
          {/* Newest first within the turn too: response, tools (latest on top), then the request. */}
          {turn.response !== undefined && (
            <Block label={t("Response")} tone="ok" right={turn.endedAt ? formatClock(turn.endedAt) : undefined}>
              {turn.model && (
                <div className="mb-1 font-mono text-[10.5px] text-[var(--color-ink-faint)]">{turn.model}</div>
              )}
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-[var(--color-ink)]">
                {turn.response || (turn.streaming ? "…" : "(empty)")}
              </pre>
            </Block>
          )}

          {[...turn.tools].reverse().map((tool) => (
            <ToolBlock key={tool.id} tool={tool} />
          ))}

          {turn.request && (
            <Block label={t("Request")} tone="info" right={formatClock(turn.startedAt)}>
              <pre className="max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-[var(--color-ink)]">
                {turn.request}
              </pre>
            </Block>
          )}

          {(turn.usage || turn.ttftMs !== undefined || turn.durationMs !== undefined) && (
            <div className="rounded-lg bg-[var(--color-bg)] px-2 py-1.5">
              <div className="cp-eyebrow mb-1">{t("Metrics")}</div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-[var(--color-ink-dim)]">
                {turn.ttftMs !== undefined && (
                  <>
                    <span>{t("TTFT")}</span>
                    <span className="text-right text-[var(--color-ink)]">{formatMs(turn.ttftMs)}</span>
                  </>
                )}
                {turn.durationMs !== undefined && (
                  <>
                    <span>{t("Duration")}</span>
                    <span className="text-right text-[var(--color-ink)]">{formatMs(turn.durationMs)}</span>
                  </>
                )}
                {turn.usage && (
                  <>
                    <span>{t("Input tokens")}</span>
                    <span className="text-right text-[var(--color-ink)]">{turn.usage.input}</span>
                    <span>{t("Output tokens")}</span>
                    <span className="text-right text-[var(--color-ink)]">{turn.usage.output}</span>
                    <span>{t("Cache read")}</span>
                    <span className="text-right text-[var(--color-ink)]">{turn.usage.cacheRead ?? 0}</span>
                    <span>{t("Cache write")}</span>
                    <span className="text-right text-[var(--color-ink)]">{turn.usage.cacheWrite ?? 0}</span>
                    {turn.usage.costUSD !== undefined && (
                      <>
                        <span>{t("Cost")}</span>
                        <span className="text-right text-[var(--color-ink)]">
                          ${turn.usage.costUSD.toFixed(4)}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ToolBlock({ tool }: { tool: ToolRow }): React.ReactElement {
  const [showResult, setShowResult] = useState(false);
  const cat = toolCategory(tool.name);
  const target = toolTarget(tool.input) || tool.name;
  const cmd =
    tool.name === "bash" || tool.name === "shell" || tool.name === "run_command"
      ? extractCommand(tool.input)
      : undefined;
  const dur =
    tool.startedAt && tool.finishedAt
      ? tool.finishedAt - tool.startedAt
      : undefined;
  const tone =
    tool.status === "error" ? "error" : tool.status === "running" ? "running" : "ok";

  return (
    <Block
      label={`${t(CATEGORY_VERB[cat])} · ${tool.name}`}
      tone={tone}
      right={[
        tool.startedAt ? formatClock(tool.startedAt) : "",
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
  label,
  tone,
  right,
  children,
}: {
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
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
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

type Turn = {
  id: string;
  request?: string;
  response?: string;
  streaming?: boolean;
  model?: string;
  tools: ToolRow[];
  usage?: UsageInfo;
 /** Time from user request to first assistant token. */
  ttftMs?: number;
 /** Wall time of the whole turn. */
  durationMs?: number;
  startedAt: number;
  endedAt?: number;
};

function buildTurns(rows: Row[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | undefined;

  const flush = (): void => {
    if (!cur) return;
    if (cur.endedAt && cur.startedAt) {
      cur.durationMs = Math.max(0, cur.endedAt - cur.startedAt);
    }
    turns.push(cur);
    cur = undefined;
  };

  for (const row of rows) {
    if (row.kind === "message" && row.msg.role === "user") {
      flush();
      cur = {
        id: `turn-${row.msg.id}`,
        request: row.msg.text,
        tools: [],
        startedAt: row.at,
      };
    } else if (row.kind === "message" && row.msg.role === "assistant") {
      if (!cur) {
        cur = { id: `turn-${row.msg.id}`, tools: [], startedAt: row.at };
      }
      cur.response = cur.response
        ? `${cur.response}\n\n${row.msg.text}`
        : row.msg.text;
      cur.streaming = row.msg.streaming;
      cur.model = row.msg.model ?? cur.model;
      if (row.msg.firstTokenAt !== undefined) {
        cur.ttftMs = Math.max(0, row.msg.firstTokenAt - cur.startedAt);
      } else if (!row.msg.streaming) {
 // Fallback when resumed without firstTokenAt: message.at ≈ first paint.
        cur.ttftMs = Math.max(0, row.at - cur.startedAt);
      }
      cur.endedAt = row.at;
    } else if (row.kind === "tool") {
      if (!cur) {
        cur = { id: `turn-tool-${row.tool.id}`, tools: [], startedAt: row.at };
      }
      cur.tools.push(row.tool);
      cur.endedAt = row.tool.finishedAt ?? row.at;
    } else if (row.kind === "usage") {
      if (!cur) continue;
      cur.usage = cur.usage
        ? {
            input: cur.usage.input + row.usage.input,
            output: cur.usage.output + row.usage.output,
            cacheRead: (cur.usage.cacheRead ?? 0) + (row.usage.cacheRead ?? 0),
            cacheWrite: (cur.usage.cacheWrite ?? 0) + (row.usage.cacheWrite ?? 0),
            costUSD:
              cur.usage.costUSD !== undefined || row.usage.costUSD !== undefined
                ? (cur.usage.costUSD ?? 0) + (row.usage.costUSD ?? 0)
                : undefined,
          }
        : { ...row.usage };
      cur.endedAt = row.at;
    } else if (row.kind === "error") {
      if (!cur) {
        cur = { id: `turn-err-${row.at}`, tools: [], startedAt: row.at };
      }
      cur.response = `${cur.response ? cur.response + "\n\n" : ""}[error] ${row.message}`;
      cur.endedAt = row.at;
    }
  }
  flush();
  return turns;
}

/** Wall-clock time; the date is added only when it isn't today. */
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
