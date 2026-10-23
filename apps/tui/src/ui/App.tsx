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
import { Box, Text, useInput } from "ink";
import {
  type AgentMode,
  type Event,
  type PermissionDecision,
  type PermissionMode,
  type Session,
  type SlashCommand,
  killAllJobs,
  discoverSlashCommands,
  describeMcp,
  formatMcp,
  describeHooks,
  formatHooks,
  describeAgents,
  formatAgents,
  describeSkills,
  formatSkills,
  formatContext,
  discoverPlugins,
  sameCwd,
  exportSession,
  type RichSessionSummary,
} from "@codepilot/core";
import { writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { BlockView } from "./EventView.js";
import { InputBox } from "./InputBox.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { ConnectWizard } from "./ConnectWizard.js";
import { ModelPicker } from "./ModelPicker.js";
import { SelectMenu, TextPrompt, type SelectOption } from "./SelectMenu.js";
import { StatusBar } from "./StatusBar.js";
import { Spinner } from "./Spinner.js";
import { initialState, reducer, type TuiState } from "./state.js";
import { CATEGORY_ACTIVE, brand, color, glyph, shortPath } from "./theme.js";
import { groupRows, planProgress, runningTool } from "./transcript.js";
import {
  isCommand,
  runCommandWithCustom,
  buildCommandList,
  BUILTIN_COMMAND_NAMES,
} from "./commands.js";
import type { PermissionBridge, QuestionBridge, SessionController } from "./controller.js";

export interface AppProps {
  session: Session;
  controller: SessionController;
  permissionBridge: PermissionBridge;
  questionBridge: QuestionBridge;
  cwd: string;
  model: string | undefined;
  permissionMode: PermissionMode;
  initialAgentMode: AgentMode;
  initialPrompt?: string | undefined;
}

/**
 * Event-log viewport scroll state.
 *
 * Ink has no real scrollback: the terminal's scrollbar scrolls the *frame
 * buffer* (stale re-renders), not the event history — so mouse-wheeling up
 * shows garbled old frames and the next render "snaps back" to the bottom.
 * The honest fix is an application-level viewport: we render a window of
 * rows starting at `offset` (measured from the end; 0 = pinned to bottom),
 * adjusted by PgUp/PgDn (and Shift+↑/↓). Any new content while pinned keeps
 * us pinned; scrolling up unpins until the user pages back down to 0.
 */
export interface ScrollState {
 /** Rows from the bottom; 0 = following live output. */
  offset: number;
}

export function App(props: AppProps): React.ReactElement {
  const {
    session: initialSession,
    controller,
    permissionBridge,
    questionBridge,
    cwd,
    model,
    permissionMode,
    initialAgentMode,
    initialPrompt,
  } = props;

 // Live session can be swapped by /resume without restarting the TUI.
  const [session, setSession] = React.useState(initialSession);

  const [state, dispatch] = React.useReducer(reducer, undefined, () =>
    initialState({
      sessionId: initialSession.id,
      cwd,
      model,
      permissionMode,
      agentMode: initialAgentMode,
    }),
  );

 // Custom slash commands discovered from .codepilot/commands/*.md and
 // ~/.codepilot/commands/*.md. Discovered once on mount (and re-discovered
 // when cwd changes). Built-in command names are reserved so custom files
 // can't shadow them.
  const [customCommands, setCustomCommands] = React.useState<SlashCommand[]>([]);
  const [showConnect, setShowConnect] = React.useState(false);
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
  React.useEffect(() => {
    return session.subscribe((ev: Event) => {
      dispatch({ type: "event", event: ev });
      if (ev.type === "status" && ev.status === "idle") {
        dispatch({ type: "set-busy", busy: false });
      }
    });
  }, [session]);

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

 // 2c. Another client following the same server session answered first.
  React.useEffect(() => {
    const offP = permissionBridge.onDismiss((requestId) => dispatch({ type: "permission-resolve", requestId }));
    const offQ = questionBridge.onDismiss((requestId) => dispatch({ type: "question-resolve", requestId }));
    return () => {
      offP();
      offQ();
    };
  }, [permissionBridge, questionBridge]);

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
    (decision: PermissionDecision) => {
      const pending = state.permission;
      if (pending !== undefined) {
        permissionBridge.resolve(pending.requestId, decision);
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
          next = await core.createSession({
            cwd: resumeCwd,
            config,
            sessionId: id,
            onPermissionRequest: (req) => permissionBridge.waitDecision(req),
            onAskUser: (req) => questionBridge.waitAnswers(req),
          });
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
      dispatch({
        type: "set-notice",
        text: `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, [loadResumeSessions, resumeSessionById, session.id]);

 // 3. Submit handler.
  const doSubmit = React.useCallback(
    async (text: string, delivery: "auto" | "steer" = "auto") => {
      if (isCommand(text)) {
        const result = runCommandWithCustom(text, { controller, cwd }, customCommands);
        switch (result.kind) {
          case "noop":
            return;
          case "system":
            dispatch({ type: "set-notice", text: result.text });
            return;
          case "unknown-command":
            dispatch({ type: "set-notice", text: `Unknown command: /${result.name}. Try /help.` });
            return;
          case "submit-prompt":
            text = result.text;
            break;
          case "custom-command": {
 // A custom slash command: send the rendered prompt to the
 // session. Apply optional model + allowed-tools overrides for
 // this turn only (turn-scoped override semantics — the session clears
 // them in prompt's finally block).
            try {
              if (result.model || result.allowedTools) {
                session.setTurnOverrides({
                  model: result.model,
                  allowedTools: result.allowedTools,
                });
              }
              dispatch({ type: "set-busy", busy: true });
              dispatch({ type: "set-status", status: "thinking" });
              const overrideNote =
                result.model && result.allowedTools
                  ? ` (model: ${result.model}, tools: ${result.allowedTools.join(", ")})`
                  : result.model
                    ? ` (model: ${result.model})`
                    : result.allowedTools
                      ? ` (tools: ${result.allowedTools.join(", ")})`
                      : "";
              dispatch({
                type: "set-notice",
                text: `/${result.commandName}${overrideNote}`,
              });
              await session.prompt(result.prompt);
            } catch (err: unknown) {
              dispatch({
                type: "set-notice",
                text: `Custom command failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            } finally {
              dispatch({ type: "set-busy", busy: false });
              dispatch({ type: "set-status", status: "idle" });
            }
            return;
          }
          case "connect": {
            setShowConnect(true);
            return;
          }
          case "list-models": {
            try {
              const { listSelectableModels } = await import("@codepilot/core");
              const models = listSelectableModels(session.getConfig()).filter(
                (m) => m.kind === "chat",
              );
              if (models.length === 0) {
                dispatch({
                  type: "set-notice",
                  text: "No selectable models — run /connect to add a provider",
                });
              } else {
                setModelPickerRows(models);
                setShowModelPicker(true);
              }
            } catch (err: unknown) {
              dispatch({
                type: "set-notice",
                text: `Failed to list models: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            return;
          }
          case "set-model": {
            try {
              const { resolveModelTarget } = await import("@codepilot/core");
              const resolved = resolveModelTarget(session.getConfig(), result.model);
              await session.setModel(resolved.model, resolved.providerId);
              const pid = session.getProviderId();
              const label = pid ? `${pid}/${session.getModel()}` : session.getModel();
              dispatch({ type: "set-model", model: session.getModel(), providerId: pid });
              dispatch({ type: "set-notice", text: `Model set to ${label}` });
            } catch (err: unknown) {
              dispatch({
                type: "set-notice",
                text: `Failed to set model: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            return;
          }
          case "pick-provider": {
            const providers =
              (session.getConfig() as { providers?: Record<string, { displayName?: string; model?: string }> })
                .providers ?? {};
            const options: SelectOption[] = Object.entries(providers).map(([id, p]) => ({
              value: id,
              label: p.displayName ?? id,
              description: p.model ?? id,
            }));
            if (options.length === 0) {
              dispatch({
                type: "set-notice",
                text: "No providers configured — run /connect first",
              });
              return;
            }
            setSelectOverlay({
              title: "/provider",
              options,
              current: session.getProviderId(),
              onPick: (id) => {
                setSelectOverlay(null);
                void applyProvider(id);
              },
            });
            return;
          }
          case "set-provider": {
            await applyProvider(result.providerId);
            return;
          }
          case "pick-mode": {
            setSelectOverlay({
              title: "/mode  (permission)",
              current: state.permissionMode,
              options: [
                { value: "ask", label: "ask", description: "prompt for every tool" },
                { value: "auto-edit", label: "auto-edit", description: "prompt for writes only" },
                { value: "yolo", label: "yolo", description: "never prompt" },
              ],
              onPick: (mode) => {
                setSelectOverlay(null);
                applyPermissionMode(mode as "ask" | "auto-edit" | "yolo");
              },
            });
            return;
          }
          case "set-mode":
            applyPermissionMode(result.mode);
            return;
          case "pick-agent": {
            setSelectOverlay({
              title: "/agent  (collaboration)",
              current: state.agentMode,
              options: [
                { value: "chat", label: "chat", description: "read-only Q&A" },
                { value: "plan", label: "plan", description: "read + plan_update" },
                { value: "agent", label: "agent", description: "full autonomy" },
              ],
              onPick: (mode) => {
                setSelectOverlay(null);
                void applyAgentMode(mode as AgentMode);
              },
            });
            return;
          }
          case "set-agent-mode": {
            await applyAgentMode(result.mode);
            return;
          }
          case "pick-session": {
            await openSessionPicker();
            return;
          }
          case "pick-goal": {
            setTextOverlay({
              title: "/goal",
              placeholder: "Describe the long-running objective…",
              onSubmit: (objective) => {
                setTextOverlay(null);
                void runGoal(objective);
              },
            });
            return;
          }
          case "show-plan": {
            const plan = state.plan;
            dispatch({
              type: "set-notice",
              text:
                plan === undefined
                  ? "(no plan yet)"
                  : plan.map((s, i) => `${i + 1}. [${s.status}] ${s.title}`).join("\n"),
            });
            return;
          }
          case "retry": {
            const last = [...state.rows].reverse().find((r) => r.kind === "user");
            if (last?.kind !== "user" || last.text.trim() === "") {
              dispatch({ type: "set-notice", text: "Nothing to retry yet." });
              return;
            }
            text = last.text;
            break;
          }
          case "compact":
            dispatch({
              type: "set-notice",
              text: "Manual compaction requested — if core supports it, look for a status:compacting event shortly.",
            });
            return;
          case "list-sessions": {
            await openSessionPicker();
            return;
          }
          case "resume":
            await resumeSessionById(result.sessionId);
            return;
          case "goal":
            await runGoal(result.objective);
            return;
          case "clear":
            dispatch({ type: "clear" });
            dispatch({ type: "set-notice", text: "Cleared." });
            return;
          case "show-mcp": {
            try {
              const summary = describeMcp(session.getMcpManager());
              dispatch({ type: "set-notice", text: formatMcp(summary) });
            } catch (err: unknown) {
              dispatch({ type: "set-notice", text: `Failed to query MCP: ${err instanceof Error ? err.message : String(err)}` });
            }
            return;
          }
          case "show-hooks": {
            try {
              const summary = describeHooks(session.getHookEngine());
              dispatch({ type: "set-notice", text: formatHooks(summary) });
            } catch (err: unknown) {
              dispatch({ type: "set-notice", text: `Failed to query hooks: ${err instanceof Error ? err.message : String(err)}` });
            }
            return;
          }
          case "show-agents": {
            try {
              const summary = await describeAgents(session.getCwd());
              dispatch({ type: "set-notice", text: formatAgents(summary) });
            } catch (err: unknown) {
              dispatch({ type: "set-notice", text: `Failed to query agents: ${err instanceof Error ? err.message : String(err)}` });
            }
            return;
          }
          case "show-skills": {
            try {
              const summary = await describeSkills(session.getCwd());
              dispatch({ type: "set-notice", text: formatSkills(summary) });
            } catch (err: unknown) {
              dispatch({ type: "set-notice", text: `Failed to query skills: ${err instanceof Error ? err.message : String(err)}` });
            }
            return;
          }
          case "show-context": {
            try {
              const report = session.contextReport();
              dispatch({ type: "set-notice", text: formatContext(report) });
            } catch (err: unknown) {
              dispatch({ type: "set-notice", text: `Failed to query context: ${err instanceof Error ? err.message : String(err)}` });
            }
            return;
          }
          case "show-plugins": {
            try {
              const plugins = await discoverPlugins(session.getCwd());
              if (plugins.size === 0) {
                dispatch({ type: "set-notice", text: "No plugins installed. Install with: codepilot plugin install <git-url>. Plugins live in ~/.codepilot/plugins/." });
              } else {
                const lines: string[] = [`Plugins (${plugins.size}):`];
                for (const p of plugins.values()) {
                  lines.push(`  ${p.manifest.name} v${p.manifest.version} [${p.source}]`);
                  lines.push(`    ${p.manifest.description}`);
                }
                dispatch({ type: "set-notice", text: lines.join("\n") });
              }
            } catch (err: unknown) {
              dispatch({ type: "set-notice", text: `Failed to query plugins: ${err instanceof Error ? err.message : String(err)}` });
            }
            return;
          }
          case "export": {
            try {
              const body = await exportSession(session.id, result.format);
              const ext = result.format === "jsonl" ? "jsonl" : "md";
              const dest = resolvePath(
                cwd,
                result.outPath ?? `codepilot-session-${session.id}.${ext}`,
              );
              await writeFile(dest, body, "utf-8");
              dispatch({ type: "set-notice", text: `Exported ${result.format} → ${dest}` });
            } catch (err: unknown) {
              dispatch({
                type: "set-notice",
                text: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            return;
          }
          case "exit":
            setExitPending(true);
            return;
        }
      }
 // Real prompt dispatch.
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
      applyAgentMode,
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
      await killAllJobs().catch(() => {});
 // Compact the persistent prompt history on the way out.
      try {
        const { compactHistory } = await import("./history.js");
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
 // Event-log viewport scroll (see ScrollState above). PgUp/PgDn and
 // Shift+↑/↓ adjust the offset; the InputBox keeps focus for everything
 // else. These keys are global to the App so they work even while a prompt
 // is streaming.
 // ---------------------------------------------------------------------------
  const [scroll, setScroll] = React.useState<ScrollState>({ offset: 0 });

  useInput(
    (_input, key) => {
      const pageSize = 10; // rows per PgUp/PgDn; cheap and predictable
      if (key.pageUp) {
        setScroll((s) => ({
          offset: Math.min(s.offset + pageSize, Math.max(0, state.rows.length - 1)),
        }));
        return;
      }
      if (key.pageDown) {
        setScroll((s) => ({ offset: Math.max(0, s.offset - pageSize) }));
        return;
      }
 // Shift+arrows as the fine-grained fallback (some terminals map these).
      if (key.shift && key.upArrow) {
        setScroll((s) => ({
          offset: Math.min(s.offset + 1, Math.max(0, state.rows.length - 1)),
        }));
        return;
      }
      if (key.shift && key.downArrow) {
        setScroll((s) => ({ offset: Math.max(0, s.offset - 1) }));
        return;
      }
    },
 // Only intercept when no modal prompt owns the keyboard.
    {
      isActive:
        pendingPerm === undefined &&
        pendingQuestion === undefined &&
        !showConnect &&
        !showModelPicker &&
        selectOverlay === null &&
        textOverlay === null,
    },
  );

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Header cwd={state.cwd} state={state} />

      {/* Event log */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1}>
        <ScrollArea rows={state.rows} offset={scroll.offset} />
      </Box>
      {scroll.offset > 0 ? (
        <Box paddingX={1}>
          <Text color={color.warn}>
            {glyph.warn} scrolled up — {scroll.offset} row{scroll.offset === 1 ? "" : "s"} above the live edge · PgDn / Shift+↓ to follow
          </Text>
        </Box>
      ) : null}

      {state.notice !== undefined ? (
        <Box paddingX={1} marginTop={1}>
          <Text color={color.info}>{glyph.bar} </Text>
          <Box flexGrow={1}>
            <Text>{state.notice}</Text>
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
              void (async () => {
                try {
                  const { loadConfigWithSources } = await import("@codepilot/core");
                  const { config } = await loadConfigWithSources(cwd);
                  session.mergeProviders(config.providers ?? {});
                  await session.setProvider(result.id, result.model);
                  dispatch({
                    type: "set-model",
                    model: session.getModel(),
                    providerId: session.getProviderId() ?? result.id,
                  });
                  dispatch({
                    type: "set-notice",
                    text: `Connected ${result.id} · ${result.model}\nUse /model to switch models.`,
                  });
                } catch (err: unknown) {
                  dispatch({
                    type: "set-notice",
                    text: `Connected but switch failed: ${err instanceof Error ? err.message : String(err)}`,
                  });
                }
              })();
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
        <Box paddingX={1} marginY={1}>
          <InputBox
            value={state.input}
            onChange={(v) => dispatch({ type: "set-input", value: v })}
            onSubmit={(t, delivery) => {
              dispatch({ type: "set-input", value: "" });
              void doSubmit(t, delivery);
            }}
            onCancel={doCancel}
            disabled={!!state.permission || !!state.question}
            busy={state.busy}
            cwd={cwd}
            commands={commandList}
            placeholder={
              state.busy
                ? "Working… Enter queues · Ctrl+Enter injects · Ctrl+C cancels."
                : "Type a message. / commands · @ files · Ctrl+R history · Ctrl+K palette."
            }
          />
        </Box>
      )}

      {/* Status bar */}
      <StatusBar
        state={state}
        statusLineConfig={session.getStatusLineConfig()}
        cwd={cwd}
        version="2.0.0"
      />

      {state.busy ? (
        <Box paddingX={1}>
          <Spinner
            color={color.accent}
            label={activityLabel(state)}
            since={state.status === "thinking" ? state.activity?.since : undefined}
          />
          <Text color={color.faint}> {glyph.dot} Ctrl+C to stop</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Header({ cwd, state }: { cwd: string; state: TuiState }): React.ReactElement {
  const { done, total } = planProgress(state.plan);
  return (
    <Box paddingX={1} marginBottom={1}>
      <Text bold>
        <Text color={brand[0]}>{glyph.logo} </Text>
        <Text color={brand[0]}>Code</Text>
        <Text color={brand[2]}>Pilot</Text>
      </Text>
      <Text color={color.faint}>  {shortPath(cwd)}</Text>
      {total > 0 ? (
        <Text color={color.faint}>
          {"  "}
          {glyph.dot} plan {done}/{total}
        </Text>
      ) : null}
    </Box>
  );
}

/** What the agent is doing right now, in the same words as the other clients. */
function activityLabel(state: TuiState): string {
  switch (state.status) {
    case "compacting":
      return "Compacting context…";
    case "waiting_permission":
      return "Waiting for your approval…";
    case "waiting_question":
      return "Waiting for your answer…";
  }
  const tool = runningTool(state.rows);
  if (tool) {
    const verb = tool.category === "other" ? `Calling ${tool.name}` : CATEGORY_ACTIVE[tool.category];
    return tool.target ? `${verb} ${tool.target}` : `${verb}…`;
  }
  if (state.activity?.phase === "model") return "Waiting for model response";
  const current = planProgress(state.plan).current;
  return current ? `Thinking ${glyph.dot} ${current.title}` : "Thinking…";
}

/**
 * ScrollArea — renders rows in order. We cap the visible window to avoid
 * unbounded memory in long sessions; full history stays in core's session log.
 *
 * `offset` selects which slice of the (already capped) row list is shown:
 * offset 0 renders the tail (live edge), offset N renders the window ending
 * N rows earlier. This is the application's *own* viewport — the terminal
 * scrollback is unusable under Ink's full-screen repaints.
 */
const MAX_RENDERED_ROWS = 500;

function ScrollArea({ rows, offset }: { rows: TuiState["rows"]; offset: number }): React.ReactElement {
  const capped =
    rows.length > MAX_RENDERED_ROWS ? rows.slice(rows.length - MAX_RENDERED_ROWS) : rows;
  const end = Math.max(1, capped.length - offset);
 // Keep the window a fixed size so paging feels stable.
  const WINDOW = 100;
  const start = Math.max(0, end - WINDOW);
  const visible = capped.slice(start, end);
  return (
    <Box flexDirection="column">
      {rows.length > MAX_RENDERED_ROWS ? (
        <Text color={color.faint}>… {rows.length - MAX_RENDERED_ROWS} earlier rows hidden</Text>
      ) : null}
      {start > 0 ? (
        <Text color={color.faint}>… {start} more rows above · PgUp to see them</Text>
      ) : null}
      {groupRows(visible).map((b) => (
        <BlockView key={b.key} block={b} />
      ))}
    </Box>
  );
}
