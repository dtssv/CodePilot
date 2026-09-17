import { useState } from "react";

import type { PlanStep, UsageInfo } from "@codepilot/core";
import type { MessageRow, Row, TeamRow, ToolRow } from "../state/rows.js";
import { DiffBlock } from "./DiffBlock.js";

export function RowView({ row }: { row: Row }): React.ReactElement | null {
  switch (row.kind) {
    case "message":
      return <MessageBlock msg={row.msg} />;
    case "tool":
      return <ToolBlock tool={row.tool} />;
    case "plan":
      return <PlanBlock steps={row.steps} />;
    case "usage":
      return <UsageBlock usage={row.usage} />;
    case "compaction":
      return (
        <Notice tone="accent">
          ⟳ context compacted — {truncate(row.summary, 200)}
        </Notice>
      );
    case "mode":
      return <Notice tone="dim">mode → {row.mode}</Notice>;
    case "error":
      return (
        <Notice tone={row.recoverable ? "warn" : "error"}>
          {row.recoverable ? "⚠" : "⛔"} {row.message}
        </Notice>
      );
    case "team":
      return <TeamBlock team={row.team} />;
  }
}

function MessageBlock({ msg }: { msg: MessageRow }): React.ReactElement {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85ch] rounded-lg px-3.5 py-2.5 text-sm leading-6 whitespace-pre-wrap ${
          isUser
            ? "bg-[var(--color-surface-raised)] text-[var(--color-ink)]"
            : "bg-transparent text-[var(--color-ink)]"
        }`}
      >
        {msg.text}
        {msg.streaming && <span className="ml-0.5 animate-pulse">▌</span>}
      </div>
    </div>
  );
}

const STATUS_DOT: Record<ToolRow["status"], string> = {
  running: "bg-[var(--color-accent)] animate-pulse",
  ok: "bg-[var(--color-add)]",
  error: "bg-[var(--color-remove)]",
};

function ToolBlock({ tool }: { tool: ToolRow }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const hasDiff = tool.change !== null && tool.change !== undefined;
  return (
    <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface-sunken)] px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-xs"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[tool.status]}`} />
        <span className="font-mono text-[var(--color-ink)]">{tool.name}</span>
        <span className="truncate text-[var(--color-ink-dim)]">
          {summarizeInput(tool.input)}
        </span>
        <span className="ml-auto text-[var(--color-ink-dim)]">{open ? "−" : "+"}</span>
      </button>

      {hasDiff && <DiffBlock change={tool.change!} />}

      {open && (
        <div className="mt-2 space-y-2">
          <Labelled label="input">
            <pre className="overflow-x-auto text-[11px] leading-5 text-[var(--color-ink-dim)]">
              {safeJson(tool.input)}
            </pre>
          </Labelled>
          {tool.result !== undefined && (
            <Labelled label={tool.status === "error" ? "error" : "result"}>
              <pre className="max-h-80 overflow-auto text-[11px] leading-5 whitespace-pre-wrap text-[var(--color-ink-dim)]">
                {tool.result}
              </pre>
            </Labelled>
          )}
          {tool.artifactRef && (
            <div className="text-[11px] text-[var(--color-ink-dim)]">
              full output spilled to artifact{" "}
              <code className="text-[var(--color-ink)]">{tool.artifactRef}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Labelled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)]">
        {label}
      </div>
      {children}
    </div>
  );
}

const STEP_MARK: Record<PlanStep["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  blocked: "⊘",
};

const STEP_STYLE: Record<PlanStep["status"], string> = {
  pending: "text-[var(--color-ink-dim)]",
  in_progress: "text-[var(--color-accent)]",
  completed: "text-[var(--color-add)] line-through opacity-70",
  blocked: "text-[var(--color-remove)]",
};

export function PlanBlock({ steps }: { steps: PlanStep[] }): React.ReactElement {
  return (
    <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface-sunken)] px-3 py-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)]">
        plan
      </div>
      <ul className="space-y-0.5 text-xs">
        {steps.map((s) => (
          <li key={s.id} className={STEP_STYLE[s.status]}>
            <span className="mr-1.5">{STEP_MARK[s.status]}</span>
            {s.title}
          </li>
        ))}
      </ul>
    </div>
  );
}

function UsageBlock({ usage }: { usage: UsageInfo }): React.ReactElement {
  return (
    <div className="text-right text-[11px] text-[var(--color-ink-dim)]">
      {usage.input} in / {usage.output} out
      {usage.cacheRead ? ` · ${usage.cacheRead} cached` : ""}
      {usage.costUSD !== undefined ? ` · $${usage.costUSD.toFixed(4)}` : ""}
    </div>
  );
}

const TEAM_TONE: Record<TeamRow["kind"], string> = {
  assignment: "text-[var(--color-accent)]",
  conclusion: "text-[var(--color-add)]",
  conflict: "text-[var(--color-remove)]",
  summary: "text-[var(--color-ink)]",
  status: "text-[var(--color-ink-dim)]",
  msg: "text-[var(--color-ink-dim)]",
};

function TeamBlock({ team }: { team: TeamRow }): React.ReactElement {
  // Assignments and conflicts are worth reading in full; a member's
  // conclusion is long and already folded into the team report.
  const full = team.kind === "assignment" || team.kind === "conflict";
  return (
    <div className="border-l-2 border-[var(--color-edge)] pl-3 text-xs">
      <div className={TEAM_TONE[team.kind]}>
        ⇄ [{team.kind}] {team.from} → {team.to}
      </div>
      <div className="whitespace-pre-wrap text-[var(--color-ink-dim)]">
        {full ? team.text : truncate(team.text, 240)}
      </div>
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "accent" | "dim" | "warn" | "error";
  children: React.ReactNode;
}): React.ReactElement {
  const styles = {
    accent: "text-[var(--color-accent)]",
    dim: "text-[var(--color-ink-dim)]",
    warn: "text-amber-400",
    error: "text-[var(--color-remove)]",
  }[tone];
  return <div className={`text-xs ${styles}`}>{children}</div>;
}

function summarizeInput(input: unknown): string {
  if (input === undefined) return "";
  if (typeof input !== "object" || input === null) return String(input);
  const o = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "objective", "url"]) {
    const v = o[key];
    if (typeof v === "string") return truncate(v, 120);
  }
  return truncate(safeJson(input), 120);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= n ? oneLine : `${oneLine.slice(0, n)}…`;
}
