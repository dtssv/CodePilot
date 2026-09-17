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

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-edge)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs">
      <Field
        label="server"
        value={url}
        onChange={setUrl}
        placeholder="ws://127.0.0.1:4179/rpc"
        width="w-72"
      />
      <Field
        label="token"
        value={token}
        onChange={setToken}
        placeholder="from `codepilot serve --web`"
        width="w-56"
        secret
      />
      <Field label="cwd" value={cwd} onChange={setCwd} placeholder="/path/to/repo" width="w-64" />
      {state.connection === "connected" ? (
        <button
          type="button"
          onClick={onDisconnect}
          className="rounded-md border border-[var(--color-edge)] px-2.5 py-1 hover:bg-[var(--color-surface-sunken)]"
        >
          Disconnect
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onConnect({ url, token, cwd })}
          disabled={state.connection === "connecting"}
          className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 font-medium text-black disabled:opacity-50"
        >
          {state.connection === "connecting" ? "Connecting…" : "Connect"}
        </button>
      )}
      <ConnectionDot state={state} />
      {state.connectionError && (
        <span className="text-[var(--color-remove)]">{state.connectionError}</span>
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
      <span className="text-[var(--color-ink-dim)]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={secret ? "password" : "text"}
        spellCheck={false}
        className={`${width} rounded-md border border-[var(--color-edge)] bg-[var(--color-surface-sunken)] px-2 py-1 font-mono outline-none focus:border-[var(--color-accent)]`}
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
  return (
    <span className="flex items-center gap-1.5 text-[var(--color-ink-dim)]">
      <span className={`h-2 w-2 rounded-full ${tone}`} />
      {state.connection}
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
    <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-edge)] px-3 py-1.5 text-[11px] text-[var(--color-ink-dim)]">
      <span>{STATUS_LABEL[state.status]}</span>
      <div className="flex gap-1">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onSetMode(m)}
            disabled={!state.sessionId}
            className={`rounded px-1.5 py-0.5 ${
              state.agentMode === m
                ? "bg-[var(--color-accent)]/20 text-[var(--color-ink)]"
                : "hover:bg-[var(--color-surface-sunken)]"
            } disabled:opacity-40`}
          >
            {m}
          </button>
        ))}
      </div>
      {state.model && <span className="font-mono">{state.model}</span>}
      <span>
        {state.usage.input} in / {state.usage.output} out
        {state.usage.costUSD !== undefined ? ` · $${state.usage.costUSD.toFixed(4)}` : ""}
      </span>
      {state.status === "thinking" && (
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-[var(--color-edge)] px-1.5 py-0.5 hover:bg-[var(--color-surface-sunken)]"
        >
          cancel
        </button>
      )}
      {state.notice && <span className="ml-auto">{state.notice}</span>}
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
    <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-edge)] bg-[var(--color-surface-sunken)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--color-edge)] px-3 py-2 text-xs">
        <button
          type="button"
          onClick={onNew}
          disabled={state.connection !== "connected"}
          className="rounded-md bg-[var(--color-accent)] px-2 py-1 font-medium text-black disabled:opacity-40"
        >
          New
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={state.connection !== "connected"}
          className="rounded-md border border-[var(--color-edge)] px-2 py-1 disabled:opacity-40"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={onFork}
          disabled={!state.sessionId}
          className="rounded-md border border-[var(--color-edge)] px-2 py-1 disabled:opacity-40"
          title="Branch a new session from this transcript"
        >
          Fork
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {sessions.length === 0 && (
          <div className="px-3 py-2 text-xs text-[var(--color-ink-dim)]">
            No saved sessions yet.
          </div>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onResume(s.id)}
            className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--color-surface-raised)] ${
              s.id === state.sessionId ? "bg-[var(--color-surface-raised)]" : ""
            }`}
          >
            <div className="truncate text-[var(--color-ink)]">{s.title || s.id}</div>
            <div className="truncate text-[10px] text-[var(--color-ink-dim)]">
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
    <div className="flex items-end gap-2 border-t border-[var(--color-edge)] p-3">
      <textarea
        ref={ref}
        value={text}
        rows={Math.min(8, Math.max(1, text.split("\n").length))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={
          disabled ? "Connect and open a session to start" : "Ask CodePilot… (⏎ to send, ⇧⏎ newline)"
        }
        disabled={disabled}
        className="min-h-9 flex-1 resize-none rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface-sunken)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
      />
      <button
        type="button"
        onClick={send}
        disabled={disabled || text.trim() === ""}
        className="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-black disabled:opacity-40"
      >
        Send
      </button>
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
