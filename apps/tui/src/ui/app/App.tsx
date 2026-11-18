/**
 * Root TUI component.
 *
 * Responsibilities:
 * - Hold TuiState (single source of truth).
 * - Subscribe to the Session event stream and dispatch TuiAction events.
 * - Drive the permission UI: when a permission request arrives, show the
 * prompt and resolve the bridge's waitDecision promise when the user
 * picks an option.
 * - Route input: slash commands → runCommand; otherwise → session.prompt.
 * - Handle Ctrl+C: cancel running prompt or exit.
 */
import React from "react";
import { Box, Static, Text, measureElement, useInput, useStdout, type DOMElement } from "ink";
import {
  type AgentMode,
  type Event,
  type PermissionResolution,
  type PermissionMode,
  type PermissionPresetName,
  type Session,
  type SlashCommand,
  killAllJobs,
  discoverSlashCommands,
  sameCwd,
  driveGoalRounds,
  type RichSessionSummary,
} from "@codepilot/core";
import { TranscriptItem, isVisibleRow } from "../TranscriptView.js";
import { ToolViewer } from "../ToolViewer.js";
import { onCapturedStderr } from "../../stderrCapture.js";
import { InputBox } from "../InputBox.js";
import { PermissionPrompt } from "../PermissionPrompt.js";
import { QuestionPrompt } from "../QuestionPrompt.js";
import { ConnectWizard } from "../ConnectWizard.js";
import { SetupWizard } from "../SetupWizard.js";
import { ModelPicker } from "../ModelPicker.js";
import { SelectMenu, TextPrompt, type SelectOption } from "../SelectMenu.js";
import { StatusBar } from "../StatusBar.js";
import { Spinner } from "../Spinner.js";
import { initialState, nextAgentMode, reducer, rowKeys, settledCount, type Row } from "../state.js";
import { color, glyph, shortPath, setTheme } from "../theme.js";
import { THEME_LABELS, loadThemePref, saveThemePref, type ThemeName } from "../themes.js";
import { loadEditorMode, saveEditorMode, type EditorMode } from "../editorMode.js";
import { buildCommandList, BUILTIN_COMMAND_NAMES } from "../commands.js";
import type { GoalBridge, PermissionBridge, QuestionBridge, SessionController } from "../controller.js";
import {
  activityLabel,
  clipNotice,
  connectionLabel,
  estimateRowHeight,
  CLEAR_ALL,
  type ConnectionInfo,
  type PrintedItem,
} from "./helpers.js";
import { executeSlashCommand } from "./commandHandlers.js";
import { renderPrintedItem } from "./render.js";
import type { AppProps } from "./types.js";

export type { AppProps, ConnectionInfo } from "./types.js";

// Apply the saved palette before the first render so a chosen theme is active
// from the first frame (mutates the shared `color` palette in place).
setTheme(loadThemePref());


export function App(props: AppProps): React.ReactElement {
  const {
    session: initialSession,
    controller: initialController,
    permissionBridge,
    questionBridge,
    goalBridge,
    cwd,
    model,
    permissionMode,
    initialAgentMode,
    initialPrompt,
    connection,
  } = props;

 // Live session can be swapped by /resume without restarting the TUI.
  const [session, setSession] = React.useState(initialSession);
 // The backend can be swapped at runtime too: /web promotes an in-process
 // (core) controller to a remote one attached to a freshly started serve, so
 // the TUI and the browser share one live session.
  const [controller, setController] = React.useState(initialController);

 // Goal loop requested by the model (via `start_goal`) but not yet driven,
 // keyed by session id. Consumed when the triggering turn settles (idle), then
 // `driveGoalRounds` takes over. `activeGoalLoops` guards against re-entry on
 // the per-round idle events the loop itself produces. Refs (not state) so the
 // event subscription reads current values without re-subscribing.
  const pendingGoalRef = React.useRef<Map<string, { objective: string; maxRounds?: number }>>(new Map());
  const activeGoalLoopsRef = React.useRef<Set<string>>(new Set());
  // Holds the in-process web server started by /web (--local mode) so it can be
  // torn down when the TUI exits. Null until /web starts one.
  const webServerRef = React.useRef<import("@codepilot/protocol/ws").WebSocketServerHandle | null>(null);

  const [state, dispatch] = React.useReducer(reducer, undefined, () =>
    initialState({
      sessionId: initialSession.id,
      cwd,
      model,
      permissionMode,
      agentMode: initialAgentMode,
    }),
  );

 // Record a model-requested goal loop (from `start_goal`). Not started here:
 // `session.prompt()` enqueues while busy, so we wait for the triggering turn
 // to settle. Returning true tells the tool the host accepted.
  const recordPendingGoal = React.useCallback(
    (sid: string, req: { objective: string; maxRounds?: number }): boolean => {
      pendingGoalRef.current.set(sid, {
        objective: req.objective,
        ...(req.maxRounds ? { maxRounds: req.maxRounds } : {}),
      });
      dispatch({ type: "set-notice", text: `Goal loop requested: ${req.objective}` });
      return true;
    },
    [],
  );

 // On idle: if this session has a pending goal and no loop is already driving,
 // consume it and drive rounds. The loop's own prompts produce more idle
 // events, but `activeGoalLoops` guards re-entry so we drive one loop at a time.
  const maybeStartGoalLoop = React.useCallback(
    (sess: Session): void => {
      const sid = sess.id;
      if (activeGoalLoopsRef.current.has(sid)) return;
      const pending = pendingGoalRef.current.get(sid);
      if (!pending) return;
      pendingGoalRef.current.delete(sid);
      activeGoalLoopsRef.current.add(sid);
      void driveGoalRounds(sess, {
        objective: pending.objective,
        maxRounds: pending.maxRounds,
        // Surface per-round progress into the session event stream so the
        // transcript shows goal rounds (same channel the server uses).
        onCheckpoint: (info) =>
          sess.emitGoalProgress({
            round: info.round,
            status: info.status,
            maxRounds: pending.maxRounds,
            reason: info.reason,
            blockedReason: info.blockedReason,
          }),
      })
        .then((r) => {
          dispatch({
            type: "set-notice",
            text: `Goal ${r.status}${r.reason ? `: ${r.reason}` : ""}`,
          });
        })
        .catch((err: unknown) => {
          dispatch({
            type: "set-notice",
            text: `Goal failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        })
        .finally(() => {
          activeGoalLoopsRef.current.delete(sid);
        });
    },
    [],
  );

 // Custom slash commands discovered from .codepilot/commands/*.md and
 // ~/.codepilot/commands/*.md. Discovered once on mount (and re-discovered
 // when cwd changes). Built-in command names are reserved so custom files
 // can't shadow them.
  const [customCommands, setCustomCommands] = React.useState<SlashCommand[]>([]);
  const [showConnect, setShowConnect] = React.useState(false);
  const [showSetup, setShowSetup] = React.useState(false);
  const [showModelPicker, setShowModelPicker] = React.useState(false);
  const [modelPickerRows, setModelPickerRows] = React.useState<
    import("@codepilot/core").SelectableModel[]
  >([]);
 /** Generic ↑↓ picker overlay (provider / mode / agent / session). */
  const [selectOverlay, setSelectOverlay] = React.useState<{
    title: string;
    options: SelectOption[];
    current?: string;
    emptyText?: string;
    onPick: (value: string) => void;
  } | null>(null);
  const [textOverlay, setTextOverlay] = React.useState<{
    title: string;
    placeholder?: string;
    onSubmit: (text: string) => void;
  } | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { commands, warnings } = await discoverSlashCommands(cwd, {
          reservedNames: BUILTIN_COMMAND_NAMES,
        });
        if (cancelled) return;
        setCustomCommands(commands);
        if (warnings.length > 0) {
          dispatch({
            type: "set-notice",
            text: `Custom command warnings:\n${warnings.slice(0, 5).join("\n")}`,
          });
        }
      } catch (err) {
 // Discovery is best-effort; don't block the UI on failure.
        if (!cancelled) {
          setCustomCommands([]);
          dispatch({
            type: "set-notice",
            text: `Custom command discovery failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

 // First-run setup guide: auto-open once when the user has never been shown
 // it (no `onboardedAt` marker in the user config). Completing OR skipping the
 // guide stamps the marker so it never auto-opens again; `/setup` re-runs it.
  React.useEffect(() => {
    try {
      const cfg = session.getConfig() as { onboardedAt?: unknown };
      if (cfg.onboardedAt === undefined || cfg.onboardedAt === null) {
        setShowSetup(true);
      }
    } catch {
  // Config unavailable — skip auto-open rather than block the UI.
    }
  // Run once on mount; re-opening is handled by the `/setup` command.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

 // Activate a freshly connected provider (reload config, merge, switch model).
 // Shared by the standalone /connect wizard and the first-run setup guide.
  const activateProvider = React.useCallback(
    async (id: string, model: string, notify = false) => {
      try {
        const { loadConfigWithSources } = await import("@codepilot/core");
        const { config } = await loadConfigWithSources(cwd);
        session.mergeProviders(config.providers ?? {});
        await session.setProvider(id, model);
        dispatch({
          type: "set-model",
          model: session.getModel(),
          providerId: session.getProviderId() ?? id,
        });
        if (notify) {
          dispatch({
            type: "set-notice",
            text: `Connected ${id} · ${model}\nUse /model to switch models.`,
          });
        }
      } catch (err: unknown) {
        dispatch({
          type: "set-notice",
          text: `Connected but switch failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [cwd, session],
  );

 // Persist the onboarding marker (best-effort) when the setup guide closes.
  const stampOnboarded = React.useCallback(async () => {
    try {
      const { readUserConfigFile, writeUserConfigFile } = await import(
        "@codepilot/core"
      );
      const { raw } = await readUserConfigFile();
      raw.onboardedAt = new Date().toISOString();
      await writeUserConfigFile(raw);
    } catch {
  // Marker persistence is best-effort; a failure just means the guide may
  // auto-open again next launch, which is harmless.
    }
  }, [session]);

 // The merged autocomplete list (built-ins + custom). Memoised so InputBox
 // doesn't re-render on every keystroke.
  const commandList = React.useMemo(
    () => buildCommandList(customCommands),
    [customCommands],
  );

 // 1. Subscribe to session events. `subscribe` replays the history first
 // (core Session, RemoteSession and the mock all do), which seeds the
 // view after a resume — replaying getEvents here as well showed every
 // earlier message twice.
  // `historyEpoch` bumps after /rewind so the trimmed history is replayed.
  const [historyEpoch, setHistoryEpoch] = React.useState(0);
  React.useEffect(() => {
    return session.subscribe((ev: Event) => {
      dispatch({ type: "event", event: ev });
      if (ev.type === "status" && ev.status === "idle") {
        dispatch({ type: "set-busy", busy: false });
        maybeStartGoalLoop(session);
      }
    });
  }, [session, maybeStartGoalLoop, historyEpoch]);

 // 2. Permission bridge: when core calls onPermissionRequest, it pushes
 // a request into the bridge and awaits a decision. The UI side reacts
 // to the bridge's "pending" emitter by setting state.permission.
  React.useEffect(() => {
    return permissionBridge.onPending((req) => {
      dispatch({
        type: "permission-pending",
        req: {
          requestId: req.requestId,
          toolName: req.toolName,
          input: req.input,
          reason: req.reason,
        },
      });
    });
  }, [permissionBridge]);

 // 2b. Question bridge: when core calls onAskUser, it pushes a request into
 // the bridge and awaits answers. The UI renders QuestionPrompt and
 // resolves the waiter once every question has an answer.
  React.useEffect(() => {
    return questionBridge.onPending((req) => {
      dispatch({ type: "question-pending", req });
    });
  }, [questionBridge]);

 // 2c. Goal bridge: core's onGoalRequest (from `start_goal`) records a pending
 // goal here; it is driven when the triggering turn settles idle (see effect 1).
  React.useEffect(() => {
    return goalBridge.onPending((sid, req) => {
      recordPendingGoal(sid, req);
    });
  }, [goalBridge, recordPendingGoal]);

 // 2c. Another client following the same server session answered first.
  React.useEffect(() => {
    const offP = permissionBridge.onDismiss((requestId) => dispatch({ type: "permission-resolve", requestId }));
    const offQ = questionBridge.onDismiss((requestId) => dispatch({ type: "question-resolve", requestId }));
    return () => {
      offP();
      offQ();
    };
  }, [permissionBridge, questionBridge]);

  // Ring the terminal bell when a run finishes, so a user who switched away
  // gets a nudge. Only for runs long enough to matter, and the bell is skipped
  // when CODEPILOT_NO_BELL is set (some terminals turn it into a noisy flash).
  const runStartRef = React.useRef<number | undefined>(undefined);
  const prevBusyRef = React.useRef(state.busy);
  React.useEffect(() => {
    const prev = prevBusyRef.current;
    if (!prev && state.busy) {
      runStartRef.current = Date.now();
    } else if (prev && !state.busy) {
      const started = runStartRef.current;
      runStartRef.current = undefined;
      const longEnough = started === undefined || Date.now() - started >= 10_000;
      if (longEnough && !process.env.CODEPILOT_NO_BELL) {
        process.stdout.write("\x07");
      }
    }
    prevBusyRef.current = state.busy;
  }, [state.busy]);

  const onQuestionDone = React.useCallback(
    (answers: import("@codepilot/core").QuestionAnswers) => {
      const pending = state.question;
      if (pending !== undefined) {
        questionBridge.resolve(pending.requestId, answers);
      }
      dispatch({ type: "question-resolve" });
      dispatch({ type: "set-status", status: state.busy ? "thinking" : "idle" });
    },
    [state.question, state.busy, questionBridge],
  );

  const onPermissionDecide = React.useCallback(
    (resolution: PermissionResolution) => {
      const pending = state.permission;
      if (pending !== undefined) {
        permissionBridge.resolve(pending.requestId, resolution);
      }
      dispatch({ type: "permission-resolve" });
      dispatch({ type: "set-status", status: state.busy ? "thinking" : "idle" });
    },
    [state.permission, state.busy, permissionBridge],
  );

  const applyProvider = React.useCallback(
    async (providerId: string) => {
      try {
        await session.setProvider(providerId);
        const pid = session.getProviderId() ?? providerId;
        dispatch({
          type: "set-model",
          model: session.getModel(),
          providerId: pid,
        });
        dispatch({
          type: "set-notice",
          text: `Provider → ${pid} · ${session.getModel()}`,
        });
      } catch (err: unknown) {
        dispatch({
          type: "set-notice",
          text: `Failed to set provider: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [session],
  );

  const applyPermissionMode = React.useCallback((mode: PermissionMode) => {
    dispatch({ type: "set-mode", mode });
    dispatch({ type: "set-notice", text: `Permission mode: ${mode}` });
  }, []);

  // Apply a named preset: hot-switch BOTH the permission mode and the sandbox
  // mode on the live session via Session.setPreset, then sync the UI's local
  // permission-mode state so the status bar and per-prompt posture match.
  const applyPreset = React.useCallback(
    (name: PermissionPresetName) => {
      try {
        const out = (session as unknown as { setPreset?: (n: PermissionPresetName) => { permissionMode: PermissionMode; sandbox: { mode: string } } }).setPreset?.(name);
        if (out) {
          dispatch({ type: "set-mode", mode: out.permissionMode });
          dispatch({
            type: "set-notice",
            text: `Preset ${name}: ${out.permissionMode} · sandbox ${out.sandbox.mode}`,
          });
          return;
        }
      } catch (err) {
        dispatch({ type: "set-notice", text: `Preset failed: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      dispatch({ type: "set-notice", text: `Preset ${name} is not available on this session` });
    },
    [session],
  );

  const applyTheme = React.useCallback((name: ThemeName) => {
    // Mutates the shared `color` palette in place; the set-notice dispatch
    // below forces a reducer state change so every component re-renders and
    // reads the new colours.
    const applied = setTheme(name);
    saveThemePref(applied);
    dispatch({ type: "set-notice", text: `Theme → ${THEME_LABELS[applied]}` });
  }, []);

  const [editorMode, setEditorMode] = React.useState<EditorMode>(() => loadEditorMode());
  const applyVim = React.useCallback(
    (enabled?: boolean) => {
      const next: EditorMode = (enabled ?? editorMode !== "vim") ? "vim" : "default";
      setEditorMode(next);
      saveEditorMode(next);
      dispatch({
        type: "set-notice",
        text: next === "vim" ? "Vim bindings on — Esc for normal mode, i to insert" : "Vim bindings off",
      });
    },
    [editorMode],
  );

  const applyAgentMode = React.useCallback(
    async (mode: AgentMode) => {
      dispatch({ type: "set-agent-mode", mode });
      dispatch({
        type: "set-notice",
        text: `Collaboration mode → ${mode} (only ${
          mode === "chat"
            ? "safe read tools"
            : mode === "plan"
              ? "read tools + plan_update"
              : "all tools"
        } are exposed to the model)`,
      });
      try {
        await session.setAgentMode(mode);
      } catch (err: unknown) {
        dispatch({
          type: "set-notice",
          text: `Failed to switch collaboration mode: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [session],
  );

  const runGoal = React.useCallback(
    async (objective: string) => {
      dispatch({ type: "set-notice", text: `Goal started: ${objective}` });
      try {
        if (controller.kind === "remote") {
          dispatch({ type: "set-notice", text: "Goals run in-process only — start the TUI with --local." });
          return;
        }
        const r =
          controller.kind === "mock"
            ? await controller.runGoal({ objective, cwd })
            : await controller.core.runGoal({ objective, cwd });
        dispatch({
          type: "set-notice",
          text: `Goal ${r.status}${r.reason ? `: ${r.reason}` : ""}`,
        });
      } catch (err: unknown) {
        dispatch({
          type: "set-notice",
          text: `Goal failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [controller, cwd],
  );

 /** List ~/.codepilot/sessions — same-cwd first, then the rest (incl. legacy unknown). */
  const loadResumeSessions = React.useCallback(async (): Promise<RichSessionSummary[]> => {
    if (controller.kind === "mock") {
      const ss = await controller.listSessions();
      return ss.map((s) => ({ ...s, messageCount: 0 }));
    }
    const all =
      controller.kind === "remote"
        ? await controller.listSessions()
        : await controller.core.listSessions(); // no cwd filter — read the whole sessions dir
    const here = controller.cwd;
    all.sort((a, b) => {
      const aHere = sameCwd(a.cwd, here) ? 0 : 1;
      const bHere = sameCwd(b.cwd, here) ? 0 : 1;
      if (aHere !== bHere) return aHere - bHere;
      return b.updatedAt - a.updatedAt;
    });
    return all;
  }, [controller]);

 /** Swap the live session for one loaded from disk (in-process /resume). */
  const resumeSessionById = React.useCallback(
    async (id: string) => {
      if (controller.kind === "mock") {
        dispatch({ type: "set-notice", text: "Resume is not available in mock mode." });
        return;
      }
      try {
        let next: Session;
        if (controller.kind === "remote") {
 // Follow the server's live instance — same stream as the web.
          next = await controller.openSession(id);
        } else {
          const core = controller.core;
          const all = await core.listSessions();
          const meta = all.find((s) => s.id === id);
          const resumeCwd =
            meta?.cwd && meta.cwd !== "(unknown)" ? meta.cwd : controller.cwd;
          const config = await core.loadConfig(resumeCwd);
          try {
            next = await core.createSession({
              cwd: resumeCwd,
              config,
              sessionId: id,
              onPermissionRequest: (req) => permissionBridge.waitDecision(req),
              onAskUser: (req) => questionBridge.waitAnswers(req),
              onGoalRequest: (req) => goalBridge.request(id, req),
            });
          } catch (err: unknown) {
            // Another process holds the write lease — attach to its daemon when
            // the lock carries a redirect url (shared multi-client path).
            const { SessionLockedError } = await import("@codepilot/core");
            if (err instanceof SessionLockedError && err.owner.url) {
              const { RemoteSession } = await import("../../remoteSession.js");
              next = (await RemoteSession.connect({
                url: err.owner.url,
                token: err.owner.token,
                cwd: resumeCwd,
                sessionId: id,
                onPermissionRequest: (req) => permissionBridge.waitDecision(req),
                onAskUser: (req) => questionBridge.waitAnswers(req),
              })) as unknown as Session;
            } else if (err instanceof SessionLockedError) {
              next = await core.createSession({
                cwd: resumeCwd,
                config,
                sessionId: id,
                readOnly: true,
                onPermissionRequest: (req) => permissionBridge.waitDecision(req),
                onAskUser: (req) => questionBridge.waitAnswers(req),
                onGoalRequest: (req) => goalBridge.request(id, req),
              });
            } else {
              throw err;
            }
          }
        }
        const prev = session;
        dispatch({ type: "clear" });
        setSession(next);
        dispatch({
          type: "init",
          sessionId: next.id,
          cwd: next.getCwd(),
          model: next.getModel(),
          permissionMode: state.permissionMode,
          agentMode: next.getAgentMode(),
        });
        dispatch({
          type: "set-notice",
          text: `Resumed ${id.slice(0, 8)} · ${shortPath(next.getCwd())}`,
        });
        void prev.dispose().catch(() => undefined);
      } catch (err: unknown) {
        dispatch({
          type: "set-notice",
          text: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [controller, permissionBridge, questionBridge, session, state.permissionMode],
  );

  const openSessionPicker = React.useCallback(async () => {
    try {
      const ss = await loadResumeSessions();
      dispatch({ type: "set-sessions", sessions: ss });
      if (ss.length === 0) {
        dispatch({
          type: "set-notice",
          text: "(no saved sessions in ~/.codepilot/sessions)",
        });
        return;
      }
      setSelectOverlay({
        title: "/resume",
        current: session.id,
        emptyText: "(no saved sessions)",
        options: ss.map((s) => ({
          value: s.id,
          label: s.title || s.id.slice(0, 12),
          description: [
            s.id.slice(0, 8),
            s.cwd && s.cwd !== "(unknown)" ? shortPath(s.cwd) : "?",
            s.model ?? "",
            new Date(s.updatedAt).toLocaleString(),
          ]
            .filter(Boolean)
            .join(" · "),
        })),
        onPick: (id) => {
          setSelectOverlay(null);
          void resumeSessionById(id);
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = /transport closed|peer disconnected|peer closed/i.test(msg)
        ? "Lost the connection to the shared server — reconnecting. Try /resume again in a moment."
        : `Failed to list sessions: ${msg}`;
      dispatch({ type: "set-notice", text: friendly });
    }
  }, [loadResumeSessions, resumeSessionById, session.id]);

 // 3. Submit handler.
  const doSubmit = React.useCallback(
    async (text: string, delivery: "auto" | "steer" = "auto") => {
      const slash = await executeSlashCommand(text, {
        session,
        controller,
        cwd,
        customCommands,
        state: {
          permissionMode: state.permissionMode,
          agentMode: state.agentMode,
          plan: state.plan,
          rows: state.rows,
          busy: state.busy,
        },
        dispatch,
        permissionBridge,
        questionBridge,
        webServerRef,
        setShowConnect,
        setShowSetup,
        setModelPickerRows,
        setShowModelPicker,
        setSelectOverlay,
        setTextOverlay,
        setHistoryEpoch,
        setExitPending,
        setController,
        setSession,
        applyProvider,
        applyPermissionMode,
        applyPreset,
        applyAgentMode,
        applyTheme,
        applyVim,
        openSessionPicker,
        runGoal,
        resumeSessionById,
      });
      if (slash !== null) {
        if (slash.kind === "done") return;
        text = slash.text;
      }
 // Real prompt dispatch.
      // Clear any lingering status notice (e.g. the setup/connect summary) so
      // it does not stay pinned below the transcript once a new turn begins.
      dispatch({ type: "set-notice", text: undefined });
      try {
        if (delivery === "steer" && state.busy) {
          const s = session as {
            steer?: (t: string) => void;
            prompt: (t: string, images?: unknown, delivery?: string) => Promise<unknown>;
          };
          if (typeof s.steer === "function") s.steer(text);
          else await s.prompt(text, undefined, "steer");
          dispatch({ type: "set-notice", text: "Injected into the current run." });
          return;
        }
        if (state.busy) {
          const result = await session.prompt(text);
          if (result === "queued" || result === undefined) {
            dispatch({ type: "set-notice", text: "Queued — will run after the current task." });
          }
          return;
        }
        dispatch({ type: "set-busy", busy: true });
        dispatch({ type: "set-status", status: "thinking" });
        await session.prompt(text);
      } catch (err: unknown) {
        dispatch({
          type: "set-notice",
          text: `Prompt error: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        const stillBusy =
          typeof (session as { isBusy?: () => boolean }).isBusy === "function"
            ? (session as { isBusy: () => boolean }).isBusy()
            : false;
        if (!stillBusy && !state.busy) {
          /* idle path clears below */
        }
        if (!stillBusy) {
          dispatch({ type: "set-busy", busy: false });
          dispatch({ type: "set-status", status: "idle" });
        }
      }
    },
    [
      session,
      controller,
      cwd,
      state.busy,
      state.plan,
      state.rows,
      state.permissionMode,
      state.agentMode,
      customCommands,
      applyProvider,
      applyPermissionMode,
      applyPreset,
      applyAgentMode,
      applyVim,
      runGoal,
      openSessionPicker,
      resumeSessionById,
    ],
  );

 // 4. Initial prompt.
  const initialSubmittedRef = React.useRef(false);
  React.useEffect(() => {
    if (initialSubmittedRef.current) return;
    if (initialPrompt === undefined || initialPrompt.trim() === "") return;
    initialSubmittedRef.current = true;
    void doSubmit(initialPrompt);
 // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

 // 5. Cancel handler (Ctrl+C).
  const doCancel = React.useCallback(() => {
    if (state.busy || state.status === "waiting_permission" || state.status === "waiting_question") {
      try {
        session.cancel();
        dispatch({ type: "set-notice", text: "(cancelling…)" });
      } catch (err: unknown) {
        dispatch({
          type: "set-notice",
          text: `Cancel failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }
    setExitPending(true);
  }, [state.busy, state.status, session]);

 // 6. Exit.
  const [exitPending, setExitPending] = React.useState(false);
  React.useEffect(() => {
    if (!exitPending) return;
    void (async () => {
      try {
        await session.dispose();
      } catch {
 /* ignore */
      }
      // Tear down the web server /web started in-process, clearing serve.json.
      if (webServerRef.current) {
        try {
          await webServerRef.current.close();
          const { clearServeInfo } = await import("@codepilot/protocol/serve-info");
          await clearServeInfo();
        } catch {
 /* best-effort */
        }
      }
      await killAllJobs().catch(() => {});
 // Compact the persistent prompt history on the way out.
      try {
        const { compactHistory } = await import("../history.js");
        compactHistory();
      } catch {
 /* best-effort */
      }
      process.exit(0);
    })();
  }, [exitPending, session]);

  const pendingPerm = state.permission;
  const pendingQuestion = state.question;

 // ---------------------------------------------------------------------------
 // Rendering model. Finished rows are printed ONCE into the terminal's own
 // scrollback via <Static> (so the native scrollbar / mouse wheel / search
 // work and nothing is ever drawn twice). Only rows still changing live in
 // the redrawn region, which is kept strictly shorter than the terminal:
 // Ink clears the screen and reprints all output whenever its dynamic frame
 // reaches the terminal height.
 // ---------------------------------------------------------------------------
  const { stdout } = useStdout();
  const [size, setSize] = React.useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const [epoch, setEpoch] = React.useState(0);
  const [viewerOpen, setViewerOpen] = React.useState(false);
  const printedRef = React.useRef<{ epoch: number; keys: Set<string>; items: PrintedItem[] }>({
    epoch: -1,
    keys: new Set(),
    items: [],
  });

  const reprint = React.useCallback(() => {
    stdout.write(CLEAR_ALL);
    setEpoch((e) => e + 1);
  }, [stdout]);

  React.useEffect(() => {
    let cols = stdout.columns || 80;
    const onResize = (): void => {
      const next = { cols: stdout.columns || 80, rows: stdout.rows || 24 };
      setSize(next);
 // Lines printed at the old width re-wrap unpredictably; reprint them.
      if (next.cols !== cols) {
        cols = next.cols;
        reprint();
      }
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, reprint]);

 // Stray stderr writes (provider retries, library warnings) would tear the
 // frame; cli.tsx diverts them here and they surface as a notice.
  React.useEffect(
    () =>
      onCapturedStderr((text) => {
        dispatch({ type: "set-notice", text });
      }),
    [],
  );

  const keys = rowKeys(state.rows);
  const settled = settledCount(state.rows, state.busy);
  if (printedRef.current.epoch !== epoch) {
    printedRef.current = { epoch, keys: new Set(), items: [{ key: "welcome" }] };
  }
  const printed = printedRef.current;
  const current = new Set(keys);
 // A printed row vanished (/clear, /rewind, session switch): the scrollback
 // no longer matches the transcript, so wipe and reprint it.
 // Transient rows (retry banners, rate-limit notices) may drop out on their
 // own; only a vanished message or tool call means the history changed.
  let stale = false;
  for (const k of printed.keys) {
    if (/^[uat]:/.test(k) && !current.has(k)) {
      stale = true;
      break;
    }
  }
  if (!stale) {
    for (let i = 0; i < settled; i++) {
      const k = keys[i]!;
      if (printed.keys.has(k)) continue;
      printed.keys.add(k);
      const row = state.rows[i]!;
      if (isVisibleRow(row) && !(row.kind === "goal" && row.status === "running")) printed.items.push({ key: k, row });
    }
  }
  React.useLayoutEffect(() => {
    if (stale) reprint();
  }, [stale, reprint]);

  const liveRows: { key: string; row: Row }[] = [];
  for (let i = 0; i < state.rows.length; i++) {
    const row = state.rows[i]!;
    const runningGoal = row.kind === "goal" && row.status === "running";
    if (runningGoal || (i >= settled && !printed.keys.has(keys[i]!) && isVisibleRow(row))) liveRows.push({ key: keys[i]!, row });
  }

  const chromeRef = React.useRef<DOMElement>(null);
  const [chromeHeight, setChromeHeight] = React.useState(8);
  React.useEffect(() => {
    if (!chromeRef.current) return;
    const h = measureElement(chromeRef.current).height;
    if (h !== chromeHeight) setChromeHeight(h);
  });
 // Leave several rows of slack: Ink's log-update appends a trailing newline, and
 // a single over-wide CJK line (terminal wrap) is enough to scroll a blank into
 // scrollback when the frame already sits on the last row.
  const liveBudget = Math.max(0, size.rows - chromeHeight - 4);
  const liveEstimate = liveRows.reduce((n, r) => n + estimateRowHeight(r.row, size.cols), 0);

  const modalOpen =
    pendingPerm !== undefined ||
    pendingQuestion !== undefined ||
    showConnect ||
    showSetup ||
    showModelPicker ||
    selectOverlay !== null ||
    textOverlay !== null;

  useInput(
    (input, key) => {
      // Shift+Tab cycles the collaboration mode (Agent → Plan → Ask → …), the
      // same control the other clients expose as a mode switch.
      if (key.tab && key.shift) {
        void applyAgentMode(nextAgentMode(state.agentMode));
        return;
      }
      if (key.ctrl && input === "o") setViewerOpen(true);
    },
    { isActive: !modalOpen && !viewerOpen },
  );

  const renderPrinted = (item: PrintedItem): React.ReactElement =>
    renderPrintedItem(item, {
      model: state.model,
      providerId: state.providerId,
      cwd: state.cwd,
      agentMode: state.agentMode,
      permissionMode: state.permissionMode,
      connection: connectionLabel(connection),
      width: size.cols,
    });
  const transcript = (
    <Static key={`s-${epoch}`} items={printed.items.slice()}>
      {renderPrinted}
    </Static>
  );

  if (viewerOpen) {
    return (
      <Box flexDirection="column" width="100%">
        {transcript}
        <ToolViewer
          rows={state.rows}
          width={size.cols}
          height={Math.max(6, size.rows - 1)}
          onClose={() => {
            setViewerOpen(false);
 // The overlay covered the screen; bring the transcript back into view.
            reprint();
          }}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      {transcript}

      {liveRows.length > 0 && liveBudget >= 3 ? (
        <Box
          flexDirection="column"
          paddingX={1}
          {...(liveEstimate > liveBudget
            ? { height: liveBudget, overflowY: "hidden" as const, justifyContent: "flex-end" as const }
            : {})}
        >
          {liveRows.map(({ key, row }) => (
            <TranscriptItem key={key} row={row} live maxLines={Math.max(3, liveBudget - 4)} />
          ))}
        </Box>
      ) : null}

      <Box ref={chromeRef} flexDirection="column">
      {state.busy ? (
        <Box paddingX={1} marginTop={1}>
          <Spinner
            color={color.accent}
            label={activityLabel(state)}
            since={state.activity?.since}
          />
          <Text color={color.faint}> {glyph.dot} ^C stop {glyph.dot} ^O details</Text>
        </Box>
      ) : null}

      {state.notice !== undefined ? (
        <Box paddingX={1} marginTop={1}>
          <Text color={color.info}>{glyph.bar} </Text>
          <Box flexGrow={1}>
            <Text>{clipNotice(state.notice, Math.max(4, Math.floor(size.rows / 3)))}</Text>
          </Box>
        </Box>
      ) : null}

      {/* Permission / question / connect wizard / input */}
      {pendingPerm !== undefined ? (
        <Box paddingX={1} marginY={1}>
          <PermissionPrompt
            toolName={pendingPerm.toolName}
            input={pendingPerm.input}
            reason={pendingPerm.reason}
            onDecide={onPermissionDecide}
          />
        </Box>
      ) : pendingQuestion !== undefined ? (
        <Box paddingX={1} marginY={1}>
          <QuestionPrompt request={pendingQuestion} onDone={onQuestionDone} />
        </Box>
      ) : showSetup ? (
        <Box paddingX={1} marginY={1}>
          <SetupWizard
            existingIds={Object.keys(
              (session.getConfig() as { providers?: Record<string, unknown> }).providers ?? {},
            )}
            hasProvider={
              Object.keys(
                (session.getConfig() as { providers?: Record<string, unknown> }).providers ?? {},
              ).length > 0
            }
            onProviderConnected={(result) => {
              void activateProvider(result.id, result.model);
            }}
            onDone={(lines) => {
              setShowSetup(false);
              void stampOnboarded();
              dispatch({
                type: "set-notice",
                text: `Setup complete:\n${lines.join("\n")}\nRe-run anytime with /setup.`,
              });
            }}
          />
        </Box>
      ) : showConnect ? (
        <Box paddingX={1} marginY={1}>
          <ConnectWizard
            existingIds={Object.keys(
              (session.getConfig() as { providers?: Record<string, unknown> }).providers ?? {},
            )}
            onDone={(result) => {
              setShowConnect(false);
              if (result.cancelled || !result.id) {
                dispatch({ type: "set-notice", text: "Connect cancelled" });
                return;
              }
              void activateProvider(result.id, result.model, true);
            }}
          />
        </Box>
      ) : showModelPicker ? (
        <Box paddingX={1} marginY={1}>
          <ModelPicker
            models={modelPickerRows}
            currentModel={session.getModel()}
            currentProviderId={session.getProviderId()}
            onCancel={() => {
              setShowModelPicker(false);
              dispatch({ type: "set-notice", text: undefined });
            }}
            onPick={(m) => {
              setShowModelPicker(false);
              void (async () => {
                try {
                  await session.setModel(m.model, m.providerId);
                  dispatch({
                    type: "set-model",
                    model: session.getModel(),
                    providerId: session.getProviderId() ?? m.providerId,
                  });
                  dispatch({
                    type: "set-notice",
                    text: `Model → ${m.providerId}/${m.model}`,
                  });
                } catch (err: unknown) {
                  dispatch({
                    type: "set-notice",
                    text: `Failed to set model: ${err instanceof Error ? err.message : String(err)}`,
                  });
                }
              })();
            }}
          />
        </Box>
      ) : selectOverlay ? (
        <Box paddingX={1} marginY={1}>
          <SelectMenu
            title={selectOverlay.title}
            options={selectOverlay.options}
            current={selectOverlay.current}
            emptyText={selectOverlay.emptyText}
            onPick={selectOverlay.onPick}
            onCancel={() => setSelectOverlay(null)}
          />
        </Box>
      ) : textOverlay ? (
        <Box paddingX={1} marginY={1}>
          <TextPrompt
            title={textOverlay.title}
            placeholder={textOverlay.placeholder}
            onSubmit={textOverlay.onSubmit}
            onCancel={() => setTextOverlay(null)}
          />
        </Box>
      ) : (
        <Box paddingX={1} marginTop={1} flexDirection="column">
          <InputBox
            value={state.input}
            onChange={(v) => dispatch({ type: "set-input", value: v })}
            onSubmit={(t, delivery) => {
              dispatch({ type: "set-input", value: "" });
              void doSubmit(t, delivery);
            }}
            onCancel={doCancel}
            vimMode={editorMode === "vim"}
            onNotice={(text) => dispatch({ type: "set-notice", text })}
            disabled={!!state.permission || !!state.question}
            busy={state.busy}
            cwd={cwd}
            commands={commandList}
            placeholder={
              state.busy
                ? "Working… type to queue a follow-up"
                : "Ask anything · / for commands · @ to add files"
            }
          />
        </Box>
      )}

      {/* Status bar */}
      <StatusBar
        state={state}
        statusLineConfig={session.getStatusLineConfig()}
        cwd={cwd}
        version="1.0.0"
        rateLimit={session.getRateLimitSnapshot?.()}
      />
      </Box>
    </Box>
  );
}
