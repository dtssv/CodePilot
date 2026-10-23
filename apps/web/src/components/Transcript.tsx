import { createContext, useContext, useEffect, useRef, useState } from "react";

import type { ImageAttachment, PermissionDecision, PlanStep, QuestionAnswers, SavedUpload } from "@codepilot/core";
import type { PendingPermission, PendingQuestion } from "../protocol/client.js";
import type { Activity, SubagentRun, UiStatus } from "../state/reducer.js";
import type { MessageRow, Row, TeamRow, ToolRow } from "../state/rows.js";
import {
  CATEGORY_VERB,
  endsInError,
  formatDuration,
  groupRows,
  planProgress,
  toolCategory,
  toolTarget,
  type Block,
  type ToolCategory,
  type TurnPart,
} from "../state/selectors.js";
import { t } from "../i18n.js";
import { imageDataUrl } from "../state/images.js";
import { stripThinking } from "../state/stripThinking.js";
import { DiffBlock } from "./DiffBlock.js";
import {
  AlertIcon,
  BookIcon,
  BrainIcon,
  CheckIcon,
  ChevronIcon,
  CopyIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  GlobeIcon,
  LayersIcon,
  ListIcon,
  LogoMark,
  PencilIcon,
  QuestionIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  SparkIcon,
  SpinnerIcon,
  TerminalIcon,
  UsersIcon,
  WrenchIcon,
  XIcon,
} from "./Icons.js";
import { looksLikeWorkspacePath } from "../state/paths.js";
import { Markdown } from "./Markdown.js";

export type Density = "comfortable" | "compact";

export interface TranscriptProps {
  rows: Row[];
  status: UiStatus;
  permission?: PendingPermission;
  question?: PendingQuestion;
  activity?: Activity;
  density?: Density;
 /** Render the latest plan as a full card (off when a side panel shows it). */
  planInline?: boolean;
  onDecide(decision: PermissionDecision): void;
  onAnswer(answers: QuestionAnswers): void;
  onRetry(): void;
 /** Sub-agents spawned by `task` calls, keyed by the parent tool call id. */
  subagents?: Record<string, SubagentRun[]>;
  /** Open a workspace path in the in-app preview (or host editor). */
  onOpenPath?: (path: string) => void;
}

interface SubagentNav {
  runs: Record<string, SubagentRun[]>;
  open(toolCallId: string, index: number): void;
}

const SubagentContext = createContext<SubagentNav | undefined>(undefined);
const OpenPathContext = createContext<((path: string) => void) | undefined>(undefined);

export function Transcript(props: TranscriptProps): React.ReactElement {
  const [viewing, setViewing] = useState<{ toolCallId: string; index: number } | undefined>();
  const runs = props.subagents ?? {};
  const run = viewing ? runs[viewing.toolCallId]?.find((r) => r.index === viewing.index) : undefined;
  const nav: SubagentNav = { runs, open: (toolCallId, index) => setViewing({ toolCallId, index }) };

  if (!run) {
    return (
      <OpenPathContext.Provider value={props.onOpenPath}>
        <SubagentContext.Provider value={nav}>
          <MainTranscript {...props} />
        </SubagentContext.Provider>
      </OpenPathContext.Provider>
    );
  }
  return (
    <OpenPathContext.Provider value={props.onOpenPath}>
      <div className="flex flex-col gap-3">
        <div className="sticky top-0 z-10 flex items-center gap-2 rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-[12px]">
          <button
            type="button"
            onClick={() => setViewing(undefined)}
            className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)]"
          >
            ← {t("Back to main task")}
          </button>
          <SubagentStateIcon state={run.state} />
          <span className="min-w-0 truncate text-[var(--color-ink)]" title={run.objective}>
            {t("Subtask")} #{run.index + 1}: {run.objective}
          </span>
        </div>
        <Transcript
          {...props}
          rows={run.view.rows}
          status={run.state === "running" ? "thinking" : "idle"}
          activity={run.view.activity}
          subagents={run.view.subagents}
          planInline
        />
      </div>
    </OpenPathContext.Provider>
  );
}

function MainTranscript({
  rows,
  status,
  permission,
  question,
  activity,
  density = "comfortable",
  planInline = true,
  onDecide,
  onAnswer,
  onRetry,
}: TranscriptProps): React.ReactElement {
  const blocks = groupRows(rows);
  const busy = status !== "idle";
  const last = blocks[blocks.length - 1];
  const lastTurn = last?.kind === "assistant_turn" ? last : undefined;
  const toolsRunning =
    lastTurn?.parts.some((p) => p.kind === "steps" && p.tools.some((x) => x.status === "running")) ?? false;
  const answerStreaming =
    lastTurn?.parts.some((p) => p.kind === "message" && p.msg.streaming) ?? false;
  const retrying =
    lastTurn?.parts.some((p) => p.kind === "row" && p.row.kind === "retry") ?? false;
  const showThinking =
    status === "thinking" &&
    !answerStreaming &&
    !retrying &&
    (!toolsRunning || activity?.phase === "tools");
  const canRetry = !busy && endsInError(rows);

  return (
    <div className={`flex flex-col ${density === "compact" ? "gap-3" : "gap-4"}`}>
      {blocks.map((b, i) => (
        <BlockView
          key={b.key}
          block={b}
          density={density}
          planInline={planInline}
          isLast={i === blocks.length - 1}
          busy={busy}
          canRetry={canRetry && i === blocks.length - 1}
          onRetry={onRetry}
        />
      ))}
      {showThinking && <ActivityRow activity={activity} />}
      {status === "compacting" && <ThinkingRow label={t("Compacting context")} />}
      {permission && <PermissionCard req={permission} onDecide={onDecide} />}
      {question && <QuestionCard req={question} onAnswer={onAnswer} />}
    </div>
  );
}

function BlockView({
  block,
  density,
  planInline,
  isLast,
  busy,
  canRetry,
  onRetry,
}: {
  block: Block;
  density: Density;
  planInline: boolean;
  isLast: boolean;
  busy: boolean;
  canRetry: boolean;
  onRetry(): void;
}): React.ReactElement | null {
  switch (block.kind) {
    case "message":
      return <MessageView msg={block.msg} density={density} />;
    case "assistant_turn":
      return (
        <AssistantTurnView
          parts={block.parts}
          density={density}
          planInline={planInline}
          live={isLast && busy}
          canRetry={canRetry}
          onRetry={onRetry}
        />
      );
  }
}

/** One left avatar for the whole post-user turn (tools + all assistant texts). */
function AssistantTurnView({
  parts,
  density,
  planInline,
  live,
  canRetry,
  onRetry,
}: {
  parts: TurnPart[];
  density: Density;
  planInline: boolean;
  live: boolean;
  canRetry: boolean;
  onRetry(): void;
}): React.ReactElement | null {
  const onOpenPath = useContext(OpenPathContext);
  if (parts.length === 0) return null;
  const messages = parts.filter((p): p is Extract<typeof p, { kind: "message" }> => p.kind === "message");
  const streaming = messages.some((m) => m.msg.streaming);
  const copyText = messages
    .map((m) => stripThinking(m.msg.text))
    .filter((t) => t.trim() !== "")
    .join("\n\n");
  const model = [...messages].reverse().find((m) => m.msg.model)?.msg.model;

  return (
    <div className="group flex animate-fade-in gap-3">
      {density === "comfortable" && <LogoMark size={24} className="mt-0.5 shrink-0" />}
      <div className={`min-w-0 flex-1 ${density === "compact" ? "space-y-2" : "space-y-3"}`}>
        {parts.map((p, i) => {
          switch (p.kind) {
            case "message":
              return (
                <div key={p.msg.id}>
                  {p.msg.reasoning ? (
                    <ReasoningBlock text={p.msg.reasoning} streaming={p.msg.streaming && !p.msg.text} />
                  ) : null}
                  <Markdown text={p.msg.text} onOpenPath={onOpenPath} />
                  {p.msg.streaming && (
                    <span className="ml-0.5 inline-block h-4 w-1.5 animate-breathe rounded-sm bg-[var(--color-accent)] align-text-bottom" />
                  )}
                </div>
              );
            case "steps":
              return <StepGroup key={`s-${p.tools[0]?.id ?? i}`} tools={p.tools} live={live} />;
            case "plan":
              return p.latest && planInline ? (
                <PlanCard key={`p-${i}`} steps={p.steps} />
              ) : (
                <PlanMarker key={`p-${i}`} steps={p.steps} />
              );
            case "row":
              return (
                <MiscRow
                  key={`r-${p.row.kind}-${p.row.at}`}
                  row={p.row}
                  canRetry={canRetry && i === parts.length - 1}
                  onRetry={onRetry}
                />
              );
          }
        })}
        {!streaming && (copyText || model) && (
          <div className="flex h-5 items-center gap-2 text-[11px] text-[var(--color-ink-faint)] opacity-0 transition-opacity group-hover:opacity-100">
            {copyText ? <CopyButton text={copyText} /> : null}
            {model && <span className="font-mono">{model}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- messages

/** Thumbnails; click opens the full image in a new tab. */
function ImageStrip({ images }: { images: ImageAttachment[] }): React.ReactElement {
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

function FileStrip({ files }: { files: SavedUpload[] }): React.ReactElement {
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
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }): React.ReactElement {
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

function MessageView({ msg, density }: { msg: MessageRow; density: Density }): React.ReactElement | null {
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

function CopyButton({ text }: { text: string }): React.ReactElement {
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
function ActivityRow({ activity }: { activity?: Activity }): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!activity) return <ThinkingRow label={t("Thinking")} />;
  const secs = Math.max(0, Math.round((now - activity.since) / 1000));
  const label =
    activity.phase === "model"
      ? t("Waiting for model response")
      : `${t("Running tools")}: ${(activity.tools ?? []).join(", ")}`;
  return <ThinkingRow label={`${label} · ${secs}s`} />;
}

function ThinkingRow({ label }: { label: string }): React.ReactElement {
  return (
    <div className="flex animate-fade-in items-center gap-2.5 pl-0.5 text-[12.5px]">
      <span className="flex h-5 w-5 items-center justify-center">
        <SparkIcon className="h-4 w-4 animate-breathe text-[var(--color-accent)]" />
      </span>
      <span className="cp-shimmer font-medium">{label}…</span>
    </div>
  );
}

// ---------------------------------------------------------------- steps

const CATEGORY_ICON: Record<ToolCategory, (p: { className?: string }) => React.ReactElement> = {
  read: BookIcon,
  list: FolderIcon,
  search: SearchIcon,
  edit: PencilIcon,
  write: FilePlusIcon,
  bash: TerminalIcon,
  web: GlobeIcon,
  task: UsersIcon,
  memory: BrainIcon,
  plan: ListIcon,
  ask: QuestionIcon,
  other: WrenchIcon,
};

export function CategoryIcon({ name, className }: { name: string; className?: string }): React.ReactElement {
  const Icon = CATEGORY_ICON[toolCategory(name)];
  return <Icon className={className} />;
}

function StepGroup({ tools, live }: { tools: ToolRow[]; live: boolean }): React.ReactElement {
  const running = tools.some((x) => x.status === "running");
  const failed = tools.filter((x) => x.status === "error").length;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
 // Live groups stay open so progress is visible; finished ones fold to a
 // one-line summary unless the user opened them.
  const open = userOpen ?? (running || live || tools.length <= 2);

  const categories = [...new Set(tools.map((x) => toolCategory(x.name)))].slice(0, 5);
  const startedAt = tools[0]?.startedAt;
  const finishedAt = tools[tools.length - 1]?.finishedAt;

  return (
    <div className="animate-fade-in overflow-hidden rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)]">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        {running ? (
          <SpinnerIcon className="h-3.5 w-3.5 text-[var(--color-accent)]" />
        ) : failed > 0 ? (
          <AlertIcon className="h-3.5 w-3.5 text-[var(--color-warn)]" />
        ) : (
          <CheckIcon className="h-3.5 w-3.5 text-[var(--color-add)]" />
        )}
        <span className="font-medium text-[var(--color-ink)]">
          {running ? t("Running") : t("Ran")} {tools.length} {t(tools.length === 1 ? "step" : "steps")}
        </span>
        <span className="flex items-center gap-1 text-[var(--color-ink-faint)]">
          {categories.map((c) => {
            const Icon = CATEGORY_ICON[c];
            return <Icon key={c} className="h-3 w-3" />;
          })}
        </span>
        {failed > 0 && (
          <span className="rounded-full bg-[var(--color-warn-dim)] px-1.5 text-[10px] text-[var(--color-warn)]">
            {failed} {t("failed")}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-[var(--color-ink-faint)]">
          {!running && startedAt && finishedAt && formatDuration(finishedAt - startedAt)}
          <ChevronIcon open={open} className="h-3 w-3" />
        </span>
      </button>
      {open && (
        <ul className="border-t border-[var(--color-edge-subtle)] py-1">
          {tools.map((tool) => (
            <StepItem key={tool.id} tool={tool} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SubagentStateIcon({ state }: { state: SubagentRun["state"] }): React.ReactElement {
  if (state === "running") return <SpinnerIcon className="h-3 w-3 shrink-0 text-[var(--color-accent)]" />;
  if (state === "failed") return <XIcon className="h-3 w-3 shrink-0 text-[var(--color-remove)]" />;
  return <CheckIcon className="h-3 w-3 shrink-0 text-[var(--color-add)]" />;
}

/** One clickable chip per sub-agent of a `task` call. */
function SubagentChips({ toolCallId }: { toolCallId: string }): React.ReactElement | null {
  const nav = useContext(SubagentContext);
  const runs = nav?.runs[toolCallId];
  if (!nav || !runs?.length) return null;
  return (
    <div className="flex flex-col gap-1 px-3 pb-1.5 pl-10">
      {runs.map((r) => {
        const steps = r.view.rows.filter((x) => x.kind === "tool").length;
        const last = [...r.view.rows].reverse().find((x) => x.kind === "tool");
        const doing = r.state === "running" && last?.kind === "tool" ? toolTarget(last.tool.input) || last.tool.name : "";
        return (
          <button
            key={r.index}
            type="button"
            onClick={() => nav.open(toolCallId, r.index)}
            title={t("View subtask")}
            className="flex items-center gap-2 rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] px-2 py-1 text-left text-[11.5px] transition-colors hover:border-[var(--color-accent)]"
          >
            <SubagentStateIcon state={r.state} />
            <span className="shrink-0 text-[var(--color-ink-faint)]">#{r.index + 1}</span>
            <span className="min-w-0 truncate text-[var(--color-ink)]">{r.objective}</span>
            {doing && (
              <span className="min-w-0 max-w-[40%] truncate font-mono text-[10.5px] text-[var(--color-ink-faint)]">
                {doing}
              </span>
            )}
            <span className="ml-auto shrink-0 text-[10.5px] text-[var(--color-ink-faint)]">
              {steps} {t(steps === 1 ? "step" : "steps")} ›
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PathChip({ path }: { path: string }): React.ReactElement {
  const onOpen = useContext(OpenPathContext);
  if (!onOpen || !looksLikeWorkspacePath(path)) {
    return (
      <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--color-ink)]" title={path}>
        {path}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`${t("Preview")} ${path}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(path);
      }}
      className="min-w-0 truncate font-mono text-[11.5px] text-[var(--color-accent)] underline-offset-2 hover:underline"
    >
      {path}
    </button>
  );
}

function StepItem({ tool }: { tool: ToolRow }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const onOpenPath = useContext(OpenPathContext);
  const category = toolCategory(tool.name);
  const target = toolTarget(tool.input);
  const duration =
    tool.startedAt && tool.finishedAt ? formatDuration(tool.finishedAt - tool.startedAt) : undefined;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${
            tool.status === "error"
              ? "bg-[var(--color-remove-dim)] text-[var(--color-remove)]"
              : tool.status === "running"
                ? "bg-[var(--color-accent-dim)] text-[var(--color-accent)]"
                : "bg-[var(--color-surface-sunken)] text-[var(--color-ink-dim)]"
          }`}
        >
          {tool.status === "running" ? (
            <SpinnerIcon className="h-3 w-3" />
          ) : (
            <CategoryIcon name={tool.name} className="h-3 w-3" />
          )}
        </span>
        <span className="shrink-0 text-[var(--color-ink-dim)]">{t(CATEGORY_VERB[category])}</span>
        {target ? (
          <PathChip path={target} />
        ) : (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--color-ink)]">{tool.name}</span>
        )}
        {tool.change && (
          <span className="shrink-0 font-mono text-[10.5px]">
            {tool.change.added > 0 && <span className="text-[var(--color-add)]">+{tool.change.added}</span>}
            {tool.change.removed > 0 && (
              <span className="ml-1 text-[var(--color-remove)]">−{tool.change.removed}</span>
            )}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[10.5px] text-[var(--color-ink-faint)]">
          {tool.status === "error" && <XIcon className="h-3 w-3 text-[var(--color-remove)]" />}
          {duration}
          <ChevronIcon open={open} className="h-3 w-3" />
        </span>
      </button>
      {tool.name === "task" && <SubagentChips toolCallId={tool.id} />}
      {open && (
        <div className="space-y-2 px-3 pt-1 pb-2.5 pl-10">
          {tool.change ? (
            <DiffBlock change={tool.change} onOpenPath={onOpenPath} />
          ) : (
            <Labelled label={t("input")}>
              <pre className="max-h-48 overflow-auto rounded-lg bg-[var(--color-surface-sunken)] p-2 text-[11px] leading-5 whitespace-pre-wrap text-[var(--color-ink-dim)]">
                {formatInput(tool.input)}
              </pre>
            </Labelled>
          )}
          {tool.result !== undefined && (
            <Labelled label={tool.status === "error" ? t("error") : t("result")}>
              <pre
                className={`max-h-72 overflow-auto rounded-lg p-2 text-[11px] leading-5 whitespace-pre-wrap ${
                  tool.status === "error"
                    ? "bg-[var(--color-remove-dim)] text-[var(--color-remove)]"
                    : "bg-[var(--color-surface-sunken)] text-[var(--color-ink-dim)]"
                }`}
              >
                {tool.result || "(no output)"}
              </pre>
            </Labelled>
          )}
          {tool.images && tool.images.length > 0 && <ImageStrip images={tool.images} />}
          {tool.artifactRef && (
            <div className="text-[11px] text-[var(--color-ink-faint)]">
              {t("Full output saved as artifact")} <code className="cp-chip">{tool.artifactRef}</code>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">{label}</div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- plan

export function PlanChecklist({ steps, dense = false }: { steps: PlanStep[]; dense?: boolean }): React.ReactElement {
  return (
    <ol className={dense ? "space-y-1" : "space-y-1.5"}>
      {steps.map((s) => (
        <li key={s.id} className="flex items-start gap-2 text-[12.5px] leading-5">
          <StepMark status={s.status} />
          <span
            className={
              s.status === "completed"
                ? "text-[var(--color-ink-faint)] line-through decoration-[var(--color-ink-faint)]/50"
                : s.status === "in_progress"
                  ? "font-medium text-[var(--color-ink)]"
                  : s.status === "blocked"
                    ? "text-[var(--color-remove)]"
                    : "text-[var(--color-ink-dim)]"
            }
          >
            {s.title}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepMark({ status }: { status: PlanStep["status"] }): React.ReactElement {
  if (status === "completed") {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-add)] text-white">
        <CheckIcon className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-[var(--color-accent)]">
        <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-[var(--color-accent)]" />
      </span>
    );
  }
  if (status === "blocked") {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-remove-dim)] text-[var(--color-remove)]">
        <XIcon className="h-2.5 w-2.5" />
      </span>
    );
  }
  return <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-[1.5px] border-[var(--color-edge)]" />;
}

export function ProgressBar({ done, total }: { done: number; total: number }): React.ReactElement {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
      <div className="cp-brand-gradient h-full rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

function PlanCard({ steps }: { steps: PlanStep[] }): React.ReactElement {
  const p = planProgress(steps);
  return (
    <div className="animate-fade-in rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] p-3">
      <div className="mb-2.5 flex items-center gap-2">
        <ListIcon className="h-3.5 w-3.5 text-[var(--color-accent)]" />
        <span className="text-[12px] font-semibold text-[var(--color-ink)]">{t("Plan")}</span>
        <span className="text-[11px] text-[var(--color-ink-faint)]">
          {p.done} {t("of")} {p.total}
        </span>
        <div className="ml-auto w-24">
          <ProgressBar done={p.done} total={p.total} />
        </div>
      </div>
      <PlanChecklist steps={steps} />
    </div>
  );
}

function PlanMarker({ steps }: { steps: PlanStep[] }): React.ReactElement {
  const p = planProgress(steps);
  return (
    <Divider icon={<ListIcon className="h-3 w-3" />}>
      {t("Plan updated")} · {p.done}/{p.total}
      {p.current ? ` · ${p.current.title}` : ""}
    </Divider>
  );
}

// ---------------------------------------------------------------- misc rows

function MiscRow({
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

function Divider({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }): React.ReactElement {
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

function CompactionNote({ summary, foldKind }: { summary: string; foldKind?: "summary" | "micro-fold" }): React.ReactElement {
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
          <Markdown text={summary} />
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

function TeamNote({ team }: { team: TeamRow }): React.ReactElement {
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

// ---------------------------------------------------------------- inline cards

/**
 * Tool approval, rendered at the end of the transcript (not a modal) so the
 * user can still scroll and read what led to the request. The command is
 * shown verbatim and untruncated: approving something you cannot fully read
 * is exactly what this card exists to prevent.
 */
export function PermissionCard({
  req,
  onDecide,
}: {
  req: PendingPermission;
  onDecide(decision: PermissionDecision): void;
}): React.ReactElement {
  const allowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => allowRef.current?.focus(), [req.requestId]);
  return (
    <div className="animate-fade-in overflow-hidden rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-surface-raised)] shadow-lg shadow-black/10">
      <div className="flex items-center gap-2 border-b border-[var(--color-edge-subtle)] bg-[var(--color-warn-dim)] px-3 py-2 text-[12px] text-[var(--color-warn)]">
        <ShieldIcon className="h-3.5 w-3.5" />
        <span className="font-semibold">{t("Permission required")}</span>
        <span className="text-[var(--color-ink-dim)]">· {t("CodePilot wants to run")}</span>
        <span className="cp-chip">
          <CategoryIcon name={req.toolName} className="h-3 w-3" />
          {req.toolName}
        </span>
      </div>
      <div className="p-3">
        {req.reason && <div className="mb-2 text-[12px] text-[var(--color-ink-dim)]">{req.reason}</div>}
        <pre className="max-h-64 overflow-auto rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] p-2.5 text-[11.5px] leading-5 whitespace-pre-wrap text-[var(--color-ink)]">
          {formatInput(req.input)}
        </pre>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={() => onDecide("deny")} className="cp-btn-danger">
            {t("Deny")}
          </button>
          <button
            type="button"
            onClick={() => onDecide("always")}
            title={
              req.sandboxExpand
                ? t("Save this folder to sandbox.writablePaths for future sessions")
                : "Remember this command pattern for this session — other commands still ask"
            }
            className="cp-btn-ghost"
          >
            {req.sandboxExpand ? t("Always allow folder") : t("Always allow")}
          </button>
          <button ref={allowRef} type="button" onClick={() => onDecide("allow")} className="cp-btn-primary">
            <CheckIcon className="h-3 w-3" />
            {req.sandboxExpand ? t("Allow folder once") : t("Allow once")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** `ask_user_question` / `plan_done`: options plus a free-text answer. */
export function QuestionCard({
  req,
  onAnswer,
}: {
  req: PendingQuestion;
  onAnswer(answers: QuestionAnswers): void;
}): React.ReactElement {
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  const pick = (id: string, label: string, multi: boolean): void => {
    setAnswers((prev) => {
      if (!multi) return { ...prev, [id]: label };
      const current = prev[id];
      const list = Array.isArray(current) ? current : current ? [current] : [];
      return { ...prev, [id]: list.includes(label) ? list.filter((l) => l !== label) : [...list, label] };
    });
  };
  const isPicked = (id: string, label: string): boolean => {
    const v = answers[id];
    return Array.isArray(v) ? v.includes(label) : v === label;
  };
  const submit = (): void => {
 // Free text wins for its question: the user typed it because no option fit.
    const merged: QuestionAnswers = { ...answers };
    for (const [id, text] of Object.entries(freeText)) {
      if (text.trim() !== "") merged[id] = text.trim();
    }
    onAnswer(merged);
  };

  return (
    <div className="animate-fade-in overflow-hidden rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-surface-raised)] shadow-lg shadow-black/10">
      <div className="flex items-center gap-2 border-b border-[var(--color-edge-subtle)] bg-[var(--color-accent-dim)] px-3 py-2 text-[12px] font-semibold text-[var(--color-accent)]">
        <QuestionIcon className="h-3.5 w-3.5" />
        {t("The agent is asking")}
      </div>
      <div className="max-h-[50vh] space-y-4 overflow-auto p-3">
        {req.questions.map((q) => {
          const options = q.options ?? [];
 // Recommendation convention: the FIRST option is treated as the
 // recommended one (core asks callers to put it first / label it
 // "(Recommended)"). Surface it with a badge so the user has a hint.
          return (
            <div key={q.id}>
              {q.header && <div className="cp-eyebrow mb-1">{q.header}</div>}
              <div className="mb-2 select-text whitespace-pre-wrap text-[13px] text-[var(--color-ink)]">
                {q.question}
              </div>
              {/* Vertical list — one option per row, full width, so long
                  answers wrap instead of cramming into chips. */}
              <div className="flex flex-col gap-1.5">
                {options.map((opt, i) => {
                  const picked = isPicked(q.id, opt.label);
                  const recommended =
                    i === 0 || /\(recommended\)|（推荐）|推荐/i.test(opt.label);
                  const cleanLabel = opt.label.replace(/\s*\(recommended\)\s*/i, "").replace(/（推荐）/g, "").trim();
                  return (
                    <div
                      key={opt.label}
                      className={`group flex items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                        picked
                          ? "border-[var(--color-accent)] bg-[var(--color-accent-dim)]"
                          : "border-[var(--color-edge)] hover:bg-[var(--color-surface-hover)]"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => pick(q.id, opt.label, q.multiSelect === true)}
                        aria-pressed={picked}
                        className="mt-0.5 shrink-0"
                        title={q.multiSelect ? t("Toggle") : t("Select")}
                      >
                        <span
                          className={`flex h-4 w-4 items-center justify-center border ${
                            q.multiSelect ? "rounded" : "rounded-full"
                          } ${
                            picked
                              ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                              : "border-[var(--color-edge)] text-transparent group-hover:border-[var(--color-ink-dim)]"
                          }`}
                        >
                          {picked && <CheckIcon className="h-3 w-3" />}
                        </span>
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {/* select-text so the user can copy the answer to search it */}
                          <button
                            type="button"
                            onClick={() => pick(q.id, opt.label, q.multiSelect === true)}
                            className="select-text text-left text-[13px] font-medium text-[var(--color-ink)]"
                          >
                            {cleanLabel}
                          </button>
                          {recommended && (
                            <span className="rounded-full bg-[var(--color-accent-dim)] px-1.5 py-px text-[10px] font-semibold text-[var(--color-accent)]">
                              {t("Recommended")}
                            </span>
                          )}
                        </div>
                        {opt.description && (
                          <div className="mt-0.5 select-text whitespace-pre-wrap break-words text-[12px] leading-snug text-[var(--color-ink-dim)]">
                            {opt.description}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <input
                value={freeText[q.id] ?? ""}
                onChange={(e) => setFreeText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                placeholder={t("or type an answer")}
                className="cp-input mt-2 w-full"
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--color-edge-subtle)] px-3 py-2">
        <button type="button" onClick={() => onAnswer({})} title="Sending no answers is treated as 'not approved'" className="cp-btn-ghost">
          {t("Skip")}
        </button>
        <button type="button" onClick={submit} className="cp-btn-primary">
          {t("Answer")}
        </button>
      </div>
    </div>
  );
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null) {
    const o = input as Record<string, unknown>;
    // apply_patch: prefer file list (+ optional patch body) over opaque JSON.
    if (Array.isArray(o.files) && o.files.every((f) => typeof f === "string")) {
      const files = o.files as string[];
      const head = files.length ? `Files:\n${files.map((f) => `  ${f}`).join("\n")}` : "Files: (none)";
      if (typeof o.patch === "string" && o.patch.length > 0) {
        const max = 4000;
        const body = o.patch.length > max ? `${o.patch.slice(0, max)}\n…` : o.patch;
        return `${head}\n\n${body}`;
      }
      return head;
    }
    // Background-job tools: prefer the resolved command over bare job_id JSON.
    if (typeof o.command === "string" && typeof o.job_id === "string") {
      const parts = [o.command];
      const meta = [`job ${o.job_id}`];
      if (typeof o.status === "string") meta.push(o.status);
      parts.push(`(${meta.join(", ")})`);
      if (typeof o.input === "string" && o.input.length > 0) {
        parts.push(`stdin:\n${o.input}`);
      }
      return parts.join("\n\n");
    }
    if (typeof o.command === "string") return o.command;
  }
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}
