import type React from "react";
/**
 * Slash-command result dispatch (extracted from App doSubmit).
 */
import { writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type {
  AgentMode,
  PermissionMode,
  PermissionPresetName,
  Session,
  SlashCommand,
} from "@codepilot/core";
import {
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
  exportSession,
} from "@codepilot/core";

import { isCommand, runCommandWithCustom } from "../commands.js";
import type { PermissionBridge, QuestionBridge, SessionController } from "../controller.js";
import type { SelectOption } from "../SelectMenu.js";
import type { TuiAction, TuiState } from "../state.js";
import { THEME_LABELS, THEME_NAMES, type ThemeName } from "../themes.js";
import { activeTheme } from "../theme.js";
import { PRESET_OPTIONS } from "./types.js";

export type SlashCommandDone = { kind: "done" };
export type SlashCommandPrompt = { kind: "prompt"; text: string };
export type SlashCommandOutcome = SlashCommandDone | SlashCommandPrompt;

export interface SelectOverlayState {
  title: string;
  options: SelectOption[];
  current?: string;
  emptyText?: string;
  onPick: (value: string) => void;
}

export interface TextOverlayState {
  title: string;
  placeholder?: string;
  onSubmit: (text: string) => void;
}

export interface SlashCommandHost {
  session: Session;
  controller: SessionController;
  cwd: string;
  customCommands: SlashCommand[];
  state: Pick<TuiState, "permissionMode" | "agentMode" | "plan" | "rows" | "busy">;
  dispatch: React.Dispatch<TuiAction>;
  permissionBridge: PermissionBridge;
  questionBridge: QuestionBridge;
  webServerRef: React.MutableRefObject<import("@codepilot/protocol/ws").WebSocketServerHandle | null>;
  setShowConnect: (show: boolean) => void;
  setShowSetup: (show: boolean) => void;
  setModelPickerRows: (rows: import("@codepilot/core").SelectableModel[]) => void;
  setShowModelPicker: (show: boolean) => void;
  setSelectOverlay: (overlay: SelectOverlayState | null) => void;
  setTextOverlay: (overlay: TextOverlayState | null) => void;
  /** Open the full-screen help panel (/help). */
  setShowHelp: (show: boolean) => void;
  setHistoryEpoch: React.Dispatch<React.SetStateAction<number>>;
  setExitPending: (pending: boolean) => void;
  setController: React.Dispatch<React.SetStateAction<SessionController>>;
  setSession: React.Dispatch<React.SetStateAction<Session>>;
  applyProvider: (providerId: string) => Promise<void>;
  applyPermissionMode: (mode: PermissionMode) => void;
  applyPreset: (name: PermissionPresetName) => void;
  applyAgentMode: (mode: AgentMode) => Promise<void>;
  applyTheme: (name: ThemeName) => void;
  applyVim: (enabled?: boolean) => void;
  openSessionPicker: () => Promise<void>;
  runGoal: (objective: string) => Promise<void>;
  resumeSessionById: (id: string) => Promise<void>;
}

export async function executeSlashCommand(
  text: string,
  host: SlashCommandHost,
): Promise<SlashCommandOutcome | null> {
  if (!isCommand(text)) return null;
  const result = runCommandWithCustom(text, { controller: host.controller, cwd: host.cwd }, host.customCommands);
  switch (result.kind) {
    case "noop":
      return { kind: "done" };
            case "system":
              host.dispatch({ type: "set-notice", text: result.text });
              return { kind: "done" };
            case "help":
              host.setShowHelp(true);
              return { kind: "done" };
            case "unknown-command":
              host.dispatch({ type: "set-notice", text: `Unknown command: /${result.name}. Try /help.` });
              return { kind: "done" };
            case "submit-prompt":
              return { kind: "prompt", text: result.text };
            case "custom-command": {
   // A custom slash command: send the rendered prompt to the
   // host.session. Apply optional model + allowed-tools overrides for
   // this turn only (turn-scoped override semantics — the host.session clears
   // them in prompt's finally block). MCP prompt commands expand via
   // prompts/get before the turn.
              try {
                let promptText = result.prompt;
                if (result.mcpPrompt) {
                  const { expandMcpPromptCommand } = await import("@codepilot/core");
                  const mcp = host.session.getMcpManager();
                  if (!mcp) {
                    host.dispatch({
                      type: "set-notice",
                      text: `MCP not ready — cannot expand /${result.commandName}`,
                    });
                    return { kind: "done" };
                  }
                  promptText = await expandMcpPromptCommand(
                    {
                      name: result.commandName,
                      description: "",
                      path: "",
                      source: "mcp",
                      body: "",
                      mcpPrompt: result.mcpPrompt,
                    },
                    result.args ?? "",
                    mcp,
                  );
                }
                if (result.model || result.allowedTools) {
                  host.session.setTurnOverrides({
                    model: result.model,
                    allowedTools: result.allowedTools,
                  });
                }
                host.dispatch({ type: "set-busy", busy: true });
                host.dispatch({ type: "set-status", status: "thinking" });
                const overrideNote =
                  result.model && result.allowedTools
                    ? ` (model: ${result.model}, tools: ${result.allowedTools.join(", ")})`
                    : result.model
                      ? ` (model: ${result.model})`
                      : result.allowedTools
                        ? ` (tools: ${result.allowedTools.join(", ")})`
                        : "";
                host.dispatch({
                  type: "set-notice",
                  text: `/${result.commandName}${overrideNote}`,
                });
                await host.session.prompt(promptText);
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: `Custom command failed: ${err instanceof Error ? err.message : String(err)}`,
                });
              } finally {
                host.dispatch({ type: "set-busy", busy: false });
                host.dispatch({ type: "set-status", status: "idle" });
              }
              return { kind: "done" };
            }
            case "connect": {
              host.setShowConnect(true);
              return { kind: "done" };
            }
            case "setup": {
              host.setShowSetup(true);
              return { kind: "done" };
            }
            case "list-models": {
              try {
                const { listSelectableModels } = await import("@codepilot/core");
                const models = listSelectableModels(host.session.getConfig()).filter(
                  (m) => m.kind === "chat",
                );
                if (models.length === 0) {
                  host.dispatch({
                    type: "set-notice",
                    text: "No selectable models — run /connect to add a provider",
                  });
                } else {
                  host.setModelPickerRows(models);
                  host.setShowModelPicker(true);
                }
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: `Failed to list models: ${err instanceof Error ? err.message : String(err)}`,
                });
              }
              return { kind: "done" };
            }
            case "set-model": {
              try {
                const { resolveModelTarget } = await import("@codepilot/core");
                const resolved = resolveModelTarget(host.session.getConfig(), result.model);
                await host.session.setModel(resolved.model, resolved.providerId);
                const pid = host.session.getProviderId();
                const label = pid ? `${pid}/${host.session.getModel()}` : host.session.getModel();
                host.dispatch({ type: "set-model", model: host.session.getModel(), providerId: pid });
                host.dispatch({ type: "set-notice", text: `Model set to ${label}` });
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: `Failed to set model: ${err instanceof Error ? err.message : String(err)}`,
                });
              }
              return { kind: "done" };
            }
            case "pick-provider": {
              const providers =
                (host.session.getConfig() as { providers?: Record<string, { displayName?: string; model?: string }> })
                  .providers ?? {};
              const options: SelectOption[] = Object.entries(providers).map(([id, p]) => ({
                value: id,
                label: p.displayName ?? id,
                description: p.model ?? id,
              }));
              if (options.length === 0) {
                host.dispatch({
                  type: "set-notice",
                  text: "No providers configured — run /connect first",
                });
                return { kind: "done" };
              }
              host.setSelectOverlay({
                title: "/provider",
                options,
                current: host.session.getProviderId(),
                onPick: (id) => {
                  host.setSelectOverlay(null);
                  void host.applyProvider(id);
                },
              });
              return { kind: "done" };
            }
            case "set-provider": {
              await host.applyProvider(result.providerId);
              return { kind: "done" };
            }
            case "pick-mode": {
              host.setSelectOverlay({
                title: "/mode  (permission)",
                current: host.state.permissionMode,
                options: [
                  { value: "ask", label: "ask", description: "prompt for every tool" },
                  { value: "auto-edit", label: "auto-edit", description: "prompt for writes only" },
                  { value: "yolo", label: "yolo", description: "never prompt" },
                ],
                onPick: (mode) => {
                  host.setSelectOverlay(null);
                  host.applyPermissionMode(mode as "ask" | "auto-edit" | "yolo");
                },
              });
              return { kind: "done" };
            }
            case "set-mode":
              host.applyPermissionMode(result.mode);
              return { kind: "done" };
            case "pick-preset": {
              host.setSelectOverlay({
                title: "/preset  (permission + sandbox)",
                options: PRESET_OPTIONS,
                onPick: (name) => {
                  host.setSelectOverlay(null);
                  host.applyPreset(name as PermissionPresetName);
                },
              });
              return { kind: "done" };
            }
            case "set-preset":
              host.applyPreset(result.name);
              return { kind: "done" };
            case "pick-agent": {
              host.setSelectOverlay({
                title: "/agent  (collaboration)",
                current: host.state.agentMode,
                options: [
                  { value: "chat", label: "chat", description: "read-only Q&A" },
                  { value: "plan", label: "plan", description: "read + plan" },
                  { value: "agent", label: "agent", description: "full autonomy" },
                ],
                onPick: (mode) => {
                  host.setSelectOverlay(null);
                  void host.applyAgentMode(mode as AgentMode);
                },
              });
              return { kind: "done" };
            }
            case "set-agent-mode": {
              await host.applyAgentMode(result.mode);
              return { kind: "done" };
            }
            case "pick-theme": {
              host.setSelectOverlay({
                title: "/theme  (colour palette)",
                current: activeTheme,
                options: THEME_NAMES.map((name) => ({
                  value: name,
                  label: THEME_LABELS[name],
                  description:
                    name === "default"
                      ? "built-in CodePilot palette"
                      : `${name} colours`,
                })),
                onPick: (name) => {
                  host.setSelectOverlay(null);
                  host.applyTheme(name as ThemeName);
                },
              });
              return { kind: "done" };
            }
            case "set-theme": {
              host.applyTheme(result.name as ThemeName);
              return { kind: "done" };
            }
            case "set-vim": {
              host.applyVim(result.enabled);
              return { kind: "done" };
            }
            case "pick-session": {
              await host.openSessionPicker();
              return { kind: "done" };
            }
            case "pick-goal": {
              host.setTextOverlay({
                title: "/goal",
                placeholder: "Describe the long-running objective…",
                onSubmit: (objective) => {
                  host.setTextOverlay(null);
                  void host.runGoal(objective);
                },
              });
              return { kind: "done" };
            }
            case "show-plan": {
              const plan = host.state.plan;
              host.dispatch({
                type: "set-notice",
                text:
                  plan === undefined
                    ? "(no plan yet)"
                    : plan.map((s, i) => `${i + 1}. [${s.status}] ${s.title}`).join("\n"),
              });
              return { kind: "done" };
            }
            case "retry": {
              const last = [...host.state.rows].reverse().find((r) => r.kind === "user");
              if (last?.kind !== "user" || last.text.trim() === "") {
                host.dispatch({ type: "set-notice", text: "Nothing to retry yet." });
                return { kind: "done" };
              }
              // Prefer resume (no new user bubble). Never fall back to re-sending
              // when the transcript still ends in an error — that duplicates the
              // user message (same bug the web Retry path had).
              const s = host.session as {
                canResumeLastTurn?: () => boolean;
                resumeLastTurn?: () => Promise<"started" | "queued" | "noop">;
              };
              const tail = host.state.rows[host.state.rows.length - 1];
              if (
                typeof s.resumeLastTurn === "function" &&
                (typeof s.canResumeLastTurn !== "function" || s.canResumeLastTurn())
              ) {
                host.dispatch({ type: "set-busy", busy: true });
                host.dispatch({ type: "set-status", status: "thinking" });
                try {
                  const r = await s.resumeLastTurn();
                  if (r !== "noop") return { kind: "done" };
                } catch {
                  host.dispatch({
                    type: "set-notice",
                    text: "Could not resume the last turn.",
                  });
                  return { kind: "done" };
                }
              }
              if (tail?.kind === "error") {
                host.dispatch({
                  type: "set-notice",
                  text: "Resume unavailable for this error. Send a new message to continue.",
                });
                return { kind: "done" };
              }
              return { kind: "prompt", text: last.text };
            }
            case "compact": {
              // Manual compaction, same task. An optional focus tells the
              // summariser what to preserve this run.
              const focus = result.focus;
              host.dispatch({
                type: "set-notice",
                text: focus
                  ? `Compacting conversation (focus: ${focus})…`
                  : "Compacting conversation…",
              });
              try {
                await host.session.compact(focus);
                host.dispatch({ type: "set-notice", text: "Compacted." });
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
                });
              }
              return { kind: "done" };
            }
            case "list-sessions": {
              await host.openSessionPicker();
              return { kind: "done" };
            }
            case "resume":
              await host.resumeSessionById(result.sessionId);
              return { kind: "done" };
            case "goal":
              await host.runGoal(result.objective);
              return { kind: "done" };
            case "clear": {
              // Archive the model-facing working context (task boundary), then
              // clear the visible log. Without the core call, /clear was purely
              // cosmetic — the model still saw the whole prior transcript.
              let archived = false;
              try {
                archived = await host.session.clearWorkingContext("user ran /clear");
              } catch {
                /* fall back to UI-only clear */
              }
              host.dispatch({ type: "clear" });
              host.dispatch({
                type: "set-notice",
                text: archived
                  ? "Cleared — prior context archived; starting fresh (full transcript kept on disk)."
                  : "Cleared.",
              });
              return { kind: "done" };
            }
            case "show-mcp": {
              try {
                const summary = describeMcp(host.session.getMcpManager());
                host.dispatch({ type: "set-notice", text: formatMcp(summary) });
              } catch (err: unknown) {
                host.dispatch({ type: "set-notice", text: `Failed to query MCP: ${err instanceof Error ? err.message : String(err)}` });
              }
              return { kind: "done" };
            }
            case "show-hooks": {
              try {
                const summary = describeHooks(host.session.getHookEngine());
                host.dispatch({ type: "set-notice", text: formatHooks(summary) });
              } catch (err: unknown) {
                host.dispatch({ type: "set-notice", text: `Failed to query hooks: ${err instanceof Error ? err.message : String(err)}` });
              }
              return { kind: "done" };
            }
            case "show-agents": {
              try {
                const summary = await describeAgents(host.session.getCwd());
                host.dispatch({ type: "set-notice", text: formatAgents(summary) });
              } catch (err: unknown) {
                host.dispatch({ type: "set-notice", text: `Failed to query agents: ${err instanceof Error ? err.message : String(err)}` });
              }
              return { kind: "done" };
            }
            case "show-skills": {
              try {
                const summary = await describeSkills(host.session.getCwd());
                host.dispatch({ type: "set-notice", text: formatSkills(summary) });
              } catch (err: unknown) {
                host.dispatch({ type: "set-notice", text: `Failed to query skills: ${err instanceof Error ? err.message : String(err)}` });
              }
              return { kind: "done" };
            }
            case "show-context": {
              try {
                const report = host.session.contextReport();
                let text = formatContext(report);
                if (result.precise) {
                  const precise = await host.session.preciseContextCount();
                  text += precise
                    ? `\n  precise (provider count): ${precise.inputTokens.toLocaleString()} tokens`
                    : `\n  precise count unavailable (set context.preciseCount: "on-demand" and use a provider that supports it)`;
                }
                host.dispatch({ type: "set-notice", text });
              } catch (err: unknown) {
                host.dispatch({ type: "set-notice", text: `Failed to query context: ${err instanceof Error ? err.message : String(err)}` });
              }
              return { kind: "done" };
            }
            case "show-plugins": {
              try {
                const plugins = await discoverPlugins(host.session.getCwd());
                if (plugins.size === 0) {
                  host.dispatch({ type: "set-notice", text: "No plugins installed. Install with: codepilot plugin install <git-url>. Plugins live in ~/.codepilot/plugins/." });
                } else {
                  const lines: string[] = [`Plugins (${plugins.size}):`];
                  for (const p of plugins.values()) {
                    lines.push(`  ${p.manifest.name} v${p.manifest.version} [${p.source}]`);
                    lines.push(`    ${p.manifest.description}`);
                  }
                  host.dispatch({ type: "set-notice", text: lines.join("\n") });
                }
              } catch (err: unknown) {
                host.dispatch({ type: "set-notice", text: `Failed to query plugins: ${err instanceof Error ? err.message : String(err)}` });
              }
              return { kind: "done" };
            }
            case "undo": {
              try {
                if (typeof host.session.undo !== "function") {
                  host.dispatch({ type: "set-notice", text: "Undo is only available for local sessions." });
                  return { kind: "done" };
                }
                const r = await host.session.undo();
                host.dispatch({
                  type: "set-notice",
                  text: `Undid ${r.label}: restored ${r.restored.length}, deleted ${r.deleted.length}. (MCP/remote side effects are not undone.)`,
                });
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: err instanceof Error ? err.message : String(err),
                });
              }
              return { kind: "done" };
            }
            case "redo": {
              try {
                if (typeof host.session.redo !== "function") {
                  host.dispatch({ type: "set-notice", text: "Redo is only available for local sessions." });
                  return { kind: "done" };
                }
                const r = await host.session.redo();
                host.dispatch({
                  type: "set-notice",
                  text: `Redid ${r.label}: restored ${r.restored.length}, deleted ${r.deleted.length}. (MCP/remote side effects are not replayed.)`,
                });
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: err instanceof Error ? err.message : String(err),
                });
              }
              return { kind: "done" };
            }
            case "rewind": {
              try {
                if (typeof host.session.rewindConversation !== "function") {
                  host.dispatch({ type: "set-notice", text: "Rewind is only available for local sessions." });
                  return { kind: "done" };
                }
                const targets = host.session.rewindTargets();
                const target = targets[targets.length - result.count];
                if (!target) {
                  host.dispatch({ type: "set-notice", text: "Nothing to rewind." });
                  return { kind: "done" };
                }
                const r = await host.session.rewindConversation(target.messageId, { files: result.files });
                host.dispatch({ type: "clear" });
                host.setHistoryEpoch((n) => n + 1);
                const files = result.files ? ` Files: restored ${r.restored.length}, deleted ${r.deleted.length}.` : "";
                host.dispatch({
                  type: "set-notice",
                  text: `Rewound ${r.turns} prompt(s) to "${r.text.slice(0, 60)}".${files}`,
                });
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: err instanceof Error ? err.message : String(err),
                });
              }
              return { kind: "done" };
            }
            case "init": {
              try {
                const { initProjectGuidance } = await import("@codepilot/core");
                const r = await initProjectGuidance(host.cwd, { force: result.force });
                host.dispatch({
                  type: "set-notice",
                  text: r.skipped
                    ? `Already exists: ${r.path} (pass --force to overwrite)`
                    : `Wrote ${r.path} — review and commit so future sessions inherit it.`,
                });
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: err instanceof Error ? err.message : String(err),
                });
              }
              return { kind: "done" };
            }
            case "remote-qr": {
              try {
                const { mintRemotePairing } = await import("@codepilot/core");
                let serveUrl =
                  process.env.CODEPILOT_SERVE_URL ?? "http://127.0.0.1:18765";
                try {
                  const { readLiveServeInfo } = await import("@codepilot/protocol/serve-info");
                  const live = await readLiveServeInfo();
                  if (live?.host && live.port) {
                    serveUrl = `http://${live.host}:${live.port}`;
                  }
                } catch {
                  /* optional: use default / env */
                }
                const minted = await mintRemotePairing({
                  serveUrl,
                  cwd: host.cwd,
                  sessionId: host.session.id,
                });
                host.dispatch({
                  type: "set-notice",
                  text:
                    `One-time remote QR (expires soon, single use):\n` +
                    `${minted.qrPayload}\n` +
                    `Code: ${minted.code}\n` +
                    `Open on phone once. Do not screenshot/share; revoke via Extensions if leaked.`,
                });
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: err instanceof Error ? err.message : String(err),
                });
              }
              return { kind: "done" };
            }
            case "open-web": {
              try {
                const [{ readLiveServeInfo }, agentApp] = await Promise.all([
                  import("@codepilot/protocol/serve-info"),
                  import("@codepilot/protocol/agent-app"),
                ]);
                const { webPageUrl, openBrowser, detectWebRoot } = agentApp;
  
                // 1) A serve is already live (the default attached TUI, or one we
                //    started earlier): just point the browser at it. The browser
                //    and TUI share the same server host.session.
                const live = await readLiveServeInfo();
                if (live) {
                  openBrowser(webPageUrl(live.host, live.port, live.token || undefined));
                  host.dispatch({
                    type: "set-notice",
                    text: `Opening the web UI (${live.host}:${live.port}) — it shares this session.`,
                  });
                  return { kind: "done" };
                }
  
                // 2) In-process (--local) engine: no serve exists. Start one in
                //    this process (serving the SPA), advertise it via serve.json,
                //    then promote this TUI to a remote client that resumes the
                //    SAME host.session id — so the TUI and the browser follow one live
                //    host.session on the new serve.
                if (host.controller.kind !== "core") {
                  host.dispatch({
                    type: "set-notice",
                    text: "Cannot open the web UI from this backend (no serve and not an in-process engine).",
                  });
                  return { kind: "done" };
                }
                const [{ startWebSocketServer }, { writeServeInfo }] =
                  await Promise.all([
                    import("@codepilot/protocol/ws"),
                    import("@codepilot/protocol/serve-info"),
                  ]);
                const webRoot = detectWebRoot();
                const handle = await startWebSocketServer({
                  host: "127.0.0.1",
                  port: 18765,
                  staticRoot: webRoot,
                  defaultCwd: host.cwd,
                });
                const version = host.controller.core.CORE_VERSION ?? "0.0.0";
                await writeServeInfo({
                  url: handle.url,
                  token: handle.token ?? "",
                  pid: process.pid,
                  host: handle.host,
                  port: handle.port,
                  startedAt: new Date().toISOString(),
                  version,
                });
                host.webServerRef.current = handle;
  
                // Re-attach this TUI as a remote client resuming the current
                // host.session id, and swap the host.controller so later commands use the
                // serve too.
                const { RemoteSession } = await import("../../remoteSession.js");
                const remote = await RemoteSession.connect({
                  url: handle.url,
                  token: handle.token || undefined,
                  cwd: host.cwd,
                  sessionId: host.session.id,
                  onPermissionRequest: (req) => host.permissionBridge.waitDecision(req),
                  onAskUser: (req) => host.questionBridge.waitAnswers(req),
                  onPromptResolved: (kind, requestId) =>
                    kind === "permission"
                      ? host.permissionBridge.dismiss(requestId)
                      : host.questionBridge.dismiss(requestId),
                });
                const prev = host.session;
                let current = remote;
                const nextController: SessionController = {
                  kind: "remote",
                  cwd: host.cwd,
                  listSessions: () => current.listSessions(),
                  openSession: async (id: string) => {
                    current = await current.reopen(id);
                    return current as unknown as Session;
                  },
                };
                host.dispatch({ type: "clear" });
                host.setController(nextController);
                host.setSession(remote as unknown as Session);
                host.dispatch({
                  type: "init",
                  sessionId: remote.id,
                  cwd: remote.getCwd(),
                  model: remote.getModel(),
                  permissionMode: host.state.permissionMode,
                  agentMode: remote.getAgentMode(),
                });
                openBrowser(webPageUrl(handle.host, handle.port, handle.token || undefined));
                host.dispatch({
                  type: "set-notice",
                  text: `Started a local web server (${handle.host}:${handle.port}) and opened the browser — it shares this session.`,
                });
                // The old in-process host.session object is superseded by the serve's
                // live instance (same id, resumed from JSONL); release it.
                void prev.dispose?.().catch(() => undefined);
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: `/web failed: ${err instanceof Error ? err.message : String(err)}`,
                });
              }
              return { kind: "done" };
            }
            case "schedule-list": {
              try {
                const { listScheduledTasks } = await import("@codepilot/core");
                const tasks = await listScheduledTasks();
                if (tasks.length === 0) {
                  host.dispatch({
                    type: "set-notice",
                    text: "No scheduled/idle tasks. Add via Settings → Schedule or connectors UI.",
                  });
                } else {
                  const lines = tasks.map(
                    (t) =>
                      `${t.enabled ? "●" : "○"} ${t.id} [${t.kind}] ${t.title}` +
                      (t.lastStatus ? ` last=${t.lastStatus}` : ""),
                  );
                  host.dispatch({ type: "set-notice", text: lines.join("\n") });
                }
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: err instanceof Error ? err.message : String(err),
                });
              }
              return { kind: "done" };
            }
            case "gc-artifacts": {
              try {
                const { gcProjectArtifacts } = await import("@codepilot/core");
                const res = await gcProjectArtifacts(host.cwd);
                const kb = (res.bytesReclaimed / 1024).toFixed(1);
                host.dispatch({
                  type: "set-notice",
                  text:
                    res.removed.length === 0
                      ? `Artifacts: nothing to reclaim (${res.scanned} on disk, ${res.referenced} referenced).`
                      : `Reclaimed ${res.removed.length} artifact${res.removed.length === 1 ? "" : "s"} (${kb} KB); ${res.referenced} still referenced.`,
                });
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: err instanceof Error ? err.message : String(err),
                });
              }
              return { kind: "done" };
            }
            case "export": {
              try {
                const body = await exportSession(host.session.id, result.format);
                const ext = result.format === "jsonl" ? "jsonl" : "md";
                const dest = resolvePath(
                  host.cwd,
                  result.outPath ?? `codepilot-session-${host.session.id}.${ext}`,
                );
                await writeFile(dest, body, "utf-8");
                host.dispatch({ type: "set-notice", text: `Exported ${result.format} → ${dest}` });
              } catch (err: unknown) {
                host.dispatch({
                  type: "set-notice",
                  text: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
                });
              }
              return { kind: "done" };
            }
    case "exit":
      host.setExitPending(true);
      return { kind: "done" };
    default: {
      const _exhaustive: never = result;
      void _exhaustive;
      return { kind: "done" };
    }
  }
}
