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
import { Box, Text, measureElement, useInput, useStdout, type DOMElement } from "ink";
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
  listMcpPromptSlashCommands,
  sameCwd,
  driveGoalRounds,
  type RichSessionSummary,
} from "@codepilot/core";
import { WelcomeBanner } from "../TranscriptView.js";
import { TranscriptViewport, entryAtScreenY, viewportLayout } from "../TranscriptViewport.js";
import { initialInteraction, interactionReducer } from "../interaction.js";
import { onTermMouse, type TermMouseEvent } from "../mouse.js";
import { isEscape } from "../keys.js";
import { AgentDialog, dialogWindow } from "./AgentDialog.js";
import { buildTranscriptEntries, lastFocusable, nextFocusable, runsForKey, scrollToShow } from "./entries.js";
import { ToolViewer } from "../ToolViewer.js";
import { onCapturedStderr } from "../../stderrCapture.js";
import { InputBox } from "../InputBox.js";
import { PermissionPrompt } from "../PermissionPrompt.js";
import { QuestionPrompt } from "../QuestionPrompt.js";
import { ConnectWizard } from "../ConnectWizard.js";
import { SetupWizard } from "../SetupWizard.js";
import { ModelPicker } from "../ModelPicker.js";
import { SelectMenu, TextPrompt, type SelectOption } from "../SelectMenu.js";
import { HelpPanel } from "../HelpPanel.js";
import { StatusBar } from "../StatusBar.js";
import { Spinner } from "../Spinner.js";
import { initialState, nextAgentMode, reducer, rowKeys, settledCount } from "../state.js";
import { color, glyph, shortPath, setTheme } from "../theme.js";
import { THEME_LABELS, loadThemePref, saveThemePref, type ThemeName } from "../themes.js";
import { loadEditorMode, saveEditorMode, type EditorMode } from "../editorMode.js";
import { buildCommandList, BUILTIN_COMMAND_NAMES } from "../commands.js";
import { VERSION } from "../../version.js";
import type { GoalBridge, PermissionBridge, QuestionBridge, SessionController } from "../controller.js";
import { activityLabel, clipNotice, connectionLabel, type ConnectionInfo } from "./helpers.js";
import { executeSlashCommand } from "./commandHandlers.js";
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
  /** Full-screen help panel (/help). Rendered instead of the chat view. */
  const [showHelp, setShowHelp] = React.useState(false);
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

 // Merged custom + live MCP prompt slash commands. MCP side is read live each
 // render so prompts/list_changed (manager cache refresh) shows up without a
 // separate invalidation channel; listAllPrompts is in-memory and cheap.
  const takenCustomNames = React.useMemo(
    () => new Set(customCommands.map((c) => c.name.toLowerCase())),
    [customCommands],
  );
  const allCustomCommands = [
    ...customCommands,
    ...listMcpPromptSlashCommands(session.getMcpManager(), {
      takenNames: takenCustomNames,
    }),
  ];

 // Built-ins + custom markdown + live MCP prompts for the `/` autocomplete.
  const commandList = buildCommandList(allCustomCommands);

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
          ...(req.preview ? { preview: req.preview } : {}),
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
              ? "read tools + plan"
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
      const taken = new Set(customCommands.map((c) => c.name.toLowerCase()));
      const slash = await executeSlashCommand(text, {
        session,
        controller,
        cwd,
        customCommands: [
          ...customCommands,
          ...listMcpPromptSlashCommands(session.getMcpManager(), { takenNames: taken }),
        ],
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
        setShowHelp,
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
          dispatch({ type: "set-notice", text: "Will apply after the current step." });
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
 // Rendering model. The transcript lives in our own scrolling viewport: rows
 // stay mounted so they can open and close, take focus, and receive clicks. The
 // whole frame is kept shorter than the terminal so Ink never has to wipe and
 // reprint it, which is what made the old <Static> transcript immutable.
 // ---------------------------------------------------------------------------
  const { stdout } = useStdout();
  const [size, setSize] = React.useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const [viewerOpen, setViewerOpen] = React.useState(false);
  const [interaction, dispatchInteraction] = React.useReducer(interactionReducer, initialInteraction);
  const [measured, setMeasured] = React.useState<ReadonlyMap<string, number>>(() => new Map());
  const entryKeysRef = React.useRef<ReadonlySet<string>>(new Set());
  // The viewport reports after every render; returning the previous state when
  // nothing moved keeps that from re-rendering forever.
  const onMeasure = React.useCallback((next: ReadonlyMap<string, number>) => {
    setMeasured((prev) => {
      let changed = false;
      for (const [key, h] of next) {
        if (!entryKeysRef.current.has(key)) continue;
        if (prev.get(key) !== h) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;
      const merged = new Map<string, number>();
      for (const [key, h] of next) {
        if (entryKeysRef.current.has(key)) merged.set(key, h);
      }
      return merged;
    });
  }, []);

  React.useEffect(() => {
    const onResize = (): void => {
      setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

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

  const chromeRef = React.useRef<DOMElement>(null);
  // null until measured: the first frame is laid out (and flushed) before the
  // layout effect below runs, so any guess at the chrome height is a guess that
  // can be too small. Too small overflows the terminal on short windows and Ink
  // answers with clearTerminal (2J 3J, wiping the scrollback), so the first frame
  // renders a minimal transcript instead.
  const [chromeHeight, setChromeHeight] = React.useState<number | null>(null);
 // Layout effect, not effect: a chrome box taller than the guess would push the
 // frame to the terminal height for one paint, and Ink answers that by clearing
 // the screen *and* the scrollback (its clearTerminal includes 3J).
  React.useLayoutEffect(() => {
    if (!chromeRef.current) return;
    const h = measureElement(chromeRef.current).height;
    if (h !== chromeHeight) setChromeHeight(h);
  });
 // Two rows of slack: Ink appends a trailing newline to every frame, and a single
 // over-wide CJK line can wrap once more than we counted.
  const transcriptHeight =
    chromeHeight === null ? 3 : Math.max(3, size.rows - chromeHeight - 2);
  const liveMaxLines = Math.max(3, transcriptHeight - 6);

  const modalOpen =
    pendingPerm !== undefined ||
    pendingQuestion !== undefined ||
    showConnect ||
    showSetup ||
    showModelPicker ||
    showHelp ||
    selectOverlay !== null ||
    textOverlay !== null;

  const welcome = (
    <WelcomeBanner
      version="1.0.0"
      model={state.model}
      providerId={state.providerId}
      cwd={state.cwd}
      agentMode={state.agentMode}
      permissionMode={state.permissionMode}
      connection={connectionLabel(connection)}
      width={size.cols}
    />
  );
  const entries = buildTranscriptEntries({
    rows: state.rows,
    keys,
    cols: size.cols,
    interaction,
    welcome,
    liveFrom: settled,
    liveMaxLines,
  });
  // Estimated heights are guesses; every rendered row reports its real height so
  // the window arithmetic matches the screen. Pruned to live keys each render so
  // a long session does not accumulate measurements for discarded rows.
  entryKeysRef.current = new Set(entries.map((e) => e.key));
  const heights = entries.map((e) => measured.get(e.key) ?? e.height);
  const layout = viewportLayout(heights, transcriptHeight, interaction.scroll);
  const drilled = interaction.viewing;
  const drilledRuns = drilled ? runsForKey(state.rows, keys, drilled.key) : [];
  const focused = interaction.focus >= 0;
  const page = Math.max(5, Math.floor(transcriptHeight / 2));

  const moveFocus = (delta: number): void => {
    const next = nextFocusable(entries, interaction.focus, delta);
    if (next < 0) return;
    dispatchInteraction({ type: "focus", index: next });
    const scroll = scrollToShow(heights, transcriptHeight, interaction.scroll, next);
    if (scroll !== interaction.scroll) dispatchInteraction({ type: "scroll-to", value: scroll });
  };

  /** Open a row: sub-agent entries drill in, collapsible ones flip. */
  const activate = (index: number): void => {
    const entry = entries[index];
    if (!entry) return;
    if (entry.drill) {
      dispatchInteraction({ type: "enter", key: entry.drill.key, run: entry.drill.run });
      return;
    }
    if (entry.interactive) dispatchInteraction({ type: "toggle", key: entry.key, open: entry.open });
  };

  useInput(
    (input, key) => {
      // Shift+Tab cycles the collaboration mode (Agent → Plan → Ask → …), the
      // same control the other clients expose as a mode switch.
      if (key.tab && key.shift) {
        void applyAgentMode(nextAgentMode(state.agentMode));
        return;
      }
      if (key.ctrl && input === "o") {
        setViewerOpen(true);
        return;
      }

      if (drilled) {
        const { maxScroll } = dialogWindow(drilledRuns[drilled.run], transcriptHeight);
        // Both keys the footer advertises close the dialog: Esc is muscle memory
        // from the prompt, Enter/Space match a confirm-shaped overlay.
        if (isEscape(input, key) || key.return || input === " ") {
          dispatchInteraction({ type: "back" });
        } else if (key.leftArrow) {
          dispatchInteraction({ type: "run", delta: -1, count: drilledRuns.length });
        } else if (key.rightArrow) {
          dispatchInteraction({ type: "run", delta: 1, count: drilledRuns.length });
        } else if (key.upArrow) {
          dispatchInteraction({ type: "scroll", delta: 1, max: maxScroll });
        } else if (key.downArrow) {
          dispatchInteraction({ type: "scroll", delta: -1, max: maxScroll });
        } else if (key.pageUp) {
          dispatchInteraction({ type: "scroll", delta: Math.max(1, transcriptHeight - 8), max: maxScroll });
        } else if (key.pageDown) {
          dispatchInteraction({ type: "scroll", delta: -Math.max(1, transcriptHeight - 8), max: maxScroll });
        }
        return;
      }

      // Tab hands the keyboard to the transcript and back. While the transcript
      // has it the prompt is disabled, so ↑/↓ mean the transcript in both places.
      if (key.tab) {
        dispatchInteraction({ type: "focus", index: focused ? -1 : lastFocusable(entries) });
        return;
      }
      if (focused) {
        if (isEscape(input, key)) {
          dispatchInteraction({ type: "focus", index: -1 });
          return;
        }
        if (key.upArrow) {
          moveFocus(-1);
          return;
        }
        if (key.downArrow) {
          moveFocus(1);
          return;
        }
        // Ink maps \r to `return` and \n to `enter`; PTYs and paste paths deliver
        // either, so accept both.
        if (key.return || input === "\n") {
          activate(interaction.focus);
          return;
        }
      }
      if (key.pageUp) dispatchInteraction({ type: "scroll", delta: -page, max: layout.window.maxScroll });
      if (key.pageDown) dispatchInteraction({ type: "scroll", delta: page, max: layout.window.maxScroll });
    },
    { isActive: !modalOpen && !viewerOpen },
  );

  // Clicks and the wheel. The frame is anchored at the top of the screen (cli.tsx
  // clears before the first paint), so a mouse row maps straight to a viewport
  // line without any scroll-offset bookkeeping.
  const mouseRef = React.useRef<(e: TermMouseEvent) => void>(() => {});
  mouseRef.current = (e) => {
    // The help panel routes its own clicks and wheel; letting the wheel through
    // here too would scroll the transcript hidden underneath it.
    if (showHelp) return;
    if (e.action === "release" || e.button === "none") return;
    if (e.button === "wheelUp" || e.button === "wheelDown") {
      const delta = (e.button === "wheelUp" ? 3 : -3) * (e.shift ? 3 : 1);
      dispatchInteraction({ type: "scroll", delta, max: layout.window.maxScroll });
      return;
    }
    if (e.button !== "left" || modalOpen || viewerOpen) return;
    const index = entryAtScreenY(heights, layout, e.y);
    if (index < 0) return;
    dispatchInteraction({ type: "focus", index });
    activate(index);
  };
  React.useEffect(() => onTermMouse((e) => mouseRef.current(e)), []);

  const transcript = drilled ? (
    <AgentDialog
      runs={drilledRuns}
      index={drilled.run}
      height={transcriptHeight}
      width={size.cols}
      scroll={interaction.scroll}
    />
  ) : (
    <TranscriptViewport
      entries={entries}
      heights={heights}
      height={transcriptHeight}
      scroll={interaction.scroll}
      onMeasure={onMeasure}
    />
  );

  if (viewerOpen) {
    return (
      <Box flexDirection="column" width="100%" height={Math.max(6, size.rows - 1)}>
        <ToolViewer
          rows={state.rows}
          width={size.cols}
          height={Math.max(6, size.rows - 1)}
          onClose={() => setViewerOpen(false)}
        />
      </Box>
    );
  }

  if (showHelp) {
    return (
      <Box flexDirection="column" width="100%" height={Math.max(6, size.rows - 1)} overflow="hidden">
        <HelpPanel
          width={size.cols}
          height={Math.max(6, size.rows - 1)}
          version={VERSION}
          model={state.model}
          onClose={() => setShowHelp(false)}
          onInsert={(command) => {
            setShowHelp(false);
            dispatch({ type: "set-input", value: command });
          }}
        />
      </Box>
    );
  }

  return (
    // Hard cap one row above the terminal height. The transcript height is an
    // estimate until the chrome is measured, and any frame whose output reaches
    // the terminal height makes Ink emit clearTerminal (2J 3J) — which also wipes
    // the scrollback. Clipping a row is recoverable; losing history is not.
    <Box flexDirection="column" width="100%" height={Math.max(4, size.rows - 1)} overflow="hidden">
      {transcript}

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
            preview={pendingPerm.preview}
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
