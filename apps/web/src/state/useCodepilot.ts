// The one place that owns the protocol client and turns UI intents into
// protocol calls. Every layout (web, agent, embedded) renders from the same
// `state` and calls the same actions, so behaviour cannot drift between them.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { AgentMode, ImageAttachment, PermissionDecision, PromptFile, QuestionAnswers } from "@codepilot/core";

import {
  CodepilotClient,
  describeError,
  parseServeUrl,
  type PendingPermission,
  type PendingQuestion,
} from "../protocol/client.js";
import { bridgeOpener, type HostBridge } from "../protocol/bridge.js";
import {
  addWorkspace,
  loadPrefs,
  removeWorkspace,
  matchPreferredEndpoint,
  saveEndpointPref,
  savePrefs,
} from "../prefs.js";
import { initialState, reducer, type AppState } from "./reducer.js";
import { lastUserPrompt } from "./selectors.js";

export interface WsTarget {
  url: string;
  token: string;
 /** Optional; omit/empty to leave the server on its process cwd until a folder is opened. */
  cwd?: string;
}

export interface Codepilot {
  state: AppState;
  client: CodepilotClient;
 /** Open workspaces remembered in this browser (sessions are scoped per cwd). */
  workspaces: string[];
  connect(target: WsTarget): Promise<void>;
  connectHost(bridge: HostBridge, cwd: string, clientName: string): Promise<void>;
  disconnect(): Promise<void>;
 /** Focus an already-open workspace (or open it) without dropping the socket. */
  changeCwd(cwd: string): Promise<void>;
 /** Add/focus a workspace folder and bind subsequent sessions to it. */
  openWorkspace(cwd: string): Promise<void>;
 /** Remove a workspace from the open list (does not delete sessions on disk). */
  closeWorkspace(cwd: string): Promise<void>;
  newSession(mode?: AgentMode): Promise<string | undefined>;
  resumeSession(id: string): Promise<void>;
  forkSession(): Promise<void>;
  refreshSessions(): Promise<void>;
  send(
    text: string,
    images?: ImageAttachment[],
    files?: PromptFile[],
    delivery?: "auto" | "queue" | "steer",
  ): Promise<void>;
  removeFollowUp(id: string): Promise<void>;
  sendFollowUpNow(id: string): Promise<void>;
 /** Fresh session in `mode`, then send — the agent app's "new task". */
  startTask(text: string, mode?: AgentMode, images?: ImageAttachment[], files?: PromptFile[]): Promise<void>;
 /** Resend the last user prompt (after an error). */
  retryLast(): Promise<void>;
  cancel(): Promise<void>;
  setMode(mode: AgentMode): Promise<void>;
 /** Switch model (and optionally provider preset) for the current session. */
  setModel(model: string, providerId?: string): Promise<void>;
  decidePermission(decision: PermissionDecision): Promise<void>;
  answerQuestion(answers: QuestionAnswers): Promise<void>;
  notify(text?: string): void;
 /** Leave the current session and show the home/empty screen. */
  closeSession(): void;
}

export function useCodepilot(): Codepilot {
  const prefs = useMemo(loadPrefs, []);
  const [state, dispatch] = useReducer(reducer, initialState(prefs.cwd));
  const [workspaces, setWorkspaces] = useState<string[]>(prefs.workspaces);

 // Mirrors of state the client callbacks need synchronously (a reconnect
 // fires from inside the client, before React re-renders).
  const live = useRef(state);
  live.current = state;
  const lastWs = useRef<WsTarget | null>(null);

  const clientRef = useRef<CodepilotClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new CodepilotClient({
      onEvent: (sessionId, event) => {
 // Background sessions (another tab, a sub-run) must not bleed into
 // the transcript on screen.
        const current = live.current.sessionId;
        if (current && sessionId && sessionId !== current) return;
        dispatch({ type: "event", event });
      },
      onPermission: (req: PendingPermission) => dispatch({ type: "permission", req }),
      onQuestion: (req: PendingQuestion) => dispatch({ type: "question", req }),
      onPromptResolved: (kind: "permission" | "question", requestId: string) =>
        dispatch({ type: kind === "permission" ? "permission-resolved" : "question-resolved", requestId }),
      onClose: (reason) =>
        dispatch({ type: "disconnected", error: reason ?? "connection closed by the server" }),
      onReconnecting: (attempt) => dispatch({ type: "reconnecting", attempt }),
      onReconnected: () => {
        dispatch({ type: "reconnected" });
        void resumeCurrent();
      },
    });
  }
  const client = clientRef.current;

  useEffect(() => () => void client.disconnect(), [client]);

  const refreshSessions = useCallback(async () => {
    try {
      dispatch({ type: "sessions", sessions: await client.listSessions() });
    } catch (err) {
      dispatch({ type: "notice", text: describeError(err) });
    }
  }, [client]);

  async function resumeCurrent(): Promise<void> {
    const id = live.current.sessionId;
    if (id) {
      try {
        const { sessionId, events } = await client.resumeSession(id);
        dispatch({ type: "session-opened", sessionId, agentMode: live.current.agentMode, history: events });
        dispatch({ type: "notice", text: "reconnected — session restored" });
      } catch (err) {
        dispatch({ type: "session-opened", sessionId: "", agentMode: live.current.agentMode });
        dispatch({ type: "notice", text: describeError(err) });
      }
    }
    try {
      dispatch({ type: "sessions", sessions: await client.listSessions() });
    } catch {
 /* listed on demand */
    }
  }

  const connect = useCallback(
    async ({ url, token, cwd }: WsTarget) => {
 // Accept a pasted `ws://…?token=…` line in the URL field.
      const parsed = parseServeUrl(url);
      const effectiveToken = parsed.token ?? token;
      const effectiveCwd = (cwd ?? "").trim();
      dispatch({ type: "connecting" });
      try {
        const init = await client.connect({
          url: parsed.url,
          token: effectiveToken || undefined,
          cwd: effectiveCwd || undefined,
        });
        lastWs.current = { url: parsed.url, token: effectiveToken, cwd: effectiveCwd };
        dispatch({ type: "connected", cwd: effectiveCwd, modes: init.capabilities.modes });
        const ws = effectiveCwd ? addWorkspace(effectiveCwd) : loadPrefs().workspaces;
        setWorkspaces(ws);
        savePrefs({
          url: parsed.url,
          token: effectiveToken,
          cwd: effectiveCwd,
          workspaces: ws,
        });
        await refreshSessions();
      } catch (err) {
        dispatch({ type: "disconnected", error: describeError(err) });
      }
    },
    [client, refreshSessions],
  );

  const connectHost = useCallback(
    async (bridge: HostBridge, cwd: string, clientName: string) => {
      dispatch({ type: "connecting" });
      try {
        const init = await client.connectTransport(bridgeOpener(bridge), { cwd, clientName });
        dispatch({ type: "connected", cwd, modes: init.capabilities.modes });
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

  const applyPreferredModel = useCallback(
    async (cwd: string) => {
      try {
        const snap = await client.getConfig(cwd);
 // Match prefs against every selectable row (chat + small); fall back
 // to the first chat model so we don't land on a tiny-only id.
        const all = snap.selectableModels.map((m) => ({
          providerId: m.providerId,
          model: m.model,
        }));
        const chat = snap.selectableModels
          .filter((m) => m.kind === "chat")
          .map((m) => ({ providerId: m.providerId, model: m.model }));
        const matched = matchPreferredEndpoint(cwd, all);
        const pref =
          matched ??
          (chat[0]
            ? { providerId: chat[0].providerId, model: chat[0].model }
            : all[0]
              ? { providerId: all[0].providerId, model: all[0].model }
              : undefined);
        if (!pref) return;
 // Only rewrite storage when we restored a remembered pick — never
 // overwrite a saved model with the "first in list" fallback.
        if (matched) saveEndpointPref(cwd, matched);
        dispatch({ type: "endpoint", model: pref.model, providerId: pref.providerId });
        live.current = {
          ...live.current,
          model: pref.model,
          providerId: pref.providerId,
        };
      } catch {
 /* optional */
      }
    },
    [client],
  );

  const openWorkspace = useCallback(
    async (raw: string) => {
      const cwd = raw.trim().replace(/\/+$/, "") || raw.trim();
      if (!cwd) return;
      try {
        await client.setActiveCwd(cwd);
        const ws = addWorkspace(cwd);
        setWorkspaces(ws);
        if (lastWs.current) {
          lastWs.current = { ...lastWs.current, cwd };
          savePrefs({
            url: lastWs.current.url,
            token: lastWs.current.token,
            cwd,
            workspaces: ws,
          });
        }
 // Leave the previous workspace's transcript; sessions are cwd-bound.
 // Clear any stale model (e.g. hardcoded session default) before restore.
        if (live.current.cwd !== cwd || live.current.sessionId) {
          dispatch({ type: "session-closed" });
        }
        dispatch({ type: "set-cwd", cwd });
        live.current = {
          ...live.current,
          cwd,
          sessionId: undefined,
          model: undefined,
          providerId: undefined,
        };
        await refreshSessions();
        await applyPreferredModel(cwd);
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
      }
    },
    [client, refreshSessions, applyPreferredModel],
  );

  const changeCwd = useCallback(
    async (cwd: string) => {
      await openWorkspace(cwd);
    },
    [openWorkspace],
  );

  const closeWorkspace = useCallback(
    async (cwd: string) => {
      const next = removeWorkspace(cwd);
      setWorkspaces(next);
      if (live.current.cwd === cwd) {
        const fallback = next[0];
        if (fallback) await openWorkspace(fallback);
        else {
          dispatch({ type: "session-closed" });
          dispatch({ type: "set-cwd", cwd: "" });
          live.current = { ...live.current, cwd: "", sessionId: undefined };
          if (lastWs.current) {
            lastWs.current = { ...lastWs.current, cwd: "" };
            savePrefs({
              url: lastWs.current.url,
              token: lastWs.current.token,
              cwd: "",
              workspaces: next,
            });
          }
        }
      }
    },
    [openWorkspace],
  );

  const syncEndpoint = useCallback(
    async (sessionId: string) => {
      try {
        const ep = await client.getEndpoint(sessionId);
        const providerId = ep.providerId ?? live.current.providerId ?? "_active";
        dispatch({ type: "endpoint", model: ep.model, providerId });
        live.current = { ...live.current, model: ep.model, providerId };
        if (live.current.cwd && ep.model) {
          saveEndpointPref(live.current.cwd, { model: ep.model, providerId });
        }
      } catch {
 /* endpoint optional on older servers */
      }
    },
    [client],
  );

  const newSession = useCallback(
    async (mode?: AgentMode) => {
      const cwd = live.current.cwd;
      if (!cwd) {
        dispatch({ type: "notice", text: "Open a workspace folder first" });
        return undefined;
      }
      const agentMode = mode ?? live.current.agentMode;
      try {
 // Keep the model already shown in the picker; only fill from prefs
 // when nothing is selected yet (do not clobber a manual pick).
        let model = live.current.model;
        let providerId = live.current.providerId;
        if (!model) {
          await applyPreferredModel(cwd);
          model = live.current.model;
          providerId = live.current.providerId;
        }
        const sessionId = await client.newSession({
          cwd,
          agentMode,
          model: model || undefined,
        });
        live.current = { ...live.current, sessionId, agentMode };
        dispatch({ type: "session-opened", sessionId, agentMode });
        if (model && providerId) {
          try {
            const result = await client.setModel(sessionId, model, providerId);
            const next = {
              model: result.model,
              providerId: result.providerId ?? providerId,
            };
            dispatch({ type: "endpoint", ...next });
            live.current = { ...live.current, ...next };
            saveEndpointPref(cwd, next);
          } catch {
            void syncEndpoint(sessionId);
          }
        } else {
          void syncEndpoint(sessionId);
        }
        void refreshSessions();
        return sessionId;
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
        return undefined;
      }
    },
    [client, refreshSessions, syncEndpoint, applyPreferredModel],
  );

  const resumeSession = useCallback(
    async (id: string) => {
      try {
 // Do not switch workspace on resume — cwd is fixed until the user
 // explicitly opens/changes the folder.
        const { sessionId, events } = await client.resumeSession(id);
        live.current = { ...live.current, sessionId };
        dispatch({ type: "session-opened", sessionId, agentMode: live.current.agentMode, history: events });
        void syncEndpoint(sessionId);
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
      }
    },
    [client, syncEndpoint],
  );

  const forkSession = useCallback(async () => {
    const id = live.current.sessionId;
    if (!id) return;
    try {
      const forked = await client.fork(id);
      const { sessionId, events } = await client.resumeSession(forked);
      live.current = { ...live.current, sessionId };
      dispatch({ type: "session-opened", sessionId, agentMode: live.current.agentMode, history: events });
      dispatch({ type: "notice", text: `forked → ${sessionId}` });
      await refreshSessions();
    } catch (err) {
      dispatch({ type: "notice", text: describeError(err) });
    }
  }, [client, refreshSessions]);

  const sendTo = useCallback(
    async (
      sessionId: string,
      text: string,
      images?: ImageAttachment[],
      files?: PromptFile[],
      delivery?: "auto" | "queue" | "steer",
    ) => {
      dispatch({ type: "sending" });
      try {
        const res = await client.send(sessionId, text, images, files, delivery);
        if (res?.delivery === "steered") {
          dispatch({ type: "notice", text: "Injected into the current run" });
        }
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
        dispatch({ type: "event", event: { type: "status", status: "idle" } });
      }
    },
    [client],
  );

  const send = useCallback(
    async (
      text: string,
      images?: ImageAttachment[],
      files?: PromptFile[],
      delivery?: "auto" | "queue" | "steer",
    ) => {
      const id = live.current.sessionId ?? (await newSession());
      if (!id) return;
      await sendTo(id, text, images, files, delivery);
      void refreshSessions();
    },
    [newSession, sendTo, refreshSessions],
  );

  const removeFollowUp = useCallback(
    async (followUpId: string) => {
      const id = live.current.sessionId;
      if (!id) return;
      await client.removeFollowUp(id, followUpId).catch(() => {});
    },
    [client],
  );

  const sendFollowUpNow = useCallback(
    async (followUpId: string) => {
      const id = live.current.sessionId;
      if (!id) return;
      await client.sendFollowUpNow(id, followUpId).catch(() => {});
    },
    [client],
  );

  const startTask = useCallback(
    async (text: string, mode: AgentMode = "agent", images?: ImageAttachment[], files?: PromptFile[]) => {
      const id = await newSession(mode);
      if (!id) return;
      await sendTo(id, text, images, files);
      void refreshSessions();
    },
    [newSession, sendTo, refreshSessions],
  );

  const retryLast = useCallback(async () => {
    const id = live.current.sessionId;
    const text = lastUserPrompt(live.current.rows);
    if (!id || !text) return;
    await sendTo(id, text);
  }, [sendTo]);

  const cancel = useCallback(async () => {
    const id = live.current.sessionId;
    if (id) await client.cancel(id).catch(() => {});
  }, [client]);

  const setMode = useCallback(
    async (mode: AgentMode) => {
      const id = live.current.sessionId;
 // Before a session exists the choice applies to the next one.
      dispatch({ type: "agent-mode", mode });
      if (!id) return;
      try {
        await client.setMode(id, mode);
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
      }
    },
    [client],
  );

  const setModel = useCallback(
    async (model: string, providerId?: string) => {
      const pref = { model, providerId: providerId ?? live.current.providerId ?? "_active" };
 // Always remember for this cwd (and as last-used) so the next visit
 // restores: cwd → previous workspace → first model.
      saveEndpointPref(live.current.cwd || undefined, pref);
      dispatch({ type: "endpoint", model, providerId: pref.providerId });
      live.current = { ...live.current, model, providerId: pref.providerId };

      const id = live.current.sessionId;
      if (!id) return; // no live session yet — applied on next newSession / send
      try {
        const result = await client.setModel(id, model, providerId);
        dispatch({
          type: "endpoint",
          model: result.model,
          providerId: result.providerId ?? pref.providerId,
        });
        live.current = {
          ...live.current,
          model: result.model,
          providerId: result.providerId ?? pref.providerId,
        };
        if (live.current.cwd) {
          saveEndpointPref(live.current.cwd, {
            model: result.model,
            providerId: result.providerId ?? pref.providerId,
          });
        }
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
        throw err;
      }
    },
    [client],
  );

  const decidePermission = useCallback(
    async (decision: PermissionDecision) => {
      const req = live.current.permission;
      if (!req) return;
      dispatch({ type: "permission-resolved" });
      try {
        await client.respondPermission(req.requestId, decision);
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
      }
    },
    [client],
  );

  const answerQuestion = useCallback(
    async (answers: QuestionAnswers) => {
      const req = live.current.question;
      if (!req) return;
      dispatch({ type: "question-resolved" });
      try {
        await client.respondQuestion(req.requestId, answers);
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
      }
    },
    [client],
  );

  const notify = useCallback((text?: string) => dispatch({ type: "notice", text }), []);

  const closeSession = useCallback(() => {
    live.current = { ...live.current, sessionId: undefined };
    dispatch({ type: "session-closed" });
  }, []);

  return {
    state,
    client,
    workspaces,
    connect,
    connectHost,
    disconnect,
    changeCwd,
    openWorkspace,
    closeWorkspace,
    newSession,
    resumeSession,
    forkSession,
    refreshSessions,
    send,
    removeFollowUp,
    sendFollowUpNow,
    startTask,
    retryLast,
    cancel,
    setMode,
    setModel,
    decidePermission,
    answerQuestion,
    notify,
    closeSession,
  };
}

export { loadPrefs };
