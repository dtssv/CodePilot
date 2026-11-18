import { useEffect, useState } from "react";

import type { ImageAttachment, PlanStep, SavedUpload } from "@codepilot/core";
import type { Activity } from "../../state/reducer.js";
import type { MessageRow, TeamRow } from "../../state/rows.js";
import { planProgress } from "../../state/selectors.js";
import type { TurnPart } from "../../state/selectors.js";
import { t } from "../../i18n.js";
import { imageDataUrl } from "../../state/images.js";
import {
  AlertIcon,
  BrainIcon,
  CheckIcon,
  ChevronIcon,
  CopyIcon,
  FileIcon,
  LayersIcon,
  RefreshIcon,
  SparkIcon,
  UsersIcon,
} from "../Icons.js";
import type { Density } from "./types.js";

/** Thumbnails; click opens the full image in a new tab. */
export function ImageStrip({ images }: { images: ImageAttachment[] }): React.ReactElement {
  return (
    <div className="flex max-w-[88%] flex-wrap justify-end gap-2">
      {images.map((img, i) => (
        <button
          key={i}
          type="button"
          onClick={() => {
            const w = window.open();
            if (!w) return;
            const full = w.document.createElement("img");
            full.src = imageDataUrl(img);
            full.style.maxWidth = "100%";
            w.document.body.appendChild(full);
          }}
          className="overflow-hidden rounded-lg border border-[var(--color-edge)]"
        >
          <img src={imageDataUrl(img)} alt="" className="max-h-48 max-w-72 object-contain" />
        </button>
      ))}
    </div>
  );
}

export function FileStrip({ files }: { files: SavedUpload[] }): React.ReactElement {
  return (
    <div className="flex max-w-[88%] flex-wrap justify-end gap-2">
      {files.map((f) => (
        <div
          key={f.path}
          title={f.path}
          className="flex max-w-[14rem] items-center gap-1.5 rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5"
        >
          <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-ink-dim)]" />
          <span className="truncate text-[11.5px] text-[var(--color-ink)]">{f.name}</span>
        </div>
      ))}
    </div>
  );
}

/** Drop the machine-facing upload note from older sessions that baked it into
 * the user message text. New sessions keep the note out of the event. */
function scrubUploadNote(text: string): string {
  return text
    .replace(/\n*\nAttached files \(saved in the workspace[\s\S]*$/i, "")
    .trim();
}

/** Collapsible "extended thinking" block shown above an assistant answer.
 * Auto-expands while the model is still thinking (no answer text yet) so the
 * user sees live progress; collapses once the answer starts. */
export function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }): React.ReactElement {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? streaming;
  return (
    <div className="mb-1.5 rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)]">
      <button
        type="button"
        onClick={() => setUserToggled(!open)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
      >
        <BrainIcon className="h-3 w-3" />
        <span className="font-medium">{streaming && !userToggled ? t("Thinking…") : t("Thought process")}</span>
        <ChevronIcon open={open} className="ml-auto h-3 w-3" />
      </button>
      {open && (
        <div className="border-t border-[var(--color-edge-subtle)] px-2.5 py-2 text-[12px] leading-5 whitespace-pre-wrap text-[var(--color-ink-dim)]">
          {text}
        </div>
      )}
    </div>
  );
}

export function MessageView({ msg, density }: { msg: MessageRow; density: Density }): React.ReactElement | null {
 // Assistant text is rendered inside AssistantTurnView (one avatar per Q&A).
  if (msg.role !== "user") return null;
  return (
    <div className="flex animate-fade-in flex-col items-end gap-1.5">
      {msg.images && msg.images.length > 0 && <ImageStrip images={msg.images} />}
      {msg.files && msg.files.length > 0 && <FileStrip files={msg.files} />}
      {(() => {
        const text = scrubUploadNote(msg.text);
        return text ? (
          <div
            className={`max-w-[88%] rounded-2xl rounded-br-md bg-[var(--color-accent-dim)] px-3.5 py-2 leading-6 whitespace-pre-wrap text-[var(--color-ink)] ${
              density === "compact" ? "text-[12.5px]" : "text-[13.5px]"
            }`}
          >
            {text}
          </div>
        ) : null;
      })()}
    </div>
  );
}

export function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={t("Copy")}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex items-center gap-1 rounded px-1 hover:text-[var(--color-ink)]"
    >
      {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
      {copied ? t("Copied") : t("Copy")}
    </button>
  );
}

/** "Waiting for model · 12s" / "Running bash, grep · 34s" — tells the user
 * whether a slow turn is stuck on the provider or on a tool. */
export function ActivityRow({
  activity,
  plan,
}: {
  activity?: Activity;
  plan?: PlanStep[];
}): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Tie the live indicator to the current plan step so the user sees progress
  // mid-task even between the model's plan_update calls (which it tends to
  // batch to the end). Shows "Step N/M: <title>" above the tool/model line.
  const progress = plan && plan.length > 0 ? planProgress(plan) : undefined;
  const stepLabel =
    progress?.current && progress.total > 0
      ? `${t("Step")} ${Math.min(progress.done + 1, progress.total)}/${progress.total}: ${progress.current.title}`
      : undefined;
  if (!activity) return <ThinkingRow label={stepLabel ?? t("Thinking")} sub={stepLabel ? t("Thinking") : undefined} />;
  const secs = Math.max(0, Math.round((now - activity.since) / 1000));
  const detail =
    activity.phase === "model"
      ? t("Waiting for model response")
      : `${t("Running tools")}: ${(activity.tools ?? []).join(", ")}`;
  // When a plan step is active, lead with it and demote the tool/model line to
  // a dim sub-label; otherwise keep the original single line.
  if (stepLabel) return <ThinkingRow label={stepLabel} sub={`${detail} · ${secs}s`} />;
  return <ThinkingRow label={`${detail} · ${secs}s`} />;
}

export function ThinkingRow({ label, sub }: { label: string; sub?: string }): React.ReactElement {
  return (
    <div className="flex animate-fade-in items-start gap-2.5 pl-0.5 text-[12.5px]">
      <span className="flex h-5 w-5 items-center justify-center">
        <SparkIcon className="h-4 w-4 animate-breathe text-[var(--color-accent)]" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="cp-shimmer font-medium">{label}…</span>
        {sub && (
          <span className="mt-0.5 truncate text-[11px] text-[var(--color-ink-faint)]">{sub}</span>
        )}
      </span>
    </div>
  );
}

export function MiscRow({
  row,
  canRetry,
  onRetry,
}: {
  row: Extract<TurnPart, { kind: "row" }>["row"];
  canRetry: boolean;
  onRetry(): void;
}): React.ReactElement {
  switch (row.kind) {
    case "retry": {
      // Don't surface raw "HTTP 429" / rate-limit codes — the friendly label
      // is enough while backoff runs; the row is cleared once the stream resumes.
      const showReason =
        row.retry.reason.trim() !== "" &&
        !/\b429\b|rate.?limit|too many requests|overloaded|\b529\b|tokens?\s*limit|访问限制|tpm/i.test(
          row.retry.reason,
        );
      return (
        <div className="flex animate-fade-in items-center gap-2 rounded-lg border border-[var(--color-warn-dim)] bg-[var(--color-warn-dim)] px-3 py-2 text-[12px] text-[var(--color-warn)]">
          <RefreshIcon className="h-3.5 w-3.5 shrink-0 animate-spin [animation-duration:2s]" />
          <span className="font-medium">
            {t("Connection hiccup, retrying")} ({row.retry.attempt}/{row.retry.maxAttempts})
          </span>
          {showReason && (
            <span className="min-w-0 truncate text-[11px] opacity-80" title={row.retry.reason}>
              {row.retry.reason}
            </span>
          )}
        </div>
      );
    }
    case "error":
      return (
        <div
          className={`animate-fade-in rounded-xl border px-3 py-2.5 text-[12.5px] ${
            row.recoverable
              ? "border-[var(--color-warn-dim)] bg-[var(--color-warn-dim)] text-[var(--color-warn)]"
              : "border-[var(--color-remove-dim)] bg-[var(--color-remove-dim)] text-[var(--color-remove)]"
          }`}
        >
          <div className="flex items-start gap-2">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t("Something went wrong")}</div>
              <div className="mt-0.5 break-words whitespace-pre-wrap opacity-90">{row.message}</div>
            </div>
            {canRetry && (
              <button type="button" onClick={onRetry} className="cp-btn-ghost shrink-0 bg-[var(--color-surface)]">
                <RefreshIcon className="h-3 w-3" />
                {t("Retry")}
              </button>
            )}
          </div>
        </div>
      );
    case "compaction":
      return <CompactionNote summary={row.summary} foldKind={row.foldKind} />;
    case "mode":
      return <Divider icon={<SparkIcon className="h-3 w-3" />}>{t("Mode switched to")} {row.mode}</Divider>;
    case "team":
      return <TeamNote team={row.team} />;
  }
}

export function Divider({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center gap-3 text-[11px] text-[var(--color-ink-faint)]">
      <div className="h-px flex-1 bg-[var(--color-edge-subtle)]" />
      <span className="flex min-w-0 items-center gap-1.5 truncate">
        {icon}
        {children}
      </span>
      <div className="h-px flex-1 bg-[var(--color-edge-subtle)]" />
    </div>
  );
}

export function CompactionNote({ summary, foldKind }: { summary: string; foldKind?: "summary" | "micro-fold" }): React.ReactElement {
  const [open, setOpen] = useState(false);
 // micro-fold is a routine, lossless token prune (old large tool results
 // swapped for retrievable stubs) — present it quietly, not as a scary
 // "context compacted". A real summary compaction is lossy and keeps the
 // original wording.
  const microFold = foldKind === "micro-fold";
  const label = microFold ? t("Archived large results") : t("Context compacted");
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full">
        <Divider icon={<LayersIcon className="h-3 w-3" />}>
          {label} <ChevronIcon open={open} className="h-3 w-3" />
        </Divider>
      </button>
      {open && (
        <div className="mt-2 rounded-lg bg-[var(--color-surface-sunken)] p-3 text-[12px] text-[var(--color-ink-dim)]">
          {/* Preserve numbered section headers (`1. USER REQUESTS`) verbatim —
              Markdown list parsing would strip/renumber them. */}
          <pre className="m-0 max-h-96 overflow-auto whitespace-pre-wrap font-sans text-[12px] leading-[1.55] text-[var(--color-ink-dim)]">
            {summary}
          </pre>
        </div>
      )}
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

export function TeamNote({ team }: { team: TeamRow }): React.ReactElement {
  const [open, setOpen] = useState(team.kind === "assignment" || team.kind === "conflict");
  return (
    <div className="rounded-lg border-l-2 border-[var(--color-accent)] bg-[var(--color-surface-raised)] px-3 py-2 text-[12px]">
      <button type="button" onClick={() => setOpen((v) => !v)} className={`flex w-full items-center gap-1.5 font-medium ${TEAM_TONE[team.kind]}`}>
        <UsersIcon className="h-3.5 w-3.5" />
        {team.from} → {team.to}
        <span className="cp-chip ml-1">{team.kind}</span>
        <ChevronIcon open={open} className="ml-auto h-3 w-3 text-[var(--color-ink-faint)]" />
      </button>
      {open && <div className="mt-1.5 whitespace-pre-wrap text-[var(--color-ink-dim)]">{team.text}</div>}
    </div>
  );
}