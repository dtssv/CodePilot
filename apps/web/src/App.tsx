import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import type { AgentMode, PermissionDecision, QuestionAnswers } from "@codepilot/core";

import {
  CodepilotClient,
  describeError,
  parseServeUrl,
  type PendingPermission,
  type PendingQuestion,
} from "./protocol/client.js";
import { initialState, reducer } from "./state/reducer.js";
import type { Row } from "./state/rows.js";
import { RowView } from "./components/Rows.js";
import { PermissionDialog, QuestionDialog } from "./components/Dialogs.js";
import {
  Composer,
  ConnectBar,
  SessionPanel,
  StatusBar,
  useStickyScroll,
} from "./components/Shell.js";
import { loadPrefs, savePrefs } from "./prefs.js";
import { WorkspacePanel } from "./components/WorkspacePanel.js";

export function App(): React.ReactElement {
  const prefs = useMemo(loadPrefs, []);
  const [state, dispatch] = useReducer(reducer, initialState(prefs.cwd));

  // The client outlives renders and must not be recreated by them: it owns a
  // socket. Callbacks only dispatch, so a single instance is enough.
  // Mirrors of dispatch-only state that callbacks need synchronously (a
  // reconnect fires from inside the client, before React re-renders).
  const sessionRef = useRef<string | undefined>(undefined);
  const modeRef = useRef<AgentMode>("agent");

  const resumeCurrentRef = useRef<() => Promise<void>>(async () => {});

  const clientRef = useRef<CodepilotClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new CodepilotClient({
      onEvent: (_sessionId, event) => dispatch({ type: "event", event }),
      onPermission: (req: PendingPermission) => dispatch({ type: "permission", req }),
      onQuestion: (req: PendingQuestion) => dispatch({ type: "question", req }),
      onClose: (reason) =>
        dispatch({ type: "disconnected", error: reason ?? "connection closed by the server" }),
      onReconnecting: (attempt) => dispatch({ type: "reconnecting", attempt }),
      onReconnected: () => {
        dispatch({ type: "reconnected" });
        void resumeCurrentRef.current();
      },
    });
  }
  const client = clientRef.current;

  useEffect(() => () => void client.disconnect(), [client]);

  // Auto-reconnect on page load when a valid token was persisted.
  const didAutoConnect = useRef(false);
  useEffect(() => {
    if (didAutoConnect.current) return;
    didAutoConnect.current = true;
    if (prefs.url && prefs.token) {
      void connect({ url: prefs.url, token: prefs.token, cwd: prefs.cwd });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const sessions = await client.listSessions();
      dispatch({ type: "sessions", sessions });
    } catch (err) {
      dispatch({ type: "notice", text: describeError(err) });
    }
  }, [client]);

  const connect = useCallback(
    async ({ url, token, cwd }: { url: string; token: string; cwd: string }) => {
      // Accept a pasted `ws://…?token=…` line in the URL field.
      const parsed = parseServeUrl(url);
      const effectiveToken = parsed.token ?? token;
      dispatch({ type: "connecting" });
      try {
        const init = await client.connect({
          url: parsed.url,
          token: effectiveToken || undefined,
          cwd,
        });
        dispatch({ type: "connected", cwd, modes: init.capabilities.modes });
        savePrefs({ url: parsed.url, token: effectiveToken, cwd });
        await refreshSessions();
      } catch (err) {
        dispatch({ type: "disconnected", error: describeError(err) });
      }
    },
    [client, refreshSessions],
  );

  const disconnect = useCallback(async () => {
    await client.disconnect();
    dispatch({ type: "disconnected" });
  }, [client]);

  const newSession = useCallback(async () => {
    try {
      const sessionId = await client.newSession({
        cwd: state.cwd,
        agentMode: state.agentMode,
      });
      sessionRef.current = sessionId;
      modeRef.current = state.agentMode;
      dispatch({ type: "session-opened", sessionId, agentMode: state.agentMode });
      await refreshSessions();
    } catch (err) {
      dispatch({ type: "notice", text: describeError(err) });
    }
  }, [client, refreshSessions, state.agentMode, state.cwd]);

  const resumeSession = useCallback(
    async (id: string) => {
      try {
        const { sessionId, events } = await client.resumeSession(id);
        sessionRef.current = sessionId;
        modeRef.current = state.agentMode;
        dispatch({
          type: "session-opened",
          sessionId,
          agentMode: state.agentMode,
          history: events,
        });
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
      }
    },
    [client, state.agentMode],
  );

  // Keep refs in sync so the reconnect callback can resume without stale
  // closures.
  sessionRef.current = state.sessionId;
  modeRef.current = state.agentMode;
  resumeCurrentRef.current = async () => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      const { sessionId, events } = await client.resumeSession(id);
      dispatch({
        type: "session-opened",
        sessionId,
        agentMode: modeRef.current,
        history: events,
      });
      dispatch({ type: "notice", text: "reconnected — session restored" });
    } catch (err) {
      sessionRef.current = undefined;
      dispatch({ type: "session-opened", sessionId: "", agentMode: modeRef.current });
      dispatch({ type: "notice", text: describeError(err) });
    }
    try {
      const sessions = await client.listSessions();
      dispatch({ type: "sessions", sessions });
    } catch { /* listed on demand */ }
  };

  const forkSession = useCallback(async () => {
    if (!state.sessionId) return;
    try {
      const forked = await client.fork(state.sessionId);
      const { sessionId, events } = await client.resumeSession(forked);
      dispatch({
        type: "session-opened",
        sessionId,
        agentMode: state.agentMode,
        history: events,
      });
      dispatch({ type: "notice", text: `forked → ${sessionId}` });
      await refreshSessions();
    } catch (err) {
      dispatch({ type: "notice", text: describeError(err) });
    }
  }, [client, refreshSessions, state.agentMode, state.sessionId]);

  const send = useCallback(
    async (text: string) => {
      if (!state.sessionId) return;
      dispatch({ type: "sending" });
      try {
        await client.send(state.sessionId, text);
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
      }
    },
    [client, state.sessionId],
  );

  const cancel = useCallback(async () => {
    if (!state.sessionId) return;
    await client.cancel(state.sessionId).catch(() => {});
  }, [client, state.sessionId]);

  const setMode = useCallback(
    async (mode: AgentMode) => {
      if (!state.sessionId) return;
      try {
        await client.setMode(state.sessionId, mode);
        // The server also emits a `mode` event; setting it here keeps the
        // buttons responsive if that event is slow.
        dispatch({ type: "agent-mode", mode });
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
      }
    },
    [client, state.sessionId],
  );

  const decidePermission = useCallback(
    async (decision: PermissionDecision) => {
      const req = state.permission;
      if (!req) return;
      dispatch({ type: "permission-resolved" });
      try {
        await client.respondPermission(req.requestId, decision);
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
      }
    },
    [client, state.permission],
  );

  const answerQuestion = useCallback(
    async (answers: QuestionAnswers) => {
      const req = state.question;
      if (!req) return;
      dispatch({ type: "question-resolved" });
      try {
        await client.respondQuestion(req.requestId, answers);
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
      }
    },
    [client, state.question],
  );

  const scrollRef = useStickyScroll(state.rows.length);
  const composerDisabled =
    state.connection !== "connected" || !state.sessionId || state.status !== "idle";

  return (
    <div className="flex h-full flex-col bg-[var(--color-surface)]">
      <ConnectBar
        state={state}
        defaultUrl={prefs.url}
        defaultToken={prefs.token}
        defaultCwd={prefs.cwd}
        onConnect={(o) => void connect(o)}
        onDisconnect={() => void disconnect()}
      />

      <div className="flex min-h-0 flex-1">
        <SessionPanel
          state={state}
          sessions={state.sessions}
          onNew={() => void newSession()}
          onResume={(id) => void resumeSession(id)}
          onRefresh={() => void refreshSessions()}
          onFork={() => void forkSession()}
        />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
            <div className="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-4">
              {state.rows.length === 0 && (
                <EmptyState connected={state.connection === "connected"} />
              )}
              {state.rows.map((row, i) => (
                <RowView key={rowKey(row, i)} row={row} />
              ))}
            </div>
          </div>
          <Composer disabled={composerDisabled} onSend={(t) => void send(t)} />
          <StatusBar
            state={state}
            modes={client.modes}
            onSetMode={(m) => void setMode(m)}
            onCancel={() => void cancel()}
          />
        </main>
        {state.connection === "connected" && <WorkspacePanel client={client} cwd={state.cwd} connected={state.connection === "connected"} rows={state.rows} />}
      </div>

      {state.permission && (
        <PermissionDialog
          req={state.permission}
          onDecide={(d) => void decidePermission(d)}
        />
      )}
      {state.question && (
        <QuestionDialog req={state.question} onAnswer={(a) => void answerQuestion(a)} />
      )}
    </div>
  );
}

function EmptyState({ connected }: { connected: boolean }): React.ReactElement {
  return (
    <div className="mt-20 flex flex-col items-center gap-3 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-surface-raised)] text-lg font-bold text-[var(--color-accent)]">
        CP
      </div>
      {connected ? (
        <div className="text-sm text-[var(--color-ink-dim)]">
          Connected. Start a <span className="font-medium text-[var(--color-ink)]">New</span> session
          or resume one from the sidebar.
        </div>
      ) : (
        <div className="text-sm text-[var(--color-ink-dim)]">
          Run <code className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[var(--color-ink)]">codepilot serve --web</code> and
          <br />
          paste the URL it prints above.
        </div>
      )}
    </div>
  );
}

/** Stable-enough keys: rows are append-only except for in-place updates. */
function rowKey(row: Row, i: number): string {
  return `${row.kind}-${row.at}-${i}`;
}
