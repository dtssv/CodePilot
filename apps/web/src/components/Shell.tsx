import { useEffect, useRef, useState } from "react";

import type { AgentMode, SessionSummary } from "@codepilot/core";
import type { AppState, UiStatus } from "../state/reducer.js";

/** Connection form. Accepts the whole URL the CLI prints, token included. */
export function ConnectBar({
  state,
  defaultUrl,
  defaultToken,
  defaultCwd,
  onConnect,
  onDisconnect,
}: {
  state: AppState;
  defaultUrl: string;
  defaultToken: string;
  defaultCwd: string;
  onConnect: (opts: { url: string; token: string; cwd: string }) => void;
  onDisconnect: () => void;
}): React.ReactElement {
  const [url, setUrl] = useState(defaultUrl);
  const [token, setToken] = useState(defaultToken);
  const [cwd, setCwd] = useState(defaultCwd);
  const connected = state.connection === "connected";

  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] px-4 py-2.5">
      <div className="flex items-center gap-2 pr-3">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--color-accent)] text-xs font-bold text-black">CP</div>
        <span className="text-sm font-semibold text-[var(--color-ink)]">CodePilot</span>
      </div>
      {connected ? (
        <>
          <ConnectionDot state={state} />
          <span className="truncate font-mono text-xs text-[var(--color-ink-dim)]">{defaultCwd || cwd}</span>
          <button
            type="button"
            onClick={onDisconnect}
            className="ml-auto rounded-md border border-[var(--color-edge)] px-2.5 py-1 text-xs text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
          >
            Disconnect
          </button>
        </>
      ) : (
        <>
          <Field label="server" value={url} onChange={setUrl} placeholder="ws://127.0.0.1:4179/rpc" width="w-64" />
          <Field label="token" value={token} onChange={setToken} placeholder="from `codepilot serve --web`" width="w-48" secret />
          <Field label="cwd" value={cwd} onChange={setCwd} placeholder="/path/to/repo" width="w-56" />
          <button
            type="button"
            onClick={() => onConnect({ url, token, cwd })}
            disabled={state.connection === "connecting"}
            className="ml-auto rounded-md bg-[var(--color-accent)] px-3.5 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {state.connection === "connecting" ? "Connecting…" : "Connect"}
          </button>
        </>
      )}
      {state.connectionError && (
        <span className="text-xs text-[var(--color-remove)]">{state.connectionError}</span>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  width,
  secret,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width: string;
  secret?: boolean;
}): React.ReactElement {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={secret ? "password" : "text"}
        spellCheck={false}
        className={`${width} rounded-md border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] px-2.5 py-1 font-mono text-xs text-[var(--color-ink)] outline-none transition-colors focus:border-[var(--color-accent)]`}
      />
    </label>
  );
}

function ConnectionDot({ state }: { state: AppState }): React.ReactElement {
  const tone =
    state.connection === "connected"
      ? "bg-[var(--color-add)]"
      : state.connection === "connecting"
        ? "bg-[var(--color-accent)] animate-pulse"
        : "bg-[var(--color-edge)]";
  const label =
    state.connection === "connecting" && state.reconnectAttempt !== undefined
      ? `reconnecting (${state.reconnectAttempt})`
      : state.connection;
  return (
    <span className="flex items-center gap-1.5 text-xs text-[var(--color-ink-dim)]">
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      {label}
    </span>
  );
}

const STATUS_LABEL: Record<UiStatus, string> = {
  idle: "idle",
  thinking: "working…",
  waiting_permission: "waiting for approval",
  waiting_question: "waiting for your answer",
  compacting: "compacting context",
};

export function StatusBar({
  state,
  modes,
  onSetMode,
  onCancel,
}: {
  state: AppState;
  modes: AgentMode[];
  onSetMode: (mode: AgentMode) => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3 border-t border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] px-4 py-2 text-[11px] text-[var(--color-ink-dim)]">
      <span className="flex items-center gap-1.5">
        {state.status === "thinking" && (
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
        )}
        {STATUS_LABEL[state.status]}
      </span>
      {modes.length > 1 && (
        <div className="flex gap-0.5 rounded-md bg-[var(--color-surface-sunken)] p-0.5">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onSetMode(m)}
              disabled={!state.sessionId}
              className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                state.agentMode === m
                  ? "bg-[var(--color-accent-dim)] text-[var(--color-ink)]"
                  : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
              } disabled:opacity-40`}
            >
              {m}
            </button>
          ))}
        </div>
      )}
      {state.model && <span className="font-mono text-[var(--color-ink-faint)]">{state.model}</span>}
      {state.usage.input > 0 && (
        <span className="text-[var(--color-ink-faint)]">
          {state.usage.input} in / {state.usage.output} out
          {state.usage.costUSD !== undefined ? ` · $${state.usage.costUSD.toFixed(4)}` : ""}
        </span>
      )}
      {state.status === "thinking" && (
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--color-edge)] px-2 py-0.5 text-[var(--color-remove)] transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          cancel
        </button>
      )}
      {state.notice && <span className="ml-auto text-[var(--color-ink-faint)]">{state.notice}</span>}
    </div>
  );
}

/** Session list + the actions that create or switch sessions. */
export function SessionPanel({
  state,
  sessions,
  onNew,
  onResume,
  onRefresh,
  onFork,
}: {
  state: AppState;
  sessions: SessionSummary[];
  onNew: () => void;
  onResume: (id: string) => void;
  onRefresh: () => void;
  onFork: () => void;
}): React.ReactElement {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)]">
      <div className="flex items-center gap-1 border-b border-[var(--color-edge-subtle)] px-3 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">Sessions</span>
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            onClick={onNew}
            disabled={state.connection !== "connected"}
            className="rounded-md bg-[var(--color-accent)] px-2 py-1 text-[11px] font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            + New
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={state.connection !== "connected"}
            className="rounded-md border border-[var(--color-edge-subtle)] px-1.5 py-1 text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)] disabled:opacity-40"
            title="Refresh session list"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={onFork}
            disabled={!state.sessionId}
            className="rounded-md border border-[var(--color-edge-subtle)] px-1.5 py-1 text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)] disabled:opacity-40"
            title="Branch a new session from this transcript"
          >
            ⎇
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {sessions.length === 0 && (
          <div className="px-3 py-3 text-xs text-[var(--color-ink-faint)]">
            No saved sessions yet.
          </div>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onResume(s.id)}
            className={`block w-full border-l-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-raised)] ${
              s.id === state.sessionId
                ? "border-[var(--color-accent)] bg-[var(--color-surface-raised)]"
                : "border-transparent"
            }`}
          >
            <div className="truncate text-xs font-medium text-[var(--color-ink)]">{s.title || s.id}</div>
            <div className="truncate text-[10px] text-[var(--color-ink-faint)]">
              {new Date(s.updatedAt).toLocaleString()} · {s.cwd}
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

/** Prompt input. Enter sends, Shift+Enter makes a newline. */
export function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
}): React.ReactElement {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed === "" || disabled) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="border-t border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] p-3">
      <div className="flex items-end gap-2 rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] p-2 transition-colors focus-within:border-[var(--color-accent)]">
        <textarea
          ref={ref}
          value={text}
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            disabled ? "Connect and open a session to start…" : "Ask CodePilot…  (⏎ to send, ⇧⏎ for newline)"
          }
          disabled={disabled}
          className="max-h-48 min-h-6 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)] disabled:opacity-50"
        />
        <button
          type="button"
          onClick={send}
          disabled={disabled || text.trim() === ""}
          className="shrink-0 rounded-lg bg-[var(--color-accent)] px-3.5 py-1.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/** Keeps the transcript pinned to the bottom unless the user scrolled up. */
export function useStickyScroll(dep: unknown): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = (): void => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [dep]);

  return ref;
}
