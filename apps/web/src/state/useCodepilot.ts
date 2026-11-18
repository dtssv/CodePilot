// The one place that owns the protocol client and turns UI intents into
// protocol calls. Every layout (web, agent, embedded) renders from the same
// `state` and calls the same actions, so behaviour cannot drift between them.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type {
  AgentMode,
  ImageAttachment,
  PermissionResolution,
  PromptFile,
  QuestionAnswers,
  ReasoningEffort,
} from "@codepilot/core";

import {
  CodepilotClient,
  describeError,
  parseServeUrl,
  sessionLockedOwner,
  type PendingPermission,
  type PendingQuestion,
} from "../protocol/client.js";
import { bridgeOpener, type HostBridge } from "../protocol/bridge.js";
import {
  addWorkspace,
  loadDefaultAgentMode,
  loadPermissionMode,
  loadPrefs,
  loadReasoningEffort,
  removeWorkspace,
  replaceWorkspaces,
  matchPreferredEndpoint,
  saveDefaultAgentMode,
  saveEndpointPref,
  savePrefs,
  saveReasoningEffort,
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
 /** Seed the local workspace list without switching the active one. By default
  * merges; pass `replace: true` to make the list EXACTLY `cwds` (used by a
  * remote phone so only the grant-authorized workspaces show, never the
  * localStorage-cached set from a prior local session). */
  seedWorkspaces(cwds: string[], opts?: { replace?: boolean }): void;
 /** Remove a workspace from the open list (does not delete sessions on disk). */
  closeWorkspace(cwd: string): Promise<void>;
  newSession(mode?: AgentMode): Promise<string | undefined>;
  resumeSession(id: string): Promise<void>;
  forkSession(): Promise<void>;
  refreshSessions(): Promise<void>;
  pinSession(id: string, pinned: boolean): Promise<void>;
  archiveSession(id: string, archived: boolean): Promise<void>;
  send(
    text: string,
    images?: ImageAttachment[],
    files?: PromptFile[],
    delivery?: "auto" | "queue" | "steer",
  ): Promise<void>;
  removeFollowUp(id: string): Promise<void>;
  sendFollowUpNow(id: string): Promise<void>; // rejects if the RPC fails
 /** Fresh session in `mode`, then send — the agent app's "new task". */
  startTask(text: string, mode?: AgentMode, images?: ImageAttachment[], files?: PromptFile[]): Promise<void>;
 /** Resend the last user prompt (after an error). */
  retryLast(): Promise<void>;
  cancel(): Promise<void>;
  setMode(mode: AgentMode): Promise<void>;
 /** Switch model (and optionally provider preset) for the current session. */
  setModel(
    model: string,
    providerId?: string,
    reasoningEffort?: ReasoningEffort | null,
  ): Promise<void>;
  decidePermission(resolution: PermissionResolution): Promise<void>;
  answerQuestion(answers: QuestionAnswers): Promise<void>;
  notify(text?: string): void;
 /** Leave the current session and show the home/empty screen. */
  closeSession(): void;
  /** Page in older transcript events when the user scrolls near the top. */
  loadOlderHistory(): Promise<void>;
}

export function useCodepilot(): Codepilot {
  const prefs = useMemo(loadPrefs, []);
  const [state, dispatch] = useReducer(reducer, initialState(prefs.cwd, loadDefaultAgentMode()));
  const [workspaces, setWorkspaces] = useState<string[]>(prefs.workspaces);

 // Mirrors of state the client callbacks need synchronously (a reconnect
 // fires from inside the client, before React re-renders).
  const live = useRef(state);
  live.current = state;
  const lastWs = useRef<WsTarget | null>(null);

  // Lets the client's onEvent handler (created once, before refreshSessions is
  // defined) ask for a sidebar refresh without a stale closure.
  const refreshSessionsRef = useRef<() => void>(() => {});

  const clientRef = useRef<CodepilotClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new CodepilotClient({
      onEvent: (sessionId, event) => {
 // Only the session currently on screen receives events. When the user
 // leaves a running session (close, or switch workspace), sessionId is
 // cleared — without this guard, the old run's transcript would paint
 // onto the empty / new-workspace view.
        if (!live.current.sessionId || sessionId !== live.current.sessionId) return;
        dispatch({ type: "event", event });
        // A new session is a "draft" until its first user message is
        // persisted, so refresh the sidebar once when that message arrives.
        if (
          event.type === "message" &&
          event.role === "user" &&
          !live.current.sessions.some((s) => s.id === sessionId)
        ) {
          refreshSessionsRef.current();
        }
      },
      onPermission: (req: PendingPermission) => {
        if (!live.current.sessionId || req.sessionId !== live.current.sessionId) return;
        dispatch({ type: "permission", req });
      },
      onQuestion: (req: PendingQuestion) => {
        if (!live.current.sessionId || req.sessionId !== live.current.sessionId) return;
        dispatch({ type: "question", req });
      },
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
  // Keep the ref used by onEvent pointed at the latest refreshSessions.
  refreshSessionsRef.current = () => void refreshSessions();

  type OpenResumeOpts = { redirected: boolean; noticeOnOk?: string };
  const openResumedSessionRef = useRef<(id: string, opts: OpenResumeOpts) => Promise<void>>(
    async () => undefined,
  );

  async function resumeCurrent(): Promise<void> {
    const id = live.current.sessionId;
    if (id) {
      try {
        await openResumedSessionRef.current(id, {
          redirected: false,
          noticeOnOk: "reconnected — session restored",
        });
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
          permissionMode: loadPermissionMode(),
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

  function normalizeWsUrl(url: string): string {
    try {
      const u = new URL(url);
      u.search = "";
      u.hash = "";
      return u.toString().replace(/\/$/, "");
    } catch {
      return url.replace(/\/$/, "");
    }
  }

  /** Apply a resume result, then backfill older history in the background. */
  function applyResumeResult(
    res: {
      sessionId: string;
      events: import("@codepilot/core").Event[];
      historyTruncated?: boolean;
      historyBefore?: number;
      readOnly?: boolean;
    },
    notice?: string,
  ): void {
    const historyBefore =
      res.historyTruncated && res.historyBefore !== undefined ? res.historyBefore : undefined;
    // Patch live BEFORE dispatch/backfill: React has not re-rendered yet, so
    // `live.current = state` still points at the previous session — without
    // this, backfill sees a sessionId mismatch and exits on the first line.
    live.current = {
      ...live.current,
      sessionId: res.sessionId,
      historyBefore,
      readOnly: res.readOnly === true,
    };
    dispatch({
      type: "session-opened",
      sessionId: res.sessionId,
      agentMode: live.current.agentMode,
      history: res.events,
      ...(historyBefore !== undefined ? { historyBefore } : {}),
      ...(res.readOnly ? { readOnly: true } : {}),
    });
    if (notice) dispatch({ type: "notice", text: notice });
    if (historyBefore !== undefined) {
      void backfillHistory(res.sessionId, historyBefore);
    }
  }

  const historyInflight = useRef(false);

  async function backfillHistory(sessionId: string, before: number): Promise<void> {
    // Keep paging until the full display history is in the UI (no hard page
    // cap — long sessions used to stop ~5k events above the resume tail).
    // Seed from `before`; subsequent iterations prefer live.historyBefore so a
    // concurrent near-top loadOlderHistory advances the same pointer.
    let cursor: number | undefined = before;
    while (cursor !== undefined) {
      if (live.current.sessionId !== sessionId) return;
      const liveCursor = live.current.historyBefore;
      if (liveCursor === undefined) return;
      cursor = liveCursor;
      if (historyInflight.current) {
        await new Promise<void>((r) => setTimeout(r, 16));
        continue;
      }
      historyInflight.current = true;
      try {
        const chunk = await client.sessionHistory(sessionId, cursor);
        if (live.current.sessionId !== sessionId) return;
        if (live.current.historyBefore !== cursor) continue;
        const nextBefore = chunk.historyTruncated ? chunk.historyBefore : undefined;
        live.current = { ...live.current, historyBefore: nextBefore };
        dispatch({
          type: "history-prepend",
          events: chunk.events,
          historyTruncated: chunk.historyTruncated,
          historyBefore: chunk.historyBefore,
        });
        cursor = nextBefore;
      } catch {
        return;
      } finally {
        historyInflight.current = false;
      }
      // Yield so React can paint / preserve scroll between pages.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  const loadOlderHistory = useCallback(async (): Promise<void> => {
    const sessionId = live.current.sessionId;
    const before = live.current.historyBefore;
    if (!sessionId || before === undefined || historyInflight.current) return;
    historyInflight.current = true;
    try {
      const chunk = await client.sessionHistory(sessionId, before);
      if (live.current.sessionId !== sessionId) return;
      if (live.current.historyBefore !== before) return;
      const nextBefore = chunk.historyTruncated ? chunk.historyBefore : undefined;
      live.current = { ...live.current, historyBefore: nextBefore };
      dispatch({
        type: "history-prepend",
        events: chunk.events,
        historyTruncated: chunk.historyTruncated,
        historyBefore: chunk.historyBefore,
      });
    } catch {
      /* fail-soft: layout near-top retry / scroll will try again */
    } finally {
      historyInflight.current = false;
    }
  }, [client]);

  const connectHost = useCallback(
    async (bridge: HostBridge, cwd: string, clientName: string) => {
      dispatch({ type: "connecting" });
      try {
        const effectiveCwd = cwd.trim();
        const init = await client.connectTransport(bridgeOpener(bridge), {
          cwd: effectiveCwd || undefined,
          clientName,
        });
        dispatch({ type: "connected", cwd: effectiveCwd, modes: init.capabilities.modes });
        if (effectiveCwd) {
          const ws = addWorkspace(effectiveCwd);
          setWorkspaces(ws);
        }
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

  const seedWorkspaces = useCallback((cwds: string[], opts?: { replace?: boolean }) => {
    // Replace mode (remote phone): the displayed set becomes EXACTLY the
    // grant-authorized cwds, purging any localStorage-cached workspaces from a
    // prior local session — otherwise a phone paired for 2 workspaces would
    // still see every workspace this browser profile had open before.
    if (opts?.replace) {
      setWorkspaces(replaceWorkspaces(cwds));
      return;
    }
    let next = loadPrefs().workspaces;
    for (const raw of cwds) {
      const cwd = raw.trim().replace(/\/+$/, "") || raw.trim();
      if (cwd) next = addWorkspace(cwd);
    }
    setWorkspaces(next);
  }, []);

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

  openResumedSessionRef.current = async (id, opts) => {
    try {
      const res = await client.resumeSession(id);
      applyResumeResult(res, opts.noticeOnOk);
      void syncEndpoint(id);
    } catch (err) {
      const owner = sessionLockedOwner(err);
      if (!owner) throw err;

      if (!opts.redirected && owner.url) {
        const target = lastWs.current;
        const sameUrl =
          target &&
          normalizeWsUrl(target.url) === normalizeWsUrl(owner.url) &&
          (target.token || "") === (owner.token || "");
        if (!sameUrl) {
          dispatch({
            type: "notice",
            text: `Session is live on another CodePilot (pid ${owner.pid}) — switching…`,
          });
          const cwd = target?.cwd ?? live.current.cwd;
          await connect({
            url: owner.url,
            token: owner.token ?? "",
            cwd: cwd || undefined,
          });
          await openResumedSessionRef.current(id, {
            redirected: true,
            noticeOnOk: `Attached to live session (pid ${owner.pid})`,
          });
          return;
        }
      }

      const res = await client.resumeSession(id, { readOnly: true });
      applyResumeResult(
        res,
        `Read-only: session is held by pid ${owner.pid}. Close that client to edit, or open it on the holding daemon.`,
      );
      void syncEndpoint(id);
    }
  };

  const newSession = useCallback(
    async (mode?: AgentMode) => {
      const cwd = live.current.cwd;
      if (!cwd) {
        dispatch({ type: "notice", text: "Open a workspace folder first." });
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
            const effort = loadReasoningEffort(model, providerId);
            const result = await client.setModel(
              sessionId,
              model,
              providerId,
              effort === undefined ? null : effort,
            );
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
        await openResumedSessionRef.current(id, { redirected: false });
        live.current = { ...live.current, sessionId: id };
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
      }
    },
    [client, connect, syncEndpoint],
  );

  const forkSession = useCallback(async () => {
    const id = live.current.sessionId;
    if (!id) return;
    try {
      const forked = await client.fork(id);
      const res = await client.resumeSession(forked);
      live.current = { ...live.current, sessionId: res.sessionId };
      applyResumeResult(res, `forked → ${res.sessionId}`);
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
        // Only force idle when we were not mid-run; a failed inject must not
        // look like the whole task stopped.
        if (delivery !== "steer") {
          dispatch({ type: "event", event: { type: "status", status: "idle" } });
        }
        throw err;
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
      if (live.current.readOnly) {
        dispatch({
          type: "notice",
          text: "This session is read-only (held by another process). Re-open it on the holding daemon to send.",
        });
        throw new Error("session is read-only");
      }
      const id = live.current.sessionId ?? (await newSession());
      if (!id) throw new Error("could not open a session");
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
      try {
        const res = await client.sendFollowUpNow(id, followUpId);
        if (res?.delivery === "steered" || res?.delivery === "started") {
          dispatch({ type: "notice", text: "Injected into the current run" });
        } else {
          dispatch({ type: "notice", text: "Could not send queued message (already gone?)" });
        }
      } catch (err) {
        dispatch({ type: "notice", text: describeError(err) });
        throw err;
      }
    },
    [client],
  );

  const startTask = useCallback(
    async (text: string, mode: AgentMode = "agent", images?: ImageAttachment[], files?: PromptFile[]) => {
      const id = await newSession(mode);
      if (!id) throw new Error("could not open a session");
      await sendTo(id, text, images, files);
      void refreshSessions();
    },
    [newSession, sendTo, refreshSessions],
  );

  const retryLast = useCallback(async () => {
    const id = live.current.sessionId;
    if (!id) return;
    // Prefer resuming the last turn from the breakpoint (no new user bubble):
    // the agent re-engages exactly where it stopped. Only when there is
    // nothing to resume (the server reports `noop`) do we fall back to
    // re-sending the last prompt as a fresh message.
    try {
      const res = await client.resumeTurn(id);
      if (res.delivery !== "noop") return;
    } catch {
      /* fall through to resend */
    }
    const text = lastUserPrompt(live.current.rows);
    if (!text) return;
    await sendTo(id, text);
  }, [client, sendTo]);

  const cancel = useCallback(async () => {
    const id = live.current.sessionId;
    if (id) await client.cancel(id).catch(() => {});
  }, [client]);

  const setMode = useCallback(
    async (mode: AgentMode) => {
      const id = live.current.sessionId;
 // Before a session exists the choice applies to the next one.
      saveDefaultAgentMode(mode);
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
    async (
      model: string,
      providerId?: string,
      reasoningEffort?: ReasoningEffort | null,
    ) => {
      const pref = { model, providerId: providerId ?? live.current.providerId ?? "_active" };
      const effort =
        reasoningEffort !== undefined
          ? reasoningEffort
          : loadReasoningEffort(model, pref.providerId);
 // Always remember for this cwd (and as last-used) so the next visit
 // restores: cwd → previous workspace → first model.
      saveEndpointPref(live.current.cwd || undefined, pref);
      if (reasoningEffort !== undefined) {
        saveReasoningEffort(model, pref.providerId, effort ?? undefined);
      }
      dispatch({ type: "endpoint", model, providerId: pref.providerId });
      live.current = { ...live.current, model, providerId: pref.providerId };

      const id = live.current.sessionId;
      if (!id) return; // no live session yet — applied on next newSession / send
      try {
        const result = await client.setModel(
          id,
          model,
          providerId,
          effort === undefined ? null : effort,
        );
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
    async (resolution: PermissionResolution) => {
      const req = live.current.permission;
      if (!req) return;
      dispatch({ type: "permission-resolved" });
      try {
        // Split a decline-with-feedback object into decision + message.
        // `{ decision: "abort" }` carries no feedback.
        const decision = typeof resolution === "string" ? resolution : resolution.decision;
        const feedback =
          typeof resolution === "string" || resolution.decision === "abort"
            ? undefined
            : resolution.feedback;
        await client.respondPermission(req.requestId, decision, feedback);
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

  const pinSession = useCallback(
    async (id: string, pinned: boolean) => {
      await client.pinSession(id, pinned);
      await refreshSessions();
    },
    [client, refreshSessions],
  );

  const archiveSession = useCallback(
    async (id: string, archived: boolean) => {
      await client.archiveSession(id, archived);
      await refreshSessions();
    },
    [client, refreshSessions],
  );

  return {
    state,
    client,
    workspaces,
    connect,
    connectHost,
    disconnect,
    changeCwd,
    openWorkspace,
    seedWorkspaces,
    closeWorkspace,
    newSession,
    resumeSession,
    forkSession,
    refreshSessions,
    pinSession,
    archiveSession,
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
    loadOlderHistory,
  };
}

export { loadPrefs };
