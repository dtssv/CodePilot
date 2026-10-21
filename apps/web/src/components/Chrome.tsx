import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { AgentMode, FollowUpItem, ImageAttachment, PromptFile, SessionSummary } from "@codepilot/core";
import type { AppState } from "../state/reducer.js";
import {
  filesFromList,
  imageDataUrl,
  isImageFile,
  readAttachment,
  splitAttachments,
  type PendingAttachment,
} from "../state/attachments.js";
import { dateBucket, formatTokens, type DateBucket } from "../state/selectors.js";
import type { Theme } from "../surface.js";
import { t } from "../i18n.js";
import {
  AlertIcon,
  ArrowRightIcon,
  ChatIcon,
  ChevronIcon,
  ForkIcon,
  FileIcon,
  FolderIcon,
  LogoMark,
  MoonIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  StopIcon,
  SunIcon,
  XIcon,
} from "./Icons.js";
import { sameCwd } from "../prefs.js";

// ---------------------------------------------------------------- composer

const MODE_LABEL: Record<AgentMode, string> = { chat: "Ask", plan: "Plan", agent: "Agent" };
const MODE_HINT: Record<AgentMode, string> = {
  chat: "Read-only Q&A",
  plan: "Explore and write a plan, no changes",
  agent: "Edit files and run commands",
};

export interface ComposerProps {
  value: string;
  onChange(v: string): void;
  onSend(
    text: string,
    images?: ImageAttachment[],
    files?: PromptFile[],
    delivery?: "auto" | "queue" | "steer",
  ): void;
  onStop(): void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  mode?: AgentMode;
  modes?: AgentMode[];
  onMode?(m: AgentMode): void;
  size?: "md" | "lg";
  autoFocus?: boolean;
  footer?: React.ReactNode;
  followUps?: FollowUpItem[];
  onRemoveFollowUp?(id: string): void;
  /** Pull a queued item back into the composer for editing. */
  onEditFollowUp?(id: string): void;
  /** Stop the current run and start this queued item next. */
  onSendFollowUpNow?(id: string): void;
}

/** Prompt box. Enter sends, Shift+Enter is a newline, Esc stops a run.
 * Images and files can be pasted, dropped, or picked; `@path/to/img.png` in
 * the text is also attached server-side. */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled = false,
  placeholder,
  mode,
  modes = [],
  onMode,
  size = "md",
  autoFocus = false,
  footer,
  followUps = [],
  onRemoveFollowUp,
  onEditFollowUp,
  onSendFollowUpNow,
}: ComposerProps): React.ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  const addFiles = (files: File[]): void => {
    if (files.length === 0) return;
    setAttachError(null);
    void Promise.all(
      files.map((f) =>
        readAttachment(f).catch((err: unknown) => {
          setAttachError(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }),
      ),
    ).then((read) =>
      setAttachments((prev) => [...prev, ...read.filter((x): x is PendingAttachment => x !== null)]),
    );
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, size === "lg" ? 260 : 220)}px`;
  }, [value, size]);

  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus();
  }, [autoFocus, disabled]);

  const canSend = !disabled && (value.trim() !== "" || attachments.length > 0);
  const send = (delivery: "auto" | "steer" = "auto"): void => {
    if (!canSend) return;
    // Inject-into-run is text-only (attachments stay on the queue path).
    if (delivery === "steer" && attachments.length > 0) return;
    const { images, files } = splitAttachments(attachments);
    const fallback =
      images.length > 0 && files.length === 0
        ? t("See the attached image.")
        : files.length > 0
          ? t("See the attached file.")
          : t("See the attached image.");
    const text = value.trim() || fallback;
    onSend(
      text,
      delivery === "steer" ? undefined : images.length > 0 ? images : undefined,
      delivery === "steer" ? undefined : files.length > 0 ? files : undefined,
      busy ? delivery : "auto",
    );
    onChange("");
    setAttachments([]);
    setAttachError(null);
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {followUps.length > 0 && (
        <div
          className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)]/80 px-2.5 py-2"
          aria-label={t("Queued messages")}
        >
          <div className="px-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
            {t("Queued")} · {followUps.length}
          </div>
          {followUps.map((fu, i) => (
            <div
              key={fu.id}
              className="group flex items-start gap-1.5 rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface-raised)] px-2 py-1.5"
            >
              <span className="mt-0.5 shrink-0 rounded bg-[var(--color-surface-sunken)] px-1.5 text-[10px] tabular-nums text-[var(--color-ink-faint)]">
                {i + 1}
              </span>
              <button
                type="button"
                onClick={() => onEditFollowUp?.(fu.id)}
                title={t("Edit queued message")}
                className="min-w-0 flex-1 text-left text-[12px] leading-5 text-[var(--color-ink)] hover:text-[var(--color-accent)]"
              >
                <span className="line-clamp-3 whitespace-pre-wrap break-words">{fu.text}</span>
              </button>
              <div className="flex shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100">
                {onSendFollowUpNow && (
                  <button
                    type="button"
                    onClick={() => onSendFollowUpNow(fu.id)}
                    title={t("Send now (stop current run)")}
                    aria-label={t("Send now")}
                    className="rounded-md px-1.5 py-1 text-[11px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)]"
                  >
                    {t("Send now")}
                  </button>
                )}
                {onRemoveFollowUp && (
                  <button
                    type="button"
                    aria-label={t("Remove from queue")}
                    onClick={() => onRemoveFollowUp(fu.id)}
                    className="rounded-md p-1 hover:bg-[var(--color-edge)]"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    <div
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (disabled) return;
        const files = filesFromList(e.dataTransfer.files);
        if (files.length === 0) return;
        e.preventDefault();
        addFiles(files);
      }}
      className={`rounded-2xl border bg-[var(--color-surface-raised)] shadow-sm transition-all focus-within:border-[var(--color-accent)] focus-within:shadow-[0_0_0_3px_var(--color-accent-dim)] ${
        dragging ? "border-[var(--color-accent)]" : "border-[var(--color-edge)]"
      } ${disabled ? "opacity-60" : ""}`}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a) => (
            <div key={a.id} className="group relative">
              {a.kind === "image" ? (
                <img
                  src={imageDataUrl(a)}
                  alt={a.name}
                  title={a.name}
                  className="h-16 w-16 rounded-lg border border-[var(--color-edge)] object-cover"
                />
              ) : (
                <div
                  title={a.name}
                  className="flex h-16 max-w-[10rem] items-center gap-2 rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface-sunken)] px-2.5"
                >
                  <FileIcon className="h-4 w-4 shrink-0 text-[var(--color-ink-dim)]" />
                  <span className="truncate text-[11px] text-[var(--color-ink)]">{a.name}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                aria-label={t("Remove attachment")}
                className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-ink)] text-[var(--color-surface)] opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachError && <div className="px-4 pt-2 text-[11px] text-[var(--color-remove)]">{attachError}</div>}
      <textarea
        ref={ref}
        value={value}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => {
          const files = filesFromList(e.clipboardData.files);
          if (files.length === 0) return;
 // Keep text paste when the clipboard has no files; only claim file pastes.
          if (!files.some(isImageFile) && !files.some((f) => f.size > 0)) return;
          e.preventDefault();
          addFiles(files);
        }}
        onKeyDown={(e) => {
 // IME composition (Chinese/Japanese input) uses Enter to commit a
 // candidate; that must not send the message.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if ((e.metaKey || e.ctrlKey) && busy) send("steer");
            else send("auto");
          } else if (e.key === "Escape" && busy) {
            e.preventDefault();
            onStop();
          }
        }}
        placeholder={
          placeholder ??
          (busy
            ? t("Queued on Enter · ⌘↵ inject into current run…")
            : t("Ask CodePilot…"))
        }
        disabled={disabled}
        aria-label="Prompt"
        className={`block w-full resize-none bg-transparent px-4 text-[var(--color-ink)] outline-none focus-visible:outline-none placeholder:text-[var(--color-ink-faint)] ${
          size === "lg" ? "min-h-20 pt-4 pb-2 text-[14.5px] leading-6" : "min-h-11 pt-3 pb-1 text-[13px] leading-6"
        }`}
      />
      <div className="flex items-center gap-2 px-2.5 pb-2.5">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(filesFromList(e.target.files));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          title={t("Attach files (or paste / drop; @path/to/image.png also works)")}
          aria-label={t("Attach files")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed"
        >
          <FileIcon className="h-4 w-4" />
        </button>
        {modes.length > 1 && mode && onMode && (
          <ModeSwitch mode={mode} modes={modes} onMode={onMode} disabled={disabled} />
        )}
        {/* overflow-visible: ModelPicker menu portals out; truncate clipped it. */}
        <div className="min-w-0 flex-1 overflow-visible text-[11px] text-[var(--color-ink-faint)]">
          {footer}
        </div>
        {busy && (
          <button
            type="button"
            onClick={() => send("steer")}
            disabled={!canSend || attachments.length > 0}
            title={t("Inject into current run (⌘↵)")}
            aria-label={t("Inject into current run")}
            className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-[var(--color-edge)] px-2.5 text-[11px] text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-30"
          >
            {t("Inject")}
          </button>
        )}
        {busy ? (
          <>
            <button
              type="button"
              onClick={() => send("auto")}
              disabled={!canSend}
              title={t("Queue for after this run (Enter)")}
              aria-label={t("Queue")}
              className="cp-brand-gradient flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white shadow-md shadow-[var(--color-accent-dim)] transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100"
            >
              <SendIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onStop}
              title={`${t("Stop")} (Esc)`}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-ink)] text-[var(--color-surface)] transition-transform hover:scale-105"
            >
              <StopIcon className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => send("auto")}
            disabled={!canSend}
            title={t("Enter to send · Shift+Enter for newline")}
            aria-label={t("Send")}
            className="cp-brand-gradient flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white shadow-md shadow-[var(--color-accent-dim)] transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100"
          >
            <SendIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
    </div>
  );
}

export function ModeSwitch({
  mode,
  modes,
  onMode,
  disabled,
}: {
  mode: AgentMode;
  modes: AgentMode[];
  onMode(m: AgentMode): void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <div className="flex shrink-0 gap-0.5 rounded-lg bg-[var(--color-surface-sunken)] p-0.5">
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onMode(m)}
          disabled={disabled}
          title={t(MODE_HINT[m] ?? m)}
          className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
            mode === m
              ? "bg-[var(--color-surface-raised)] text-[var(--color-ink)] shadow-sm"
              : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
          } disabled:cursor-not-allowed`}
        >
          {t(MODE_LABEL[m] ?? m)}
        </button>
      ))}
    </div>
  );
}

/** Token totals line used under the composer (model shown via ModelPicker). */
export function UsageLine({ state }: { state: AppState }): React.ReactElement | null {
  if (state.usage.input === 0 && state.usage.output === 0) return null;
  return (
    <span className="flex items-center gap-2">
      {state.usage.input > 0 && (
        <span>
          {formatTokens(state.usage.input)} / {formatTokens(state.usage.output)} {t("tokens")}
          {state.usage.costUSD !== undefined ? ` · $${state.usage.costUSD.toFixed(3)}` : ""}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- status

export function ConnectionPill({ state }: { state: AppState }): React.ReactElement {
  const reconnecting = state.connection === "connecting" && state.reconnectAttempt !== undefined;
  const tone =
    state.connection === "connected"
      ? "bg-[var(--color-add)]"
      : state.connection === "connecting"
        ? "bg-[var(--color-warn)] animate-breathe"
        : "bg-[var(--color-remove)]";
  const label = reconnecting
    ? `${t("reconnecting")} (${state.reconnectAttempt})`
    : t(state.connection);
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-ink-dim)]" title={state.connectionError}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
      {label}
    </span>
  );
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle(): void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`${t("Theme")}: ${theme === "dark" ? t("Dark") : t("Light")}`}
      className="cp-icon-btn"
    >
      {theme === "dark" ? <MoonIcon className="h-4 w-4" /> : <SunIcon className="h-4 w-4" />}
    </button>
  );
}

/** Self-dismissing toast for `state.notice`. */
export function Toast({ text, onDone }: { text?: string; onDone(): void }): React.ReactElement | null {
  useEffect(() => {
    if (!text) return;
    const id = setTimeout(onDone, 4500);
    return () => clearTimeout(id);
  }, [text, onDone]);
  if (!text) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto max-w-lg animate-fade-in truncate rounded-full border border-[var(--color-edge)] bg-[var(--color-surface-raised)] px-4 py-1.5 text-[12px] text-[var(--color-ink-dim)] shadow-lg"
        title={text}
      >
        {text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sessions

const DEFAULT_SESSION_PREVIEW = 5;
const SESSION_PAGE_SIZE = 10;

export function SessionList({
  sessions,
  activeId,
  onResume,
  emptyText,
  icon,
}: {
  sessions: SessionSummary[];
  activeId?: string;
  onResume(id: string): void;
  emptyText: string;
  icon?: React.ReactNode;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = sessions
      .filter((s) => !q || (s.title || s.id).toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const out: Array<{ bucket: DateBucket; items: SessionSummary[] }> = [];
    for (const s of filtered) {
      const bucket = dateBucket(s.updatedAt);
      const last = out[out.length - 1];
      if (last && last.bucket === bucket) last.items.push(s);
      else out.push({ bucket, items: [s] });
    }
    return out;
  }, [sessions, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sessions.length > 6 && (
        <label className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5">
          <SearchIcon className="h-3.5 w-3.5 text-[var(--color-ink-faint)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search…")}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
          />
        </label>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {sessions.length === 0 && <div className="px-2 py-3 text-[12px] text-[var(--color-ink-faint)]">{emptyText}</div>}
        {groups.map((g) => (
          <div key={g.bucket} className="mb-2">
            <div className="cp-eyebrow px-2 pt-2 pb-1">{t(g.bucket)}</div>
            {g.items.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onResume(s.id)}
                title={`${s.title || s.id}\n${s.cwd}`}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                  s.id === activeId
                    ? "bg-[var(--color-surface-hover)] text-[var(--color-ink)]"
                    : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                }`}
              >
                <span className="shrink-0 text-[var(--color-ink-faint)]">{icon ?? <ChatIcon className="h-3.5 w-3.5" />}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.title || s.id}</span>
                <span className="shrink-0 text-[10.5px] text-[var(--color-ink-faint)]">{shortTime(s.updatedAt)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Nested sidebar: each workspace owns its session list underneath.
 * Default preview 5 sessions; "Show more" unlocks pages of up to 10.
 * Workspace order is stable — callers must not reorder on focus.
 */
export function WorkspaceSessionNav({
  workspaces,
  sessions,
  activeCwd,
  activeSessionId,
  connected,
  newLabel,
  emptyText,
  sessionIcon,
  onOpenWorkspace,
  onCloseWorkspace,
  onOpenNewWorkspace,
  onNewSession,
  onResumeSession,
  canFork,
  onFork,
  onRefresh,
}: {
  workspaces: string[];
  sessions: SessionSummary[];
  activeCwd?: string;
  activeSessionId?: string;
  connected: boolean;
  newLabel: string;
  emptyText: string;
  sessionIcon?: React.ReactNode;
  onOpenWorkspace(cwd: string): void;
  onCloseWorkspace(cwd: string): void;
  onOpenNewWorkspace(): void;
  onNewSession(): void;
  onResumeSession(id: string, cwd: string): void;
  canFork: boolean;
  onFork(): void;
  onRefresh(): void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pageByWs, setPageByWs] = useState<Record<string, number>>({});
  // Keep the search bar visible while typing — never gate it on filtered count
  // (that used to unmount the input as soon as matches dropped ≤ 6).
  const showSearch = sessions.length > 6 || query.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 pb-2 pt-1">
        <div className="cp-eyebrow flex-1">{t("Workspaces")}</div>
        <SessionActions canFork={canFork} canRefresh={connected} onFork={onFork} onRefresh={onRefresh} />
      </div>
      {showSearch && (
        <label className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5">
          <SearchIcon className="h-3.5 w-3.5 text-[var(--color-ink-faint)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search…")}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
          />
        </label>
      )}
      <div className="min-h-0 flex-1 space-y-1 overflow-auto px-2 pb-2">
        {workspaces.length === 0 && (
          <div className="px-2 py-2 text-[11.5px] text-[var(--color-ink-faint)]">{t("No workspace yet")}</div>
        )}
        {workspaces.map((ws) => {
          const active = sameCwd(ws, activeCwd);
          const name = ws.split("/").filter(Boolean).pop() ?? ws;
          const q = query.trim().toLowerCase();
          const wsSessions = sessions
            .filter((s) => sameCwd(s.cwd, ws))
            .filter((s) => !q || (s.title || s.id).toLowerCase().includes(q))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          const isExpanded = !!expanded[ws];
          const page = pageByWs[ws] ?? 0;
          const pageCount = Math.max(1, Math.ceil(wsSessions.length / SESSION_PAGE_SIZE));
          const safePage = Math.min(page, pageCount - 1);
          const visible = isExpanded
            ? wsSessions.slice(safePage * SESSION_PAGE_SIZE, safePage * SESSION_PAGE_SIZE + SESSION_PAGE_SIZE)
            : wsSessions.slice(0, DEFAULT_SESSION_PREVIEW);
          const hasMore = !isExpanded && wsSessions.length > DEFAULT_SESSION_PREVIEW;

          return (
            <div
              key={ws}
              className={`rounded-xl border px-1.5 py-1.5 ${
                active
                  ? "border-[var(--color-edge)] bg-[var(--color-surface-raised)]"
                  : "border-transparent"
              }`}
            >
              <div
                className={`group flex items-center gap-0.5 rounded-lg px-1 py-0.5 ${
                  active ? "text-[var(--color-ink)]" : "text-[var(--color-ink-dim)]"
                }`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-0.5 py-1 text-left"
                  title={ws}
                  onClick={() => onOpenWorkspace(ws)}
                  disabled={!connected}
                >
                  <FolderIcon className={`h-3.5 w-3.5 shrink-0 ${active ? "text-[var(--color-accent)]" : ""}`} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{name}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-ink-faint)]">
                    {wsSessions.length}
                  </span>
                </button>
                <button
                  type="button"
                  className="cp-icon-btn shrink-0 opacity-0 group-hover:opacity-100"
                  title={t("Close workspace")}
                  onClick={() => onCloseWorkspace(ws)}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>

              {active && (
                <div className="px-1 pb-1 pt-0.5">
                  <NewButton label={newLabel} onClick={onNewSession} disabled={!connected} />
                </div>
              )}

              <div className="space-y-0.5 pl-1">
                {wsSessions.length === 0 && (
                  <div className="px-2 py-1.5 text-[11px] text-[var(--color-ink-faint)]">{emptyText}</div>
                )}
                {visible.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onResumeSession(s.id, ws)}
                    title={`${s.title || s.id}\n${s.cwd}`}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      s.id === activeSessionId
                        ? "bg-[var(--color-surface-hover)] text-[var(--color-ink)]"
                        : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                    }`}
                  >
                    <span className="shrink-0 text-[var(--color-ink-faint)]">
                      {sessionIcon ?? <ChatIcon className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px]">{s.title || s.id}</span>
                    <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">{shortTime(s.updatedAt)}</span>
                  </button>
                ))}
              </div>

              {hasMore && (
                <button
                  type="button"
                  className="mt-0.5 flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-[11.5px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                  onClick={() => {
                    setExpanded((m) => ({ ...m, [ws]: true }));
                    setPageByWs((m) => ({ ...m, [ws]: 0 }));
                  }}
                >
                  <ChevronIcon open={false} className="h-3 w-3" />
                  {t("Show more")}
                  <span className="text-[var(--color-ink-faint)]">({wsSessions.length - DEFAULT_SESSION_PREVIEW})</span>
                </button>
              )}

              {isExpanded && wsSessions.length > DEFAULT_SESSION_PREVIEW && (
                <div className="mt-0.5 space-y-0.5 px-1 py-0.5">
                  {pageCount > 1 && (
                    <div className="flex items-center justify-between gap-1">
                      <button
                        type="button"
                        className="cp-btn-ghost py-0.5 text-[11px]"
                        disabled={safePage <= 0}
                        onClick={() => setPageByWs((m) => ({ ...m, [ws]: Math.max(0, safePage - 1) }))}
                      >
                        {t("Previous")}
                      </button>
                      <button
                        type="button"
                        className="cp-btn-ghost py-0.5 text-[11px]"
                        disabled={safePage >= pageCount - 1}
                        onClick={() =>
                          setPageByWs((m) => ({ ...m, [ws]: Math.min(pageCount - 1, safePage + 1) }))
                        }
                      >
                        {t("Next")}
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 rounded-lg px-1 py-1 text-left text-[11.5px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                    onClick={() => {
                      setExpanded((m) => ({ ...m, [ws]: false }));
                      setPageByWs((m) => ({ ...m, [ws]: 0 }));
                    }}
                  >
                    <ChevronIcon open className="h-3 w-3" />
                    {t("Show less")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
          onClick={onOpenNewWorkspace}
          disabled={!connected}
        >
          <PlusIcon className="h-3.5 w-3.5" />
          {t("Open workspace…")}
        </button>
      </div>
    </div>
  );
}

export function SessionActions({
  canFork,
  canRefresh,
  onFork,
  onRefresh,
}: {
  canFork: boolean;
  canRefresh: boolean;
  onFork(): void;
  onRefresh(): void;
}): React.ReactElement {
  return (
    <>
      <button type="button" className="cp-icon-btn" onClick={onFork} disabled={!canFork} title={t("Fork from here")}>
        <ForkIcon />
      </button>
      <button type="button" className="cp-icon-btn" onClick={onRefresh} disabled={!canRefresh} title={t("Refresh")}>
        <RefreshIcon />
      </button>
    </>
  );
}

export function NewButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] px-3 py-2 text-[12.5px] font-medium text-[var(--color-ink)] shadow-sm transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="cp-brand-gradient flex h-5 w-5 items-center justify-center rounded-md text-white">
        <PlusIcon className="h-3 w-3" />
      </span>
      {label}
    </button>
  );
}

function shortTime(ts: number): string {
  const d = new Date(ts);
  if (dateBucket(ts) === "Today") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

// ---------------------------------------------------------------- connect

export function ConnectScreen({
  state,
  defaultUrl,
  defaultToken,
  onConnect,
  topRight,
}: {
  state: AppState;
  defaultUrl: string;
  defaultToken: string;
  onConnect(o: { url: string; token: string }): void;
  topRight?: React.ReactNode;
}): React.ReactElement {
  const [url, setUrl] = useState(defaultUrl);
  const [token, setToken] = useState(defaultToken);
  const connecting = state.connection === "connecting";

  return (
    <div className="relative flex h-full items-center justify-center overflow-auto bg-[var(--color-bg)] p-6">
      <div className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(60%_50%_at_50%_0%,var(--color-accent-dim),transparent)]" />
      <div className="absolute top-3 right-3 flex items-center gap-2">{topRight}</div>
      <form
        className="relative w-full max-w-md animate-fade-in rounded-2xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface)] p-7 shadow-xl shadow-black/10"
        onSubmit={(e) => {
          e.preventDefault();
          onConnect({ url, token });
        }}
      >
        <div className="mb-6 flex items-center gap-3">
          <LogoMark size={40} />
          <div>
            <div className="text-[17px] font-semibold tracking-tight text-[var(--color-ink)]">{t("Connect to CodePilot")}</div>
            <ConnectionPill state={state} />
          </div>
        </div>
        <p className="mb-2 text-[12.5px] leading-5 text-[var(--color-ink-dim)]">
          {t("Run the command below, then paste the URL it prints. Open a workspace folder after connecting.")}
        </p>
        <code className="mb-5 block rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] px-3 py-2 font-mono text-[12px] text-[var(--color-ink)]">
          codepilot serve --web --web-root
        </code>
        <Field label={t("Server")} value={url} onChange={setUrl} placeholder="ws://127.0.0.1:18765/rpc" />
        <Field label={t("Token")} value={token} onChange={setToken} placeholder="from `codepilot serve --web`" secret />
        {state.connectionError && (
          <div className="mb-3 flex items-start gap-2 rounded-lg bg-[var(--color-remove-dim)] px-3 py-2 text-[12px] text-[var(--color-remove)]">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{state.connectionError}</span>
          </div>
        )}
        <button type="submit" disabled={connecting} className="cp-btn-primary w-full py-2 text-[13px]">
          {connecting ? t("Connecting…") : t("Connect")}
          {!connecting && <ArrowRightIcon className="h-3.5 w-3.5" />}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
  ariaLabel,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  secret?: boolean;
  ariaLabel?: string;
}): React.ReactElement {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11.5px] font-medium text-[var(--color-ink-dim)]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        type={secret ? "password" : "text"}
        spellCheck={false}
        className="cp-input w-full font-mono text-[12.5px]"
      />
    </label>
  );
}

// ---------------------------------------------------------------- scroll

/** Keeps a scroll container pinned to the bottom unless the user scrolled up. */
export function useStickyScroll(dep: unknown): (el: HTMLDivElement | null) => void {
 // A callback ref, because the container mounts later than the hook runs
 // (after the connect screen, after switching sessions).
  const elRef = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);

  const onScroll = useCallback(() => {
    const el = elRef.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current?.removeEventListener("scroll", onScroll);
      elRef.current = el;
      if (!el) return;
      el.addEventListener("scroll", onScroll);
      stuck.current = true;
      scrollToBottomSoon(el);
    },
    [onScroll],
  );

  useEffect(() => {
    const el = elRef.current;
    if (el && stuck.current) scrollToBottomSoon(el);
  }, [dep]);

  return setRef;
}

/**
 * Scroll an element to the bottom AFTER layout settles. A single synchronous
 * `scrollTop = scrollHeight` runs before the browser has laid out freshly
 * mounted content (markdown, code blocks, images) — so when a session loads a
 * long transcript at once, `scrollHeight` is still small and the view ends up
 * near the TOP. We re-pin across a few animation frames (and a short timeout)
 * so late-growing content is accounted for and the transcript opens at the
 * newest message.
 */
function scrollToBottomSoon(el: HTMLDivElement): void {
  const pin = (): void => {
    el.scrollTop = el.scrollHeight;
  };
  pin();
  requestAnimationFrame(() => {
    pin();
    requestAnimationFrame(pin);
  });
 // Catch content that grows after a tick (image decode, async markdown).
  setTimeout(pin, 60);
  setTimeout(pin, 200);
}
