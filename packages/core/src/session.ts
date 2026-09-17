// Session: owns the tool registry, permissions, provider, and event log.
// Persists events as JSONL under ~/.codepilot/sessions/<id>.jsonl.
//
// Enhancements (2025-Q1):
//   - Automatic session title: derived from the first user message; if a
//     small model is configured, a tighter 10-char title is produced and
//     cached. The model is asked via the smallModel provider; failures fall
//     back to a deterministic prefix.
//   - Checkpoint integration: a CheckpointHook is initialised in `init()`;
//     on each prompt the hook inspects the event log and writes a fresh
//     checkpoint when triggered (token count, round count).
//   - searchSessions / exportSession: pure helpers, useful from CLI and
//     from `listSessions` enrichments.
//
// Module layout (2026-Q3 split):
//   - session.ts          — the Session class itself (this file).
//   - session-mcp.ts      — MCP server startup, tool registration, and the
//                           `@mcp:` prompt-reference resolution.
//   - session-telemetry.ts— per-prompt span lifecycle (start/end).
//   - session-utils.ts    — standalone helpers (paths, titles, providers,
//                           createSession/listSessions/searchSessions/...).
// The helpers moved to session-utils are re-exported at the bottom of this
// file so existing `import { ... } from "./session.js"` callers keep working.

import { appendFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type AgentDeps } from "./agent.js";
import { runtimeRegistry, type AgentRuntime } from "./runtime.js";
import type {
  AgentMode,
  CodepilotConfig,
  Event,
  ImageAttachment,
  PermissionDecision,
  PermissionRequest,
  SessionOptions,
  SessionSummary,
} from "./types.js";
import { ToolRegistry } from "./tools/types.js";
import { ArtifactStore } from "./tools/artifacts.js";
import { PermissionEngine } from "./permissions.js";
import { readMemory, readLayeredProjectMemory, FileMemorySink, summariseMemory } from "./memory.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { compact, shouldCompact, type CompactionOptions } from "./compaction.js";
import { extractPlan, estimateEventTokens } from "./compaction.js";
import { createSubagentRunner } from "./subagent.js";
import { discoverCustomAgents, renderCustomAgentsBlock, type CustomAgent } from "./customAgents.js";
import { loadAutoMemoryIndex, type AutoMemoryConfig } from "./autoMemory.js";
import { writePlanFile, setPlanFileStatus } from "./plans.js";
import { PersistentShell } from "./persistentShell.js";
import type { McpManager } from "./mcp.js";
import { startMcp as startMcpImpl, resolveSessionMcpReferences } from "./session-mcp.js";
import { startPromptSpan, endPromptSpan, type PromptSpan } from "./session-telemetry.js";
import {
  bashTool,
  bashOutputTool,
  bashKillTool,
  writeStdinTool,
  notebookEditTool,
  webFetchTool,
  webSearchTool,
  readFileTool,
  readImageTool,
  writeFileTool,
  editFileTool,
  applyPatchTool,
  diagnosticsTool,
  globTool,
  grepTool,
  lsTool,
  planUpdateTool,
  memoryWriteTool,
  readArtifactTool,
  taskTool,
  askUserQuestionTool,
  planDoneTool,
  filterToolsByModeFromRegistry,
} from "./tools/index.js";
import { onJobCompletion } from "./tools/bashJobs.js";
import { TOOL_REFERENCE } from "./tools/toolDocs.js";
import type { OutputStyle } from "./systemPrompt.js";
import { resolveSandbox, detectSandboxBackend, type ResolvedSandbox } from "./sandbox.js";
import { HookEngine } from "./hooks.js";
import { estimateTokens, estimateCostUSD, lookupContextWindow, resolveCompactionThreshold } from "./tokens.js";
import {
  writeCheckpoint,
  readCheckpoint,
  summariseCheckpointForPrompt,
  makeCheckpointHook,
  type CheckpointHook,
} from "./checkpoints.js";
import {
  createSnapshot,
  rewindToSnapshot,
  listSnapshots,
} from "./snapshots.js";
import {
  SESSIONS_DIR,
  buildProvider,
  buildSmallProvider,
  callTitleModel,
  countMessages,
  deriveTitleFromText,
  generateSessionId,
  loadTitleFromDisk,
  sanitizeTitle,
  sessionPath,
  titleSidecarPath,
  type RichSessionSummary,
} from "./session-utils.js";

export class Session {
  readonly id: string;
  readonly cwd: string;
  private readonly config: CodepilotConfig;
  /** Active model. Mutable via setModel() and turn-scoped overrides. */
  private model: string;
  private readonly systemPromptExtra: string | undefined;
  private readonly onPermissionRequest?: (
    req: PermissionRequest
  ) => Promise<PermissionDecision>;
  private readonly onAskUser?: SessionOptions["onAskUser"];
  private readonly onMcpServerRequest?: SessionOptions["onMcpServerRequest"];
  private readonly onMcpOpenAuthUrl?: SessionOptions["onMcpOpenAuthUrl"];
  private readonly diagnosticsProvider?: SessionOptions["diagnosticsProvider"];
  /** Provider override (from Agent SDK / replay mode). When set, skips buildProvider(). */
  private readonly providerOverride?: import("./providers/types.js").ChatProvider;
  /** Files the agent has written/edited this session, for snapshot rewind. */
  private touchedFiles: Set<string> = new Set();
  /** Unsubscribe functions for background-job completion listeners. */
  private jobListeners: Array<() => void> = [];

  private events: Event[] = [];
  private listeners = new Set<(e: Event) => void>();
  private cancelController: AbortController | null = null;
  /** Mid-run steering messages queued via steer(); drained each agent turn. */
  private steeringQueue: string[] = [];
  private toolRegistry: ToolRegistry;
  private artifacts: ArtifactStore;
  private permissions: PermissionEngine;
  private sandbox: ResolvedSandbox;
  /** True when sandbox mode is active but no OS backend is available and
   *  fallback is "deny". Bash commands will be refused; surfaced as a
   *  system-prompt note and via getSandboxStatus(). */
  private _sandboxUnavailable = false;
  private hooks: HookEngine;
  private mcp: McpManager | null = null;
  private systemPromptCache: { staticPrefix: string; dynamicSuffix: string; full: string } | null = null;
  private disposed = false;
  /** Current Cursor-style collaboration mode (default "agent"). */
  private mode: AgentMode = "agent";
  /** Output style (default "concise"). Controls verbosity/teaching posture. */
  private outputStyle: OutputStyle = "concise";
  /** Auto-title, generated after the first prompt. */
  private title: string | null = null;
  /** Cached checkpoint hook — initialised in `init()`. */
  private checkpointHook: CheckpointHook | null = null;
  /** Aggregated usage across all prompts of this session. */
  private usageTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** Custom sub-agents discovered from .codepilot/agents/ + ~/.codepilot/agents/. */
  private customAgents: Map<string, CustomAgent> = new Map();
  /** The host surface this session is running in: "cli" | "tui" | "vscode" | "idea".
   *  Set by the host (TUI/IDE) so the prompt can tailor advice. Defaults to "cli". */
  private hostSurface: "cli" | "tui" | "vscode" | "idea" = "cli";
  /** The persistent shell shared across foreground bash calls. Lazily started. */
  private persistentShell: PersistentShell | null = null;
  /** The permission mode active before the user entered plan mode, so we can
   *  restore it on approval (claude-code `prePlanMode`). */
  private prePlanMode: AgentMode | null = null;
  /** The slug of the plan file most recently written by plan_done, so
   *  setPlanFileStatus can update it after the user approves. */
  private lastPlanSlug: string | null = null;
  /** Turn-scoped overrides (claude-code slash-command semantics). Set by
   *  `setTurnOverrides()` (e.g. from a custom `/name` command's frontmatter
   *  `model` / `allowed-tools`). Applied to the NEXT `prompt()` only and
   *  cleared in the finally block — so the session model + permission
   *  grants resume on the user's next message. */
  private turnOverrideModel: string | null = null;
  private turnOverrideAllowedTools: string[] | null = null;
  /** Saved rule list + effect so clearTurnOverrides() can pop exactly what
   *  setTurnOverrides() pushed (rules are append-only on the engine). */
  private turnOverrideRuleCount = 0;
  /** Resolved agent runtime name (default loop when undefined). See ROADMAP-NEXT §4.1. */
  private runtimeName: string | undefined;
  /** The live runtime instance, lazily resolved at the first prompt(). */
  private runtime: AgentRuntime | null = null;

  constructor(
    id: string,
    opts: Required<Pick<SessionOptions, "cwd" | "config" | "model">> & SessionOptions
  ) {
    this.id = id;
    this.cwd = opts.cwd;
    this.config = opts.config ?? {};
    this.model = opts.model ?? this.config.model ?? "claude-sonnet-4-5";
    this.systemPromptExtra = opts.systemPromptExtra;
    this.onPermissionRequest = opts.onPermissionRequest;
    this.onAskUser = opts.onAskUser;
    this.onMcpServerRequest = opts.onMcpServerRequest;
    this.onMcpOpenAuthUrl = opts.onMcpOpenAuthUrl;
    this.diagnosticsProvider = opts.diagnosticsProvider;
    this.providerOverride = opts.provider;
    this.runtimeName = opts.runtime ?? opts.config?.runtime;
    this.mode = opts.agentMode ?? opts.config.agentMode ?? "agent";
    this.hostSurface = opts.hostSurface ?? "cli";
    this.toolRegistry = new ToolRegistry();
    this.artifacts = new ArtifactStore(join(opts.cwd, ".codepilot", "artifacts"));
    this.permissions = new PermissionEngine({
      permissionMode: this.config.permissionMode,
      autoApprove: this.config.autoApprove,
      permissions: this.config.permissions,
    });
    this.sandbox = resolveSandbox(this.config.sandbox, this.cwd);
    this.hooks = new HookEngine(this.config.hooks, this.cwd);
    // Wire hook trust (hash-based review for command hooks, codex-style).
    this.hooks.setTrustFile(join(this.cwd, ".codepilot", "hook_trust.json"));
    // Fail-closed notification: when sandbox mode is active but no OS backend
    // is available AND the fallback is "deny", we surface a prominent warning
    // so the user knows bash commands will be refused. deepseek-harness goes
    // further (refuses to start); we warn + refuse bash but still allow file
    // tools (which have their own tool-layer guard). This is a deliberate
    // compromise: the tool-layer path guard works without a kernel sandbox.
    if (this.sandbox.mode !== "off") {
      const backend = detectSandboxBackend();
      if (backend === "none" && this.sandbox.fallback === "deny") {
        this._sandboxUnavailable = true;
      }
    }
  }

  /** Load from disk and configure registries. */
  async init(): Promise<void> {
    await this.artifacts.init();
    this.registerBuiltins();
    await this.loadFromDisk();
    this.mcp = await this.startMcp();
    // Load trusted hook hashes (for command-hook trust enforcement).
    await this.hooks.loadTrustedHashes();
    // Discover custom sub-agents from .codepilot/agents/ + ~/.codepilot/agents/.
    this.customAgents = await discoverCustomAgents(this.cwd);
    await this.rebuildSystemPrompt();
    this.checkpointHook = makeCheckpointHook(this.cwd, this.id);
    // If we loaded events, the hook shouldn't immediately re-fire — mark
    // the boundary at the end of the loaded history.
    if (this.events.length > 0) {
      this.checkpointHook.lastCheckpointAt = this.events.length;
    }
    // If a checkpoint already exists for this session, prime the title from it.
    const existing = await readCheckpoint(this.cwd, this.id);
    if (existing) {
      const headerMatch = existing.match(/^#\s+(.+)$/m);
      if (headerMatch) {
        const candidate = headerMatch[1]!.replace(/^Checkpoint for\s+/, "").trim();
        if (candidate) this.title = candidate;
      }
    }
    // Fire SessionStart hook (resume if we loaded history, startup otherwise).
    const source = this.events.length > 0 ? "resume" : "startup";
    await this.hooks.runSessionStart(source).catch(() => undefined);
    // Wire background-job completion → steering. When a detached bash job
    // finishes, push a notice into the steering queue so the agent learns
    // the job is done on its next turn (instead of having to poll
    // bash_output). The unsubscribe is dropped on dispose via jobListeners.
    this.jobListeners.push(
      onJobCompletion(this.cwd, (meta) => {
        const status =
          meta.status === "exited"
            ? `exited with code ${meta.exitCode ?? "?"}`
            : meta.status === "killed"
              ? "was killed"
              : meta.status === "failed"
                ? "failed"
                : meta.status;
        this.steer(
          `Background job ${meta.id} (${meta.command.slice(0, 80)}) ${status}. ` +
            `Use bash_output({ job_id: "${meta.id}" }) to read its output.`
        );
      })
    );
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    this.cancelController = new AbortController();

    // Telemetry: wrap each prompt in a span (no-op when OTEL is not configured).
    const promptSpan: PromptSpan = startPromptSpan(this.id, text.length);

    // Run UserPromptSubmit hooks. A blocking hook stops the prompt; a
    // rewriting hook replaces the text (first hook wins).
    const promptHook = await this.hooks.runUserPromptSubmit(text).catch((): {
      action: "allow";
      rewrittenPrompt?: string;
      warnings: string[];
    } => ({ action: "allow", warnings: ["UserPromptSubmit hook threw; ignored"] }));
    if (promptHook.action === "block") {
      const ev: Event = {
        type: "error",
        message: `prompt blocked by UserPromptSubmit hook: ${promptHook.reason ?? "(no reason)"}`,
        recoverable: true,
      };
      this.events.push(ev);
      await this.persistEvent(ev);
      this.notify(ev);
      return;
    }
    let effectivePrompt = promptHook.rewrittenPrompt ?? text;

    // Resolve `@mcp:<server>/<uri>` references into inline resource content.
    // This lets users paste MCP resource URIs into their prompt to inject
    // server-side context (e.g. `@mcp:github/repos/foo/bar`).
    effectivePrompt = await resolveSessionMcpReferences(this.mcp, effectivePrompt);

    try {
      // Lazily start the persistent shell (one per session). Its cwd/env
      // persist across foreground bash calls so `cd` / `export` carry over.
      if (!this.persistentShell) {
        this.persistentShell = new PersistentShell({ cwd: this.cwd });
      }
      // Apply turn-scoped overrides (claude-code slash-command semantics).
      // The model override applies to THIS prompt only; allowed-tools rules
      // were already pushed onto the permission engine by setTurnOverrides()
      // and are popped in the finally block below.
      const effectiveModel = this.turnOverrideModel ?? this.model;
      const deps: AgentDeps = {
        provider: this.providerOverride ?? buildProvider(this.config),
        tools: this.toolRegistry,
        artifacts: this.artifacts,
        permissions: this.permissions,
        config: { ...this.config, model: effectiveModel },
        cwd: this.cwd,
        systemPrompt: this.systemPromptCache ?? undefined,
        signal: this.cancelController.signal,
        agentMode: this.mode,
        sandbox: this.sandbox,
        hooks: this.hooks,
        persistentShell: this.persistentShell,
        diagnosticsProvider: this.diagnosticsProvider,
        parentSpan: promptSpan,
        drainSteering: () => {
          const q = this.steeringQueue;
          this.steeringQueue = [];
          return q;
        },
        onEvent: async (e) => {
          this.events.push(e);
          await this.persistEvent(e);
          this.notify(e);
          // plan_done approval: switch to agent mode for the next turn.
          if (e.type === "mode_request") {
            await this.setAgentMode(e.mode);
          }
          // Track files touched by write/edit/apply_patch for snapshot rewind.
          if (e.type === "tool_call") {
            const t = e as { type: "tool_call"; name: string; input: unknown };
            if (t.name === "write_file" || t.name === "edit_file" || t.name === "apply_patch") {
              const inp = t.input as Record<string, unknown> | undefined;
              const path = inp?.path;
              if (typeof path === "string") this.touchedFiles.add(path);
              // apply_patch may touch multiple files — parse is expensive, so
              // we rely on the patch's own `*** Update/Add/Delete File:` lines.
              if (t.name === "apply_patch" && typeof inp?.patch === "string") {
                for (const m of (inp.patch as string).matchAll(/\*\*\* (?:Add|Delete|Update) File: (.+)/g)) {
                  this.touchedFiles.add(m[1]!.trim());
                }
              }
            }
          }
        },
        onPermissionRequest: this.onPermissionRequest,
        onAskUser: this.onAskUser,
        onUsage: (u) => {
          this.usageTotal.input += u.input ?? 0;
          this.usageTotal.output += u.output ?? 0;
          this.usageTotal.cacheRead += u.cacheRead ?? 0;
          this.usageTotal.cacheWrite += u.cacheWrite ?? 0;
        },
      };

      // Resolve the agent runtime (ROADMAP-NEXT §4.1). Default loop wraps
      // runAgent(); unknown explicit names throw here so a misconfigured
      // plugin runtime never silently falls back to the default loop.
      const runtime = this.getRuntime();
      // Run the agent loop. Compaction may run between turns (driven by the
      // session after each prompt completes).
      await runtime.prompt({ history: this.events, userText: effectivePrompt, images }, deps);

      // Auto-title after the first prompt completes.
      if (this.title == null) {
        await this.refreshTitle(effectivePrompt);
      }

      // Post-prompt compaction.
      await this.maybeCompact();

      // Post-prompt checkpoint.
      await this.maybeCheckpoint();

      // Stop hooks (fire-and-forget, never fatal).
      await this.hooks.runSimple("Stop", { reason: "prompt_completed" }).catch(() => undefined);
    } finally {
      this.cancelController = null;
      // Clear turn-scoped overrides so the session model + permission
      // grants resume on the user's next message (claude-code semantics).
      this.clearTurnOverrides();
      // End the telemetry span (no-op when disabled).
      endPromptSpan(promptSpan);
    }
  }

  /**
   * Runtime collaboration-mode switch. Takes effect on the next `prompt()`
   * (and on tool dispatch — see `runOneTool`'s mode gate in agent.ts). The
   * system prompt is rebuilt so the new mode's guidance reaches the model
   * on the next turn. Emits a `mode` event so subscribers (and protocol
   * clients) can react immediately.
   *
   * Plan-mode bookkeeping (claude-code `prePlanMode` equivalent): when the
   * user enters `plan` mode, the previous mode is stashed in `prePlanMode`
   * so it can be restored on approval. When the agent calls `plan_done` and
   * the user approves, the session switches to `agent` mode (not back to
   * `prePlanMode`) — claude-code restores the pre-plan permission *tier*
   * but always lands in an executable mode. We mark the plan file
   * "approved" so the artifact reflects the outcome.
   */
  async setAgentMode(mode: AgentMode): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    if (this.mode === mode) return;
    // Stash the pre-plan mode so we can report it (and so the approval
    // handler knows we came from plan mode).
    if (mode === "plan" && this.mode !== "plan") {
      this.prePlanMode = this.mode;
    }
    // If we're leaving plan mode for agent (the plan_done approval path),
    // mark the plan file approved.
    if (this.mode === "plan" && mode === "agent" && this.lastPlanSlug) {
      await setPlanFileStatus(this.cwd, this.lastPlanSlug, "approved", {
        plansDirectory: this.config.plansDirectory,
      }).catch(() => undefined);
    }
    this.mode = mode;
    await this.rebuildSystemPrompt();
    const ev: Event = { type: "mode", mode };
    this.events.push(ev);
    await this.persistEvent(ev);
    this.notify(ev);
  }

  /** Returns the current collaboration mode (default "agent"). */
  getAgentMode(): AgentMode {
    return this.mode;
  }

  /** Returns the current output style (default "concise"). */
  getOutputStyle(): OutputStyle {
    return this.outputStyle;
  }

  /** Returns the active model (factoring in any turn-scoped override). */
  getModel(): string {
    return this.turnOverrideModel ?? this.model;
  }

  /**
   * Persistently switch the session model. Rebuilds the system prompt so
   * model-aware guidance updates. Emits no event (the TUI tracks model
   * changes via its own state). Used by `/model` and the SDK.
   */
  async setModel(model: string): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    if (!model || model === this.model) return;
    this.model = model;
    await this.rebuildSystemPrompt();
  }

  /**
   * Set turn-scoped overrides (claude-code slash-command semantics). The
   * `model` override (use `"inherit"` to keep the session model) and the
   * `allowedTools` permission grant apply to the NEXT `prompt()` only and
   * are cleared in that prompt's finally block — so the session resumes
   * its normal model + permission posture on the user's next message.
   *
   * Calling this while a prompt is running is a no-op (the overrides would
   * be cleared by the in-flight prompt's finally before they take effect);
   * hosts should call it immediately before `prompt()`.
   *
   * `allowedTools` entries are tool names (e.g. `["bash", "read_file"]`).
   * Each becomes an "allow" session rule for the next turn.
   */
  setTurnOverrides(opts: { model?: string; allowedTools?: string[] } = {}): void {
    if (this.disposed) throw new Error("session disposed");
    // Clear any stale overrides first so we don't double-push rules.
    this.clearTurnOverrides();
    if (opts.model && opts.model !== "inherit") {
      this.turnOverrideModel = opts.model;
    }
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      this.turnOverrideAllowedTools = opts.allowedTools.slice();
      this.turnOverrideRuleCount = opts.allowedTools.length;
      for (const toolName of opts.allowedTools) {
        this.permissions.addSessionRule(toolName, "allow");
      }
    }
  }

  /** Clear any active turn-scoped overrides (model + permission grants). */
  clearTurnOverrides(): void {
    this.turnOverrideModel = null;
    if (this.turnOverrideAllowedTools) {
      // Pop exactly the N "allow" rules we pushed (LIFO), leaving any
      // "always"-decision rules intact.
      this.permissions.removeLastSessionRules("allow", this.turnOverrideRuleCount);
      this.turnOverrideAllowedTools = null;
      this.turnOverrideRuleCount = 0;
    }
  }

  /** Returns the currently-active turn-scoped overrides (for UI display). */
  getTurnOverrides(): { model: string | null; allowedTools: string[] | null } {
    return {
      model: this.turnOverrideModel,
      allowedTools: this.turnOverrideAllowedTools,
    };
  }

  /**
   * Restrict the session's tool registry to only the named tools. Tools
   * not in the list are removed from the registry, so the model never
   * sees them and the agent loop cannot invoke them. This is a persistent
   * session-level filter (unlike turn-scoped overrides).
   *
   * Used by headless/print mode (`--allowed-tools`) to restrict the agent
   * to a subset of tools for CI/scripting safety.
   */
  filterToolRegistry(allowedTools: string[]): void {
    const allowed = new Set(allowedTools);
    const allTools = this.toolRegistry.all();
    this.toolRegistry = new ToolRegistry();
    for (const t of allTools) {
      if (allowed.has(t.name)) {
        this.toolRegistry.register(t);
      }
    }
    // Rebuild the system prompt so the advertised tool list matches.
    void this.rebuildSystemPrompt();
  }

  /**
   * Switch the output style. Rebuilds the system prompt so the new style's
   * guidance reaches the model on the next turn. Does NOT emit an event —
   * output style is a presentation knob, not a behavioral mode.
   */
  async setOutputStyle(style: OutputStyle): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    if (this.outputStyle === style) return;
    this.outputStyle = style;
    await this.rebuildSystemPrompt();
  }

  /** Returns the host surface (default "cli"). */
  getHostSurface(): "cli" | "tui" | "vscode" | "idea" {
    return this.hostSurface;
  }

  /**
   * Update the host surface. Call this when the session is attached to a
   * different frontend (e.g. a CLI session moved into the VSCode panel).
   * Rebuilds the prompt so platform-aware advice updates.
   */
  async setHostSurface(surface: "cli" | "tui" | "vscode" | "idea"): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    if (this.hostSurface === surface) return;
    this.hostSurface = surface;
    await this.rebuildSystemPrompt();
  }

  // ---- Context visualization (/context) ----

  /**
   * Produce a structured breakdown of the session's context usage for the
   * `/context` command. Returns total estimated tokens, a per-event-type
   * breakdown, the context window + trigger threshold, usage %, and a list
   * of files that have been read more than once (dedup hint).
   */
  contextReport(): {
    totalTokens: number;
    window: number;
    triggerThreshold: number;
    triggerFraction: number;
    usagePercent: number;
    autoCompactEnabled: boolean;
    byEventType: { type: string; tokens: number; count: number }[];
    topFileReads: { path: string; reads: number; tokens: number }[];
    duplicateReads: { path: string; reads: number }[];
  } {
    const window = this.config.contextWindow ??
      lookupContextWindow(this.model).contextWindow;
    const fraction = this.config.compactionThreshold ?? 0.92;
    const trigger = Math.floor(window * fraction);
    const byType = new Map<string, { tokens: number; count: number }>();
    let total = 0;
    // Track file reads for dedup hints.
    const fileReads = new Map<string, { reads: number; tokens: number }>();
    for (const e of this.events) {
      const tok = estimateEventTokens([e], estimateTokens);
      total += tok;
      const key = e.type;
      const cur = byType.get(key) ?? { tokens: 0, count: 0 };
      cur.tokens += tok;
      cur.count += 1;
      byType.set(key, cur);
      // read_file tool_call carries the path in input.path.
      if (e.type === "tool_call" && (e as { name?: string }).name === "read_file") {
        const inp = (e as { input?: { path?: string } }).input;
        const p = inp?.path;
        if (typeof p === "string") {
          const fr = fileReads.get(p) ?? { reads: 0, tokens: 0 };
          fr.reads += 1;
          fr.tokens += tok;
          fileReads.set(p, fr);
        }
      }
    }
    const byEventType = [...byType.entries()]
      .map(([type, v]) => ({ type, tokens: v.tokens, count: v.count }))
      .sort((a, b) => b.tokens - a.tokens);
    const topFileReads = [...fileReads.entries()]
      .map(([path, v]) => ({ path, reads: v.reads, tokens: v.tokens }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10);
    const duplicateReads = topFileReads
      .filter((f) => f.reads > 1)
      .map((f) => ({ path: f.path, reads: f.reads }));
    return {
      totalTokens: total,
      window,
      triggerThreshold: trigger,
      triggerFraction: fraction,
      usagePercent: Math.round((total / window) * 100),
      autoCompactEnabled: this.config.autoCompact !== false,
      byEventType,
      topFileReads,
      duplicateReads,
    };
  }

  // ---- Snapshot rewind ----

  /**
   * Snapshot the current on-disk state of every file the agent has touched
   * this session. Returns a snapshot id that can be passed to `rewind`.
   * Call this at a "known-good" boundary (e.g. after tests pass) so the
   * user can later undo a broken sequence of edits.
   */
  async snapshot(label: string): Promise<string> {
    const paths = [...this.touchedFiles];
    if (paths.length === 0) {
      // Nothing touched yet — still record a snapshot so rewind can detect
      // files created after this point.
    }
    return createSnapshot(this.cwd, paths, label);
  }

  /** Rewind every touched file to its state at snapshot `id`. */
  async rewind(id: string): Promise<{ restored: string[]; deleted: string[] }> {
    return rewindToSnapshot(this.cwd, id);
  }

  /** List available snapshots (oldest first). */
  async listSnapshots(): Promise<
    { id: string; label: string; createdAt: string; fileCount: number }[]
  > {
    return listSnapshots(this.cwd);
  }

  /** Returns the auto-generated (or user-supplied) session title. */
  getTitle(): string | null {
    return this.title;
  }

  /** Override the session title (and persist it for `listSessions`). */
  async setTitle(title: string): Promise<void> {
    this.title = title;
    // Title is stored as a tiny sidecar so listSessions doesn't have to
    // re-parse the JSONL. Failures are non-fatal.
    try {
      await mkdir(SESSIONS_DIR, { recursive: true });
      await writeFile(titleSidecarPath(this.id), title, "utf-8");
    } catch {
      /* ignore */
    }
  }

  cancel(): void {
    this.cancelController?.abort();
  }

  /**
   * Resolve the agent runtime for this session (ROADMAP-NEXT §4.1). The
   * instance is created lazily on first use and cached. Default name
   * (undefined or "default") yields the built-in loop that wraps
   * `runAgent()`. A plugin-registered runtime is instantiated through its
   * `RuntimeFactory` with `cwd`; an unknown name throws.
   */
  getRuntime(): AgentRuntime {
    if (this.runtime) return this.runtime;
    this.runtime = runtimeRegistry.resolve(this.runtimeName, { cwd: this.cwd });
    return this.runtime;
  }

  /** The configured runtime name (for `/runtime`-style introspection). */
  getRuntimeName(): string {
    return this.runtimeName ?? "default";
  }

  /**
   * Queue a mid-run steering message. It is injected as a user message at
   * the start of the agent's next turn (see `drainSteering` in agent.ts).
   * Safe to call while a prompt is running or idle; messages queued while
   * idle are prepended to the next prompt's transcript.
   */
  steer(text: string): void {
    if (text.trim().length === 0) return;
    this.steeringQueue.push(text);
  }

  /** Current sandbox policy (read-only view for hosts/tests). */
  getSandbox(): ResolvedSandbox {
    return this.sandbox;
  }

  /** Sandbox availability status. When `unavailable` is true, bash commands
   *  are being refused because sandbox mode is active but no OS backend
   *  exists and fallback is "deny". The host should surface this to the
   *  user (e.g. a warning banner). */
  getSandboxStatus(): { mode: ResolvedSandbox["mode"]; unavailable: boolean; backend: string } {
    return {
      mode: this.sandbox.mode,
      unavailable: this._sandboxUnavailable,
      backend: detectSandboxBackend(),
    };
  }

  /** Active permission rules (session + config), for UI display. */
  getPermissionRules() {
    return this.permissions.rules();
  }

  /**
   * Aggregated token usage for this session plus an estimated USD cost
   * (undefined when the model is not in the price table).
   */
  getUsage(): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUSD?: number;
  } {
    return {
      ...this.usageTotal,
      costUSD: estimateCostUSD(this.model, this.usageTotal),
    };
  }

  /** The MCP manager (null when no servers are configured). For `/mcp`. */
  getMcpManager(): import("./mcp.js").McpManager | null {
    return this.mcp;
  }

  /** The hook engine. For `/hooks`. */
  getHookEngine(): import("./hooks.js").HookEngine {
    return this.hooks;
  }

  /** Working directory (for agent/skill discovery). */
  getCwd(): string {
    return this.cwd;
  }

  /** Status-line script configuration (for the TUI custom status bar). */
  getStatusLineConfig(): import("./types.js").StatusLineConfig | undefined {
    return this.config.statusLine;
  }

  subscribe(listener: (e: Event) => void): () => void {
    // Replay history first.
    for (const e of this.events) {
      try {
        listener(e);
      } catch {
        /* ignore listener errors */
      }
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getEvents(): Event[] {
    return this.events.slice();
  }

  /** Returns a short summary of this session for list/search use. */
  async getSummary(): Promise<SessionSummary> {
    const path = sessionPath(this.id);
    let updatedAt = Date.now();
    try {
      const st = await stat(path);
      updatedAt = st.mtimeMs;
    } catch {
      /* default */
    }
    const title = this.title ?? (await loadTitleFromDisk(this.id));
    return {
      id: this.id,
      title: title ?? "(untitled)",
      updatedAt,
      cwd: this.cwd,
    };
  }

  /** Returns an enriched summary including mode/model/messageCount. The
   *  base SessionSummary is kept tight for back-compat; callers that want
   *  the rich fields use this method. */
  async getRichSummary(): Promise<RichSessionSummary> {
    const base = await this.getSummary();
    return {
      ...base,
      mode: this.mode,
      model: this.model,
      messageCount: countMessages(this.events),
    };
  }

  async fork(atEventIndex?: number): Promise<Session> {
    const newId = generateSessionId();
    const forked = new Session(newId, {
      cwd: this.cwd,
      config: this.config,
      model: this.model,
      systemPromptExtra: this.systemPromptExtra,
      agentMode: this.mode,
      onPermissionRequest: this.onPermissionRequest,
    });
    await forked.init();
    const slice = atEventIndex === undefined
      ? this.events
      : this.events.slice(0, atEventIndex);
    for (const e of slice) {
      forked.events.push(e);
      await forked.persistEvent(e);
    }
    await forked.rebuildSystemPrompt();
    if (this.title) {
      await forked.setTitle(this.title);
    }
    return forked;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    this.listeners.clear();
    // Detach background-job completion listeners.
    for (const off of this.jobListeners) {
      try { off(); } catch { /* ignore */ }
    }
    this.jobListeners = [];
    if (this.persistentShell) {
      this.persistentShell.close();
      this.persistentShell = null;
    }
    if (this.mcp) {
      await this.mcp.stopAll();
      this.mcp = null;
    }
  }

  // -- internals ----------------------------------------------------------

  private notify(e: Event): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* swallow */
      }
    }
  }

  private registerBuiltins(): void {
    this.toolRegistry.register(bashTool);
    this.toolRegistry.register(bashOutputTool);
    this.toolRegistry.register(bashKillTool);
    this.toolRegistry.register(writeStdinTool);
    this.toolRegistry.register(notebookEditTool);
    this.toolRegistry.register(webFetchTool);
    this.toolRegistry.register(webSearchTool);
    this.toolRegistry.register(readFileTool);
    this.toolRegistry.register(readImageTool);
    this.toolRegistry.register(writeFileTool);
    this.toolRegistry.register(editFileTool);
    this.toolRegistry.register(applyPatchTool);
    this.toolRegistry.register(diagnosticsTool);
    this.toolRegistry.register(globTool);
    this.toolRegistry.register(grepTool);
    this.toolRegistry.register(lsTool);
    this.toolRegistry.register(planUpdateTool);
    this.toolRegistry.register(memoryWriteTool);
    this.toolRegistry.register(readArtifactTool);
    this.toolRegistry.register(taskTool);
    this.toolRegistry.register(askUserQuestionTool);
    this.toolRegistry.register(planDoneTool);

    // Wire the memory sink.
    memoryWriteTool.sink = new FileMemorySink(this.cwd);

    // Wire plan_done's plan-file persistence (claude-code `~/.claude/plans/`
    // equivalent). The plan is written to .codepilot/plans/<slug>.md before
    // the approval prompt; on approval the file's status is updated.
    planDoneTool.writePlan = async (summary, steps) => {
      const pf = await writePlanFile(this.cwd, this.id, summary, steps, {
        plansDirectory: this.config.plansDirectory,
        status: "pending",
      });
      this.lastPlanSlug = pf.slug;
      return pf.path;
    };
    planDoneTool.currentPlan = () => extractPlan(this.events);

    // Wire the subagent runner so `task` works. "explore" agents are
    // read-only; "worker" agents additionally get write + bash tools.
    taskTool.runner = createSubagentRunner({
      cwd: this.cwd,
      config: this.config,
      model: this.model,
      buildToolRegistry: (agentType) => {
        const r = new ToolRegistry();
        r.register(readFileTool);
        r.register(readImageTool);
        r.register(globTool);
        r.register(grepTool);
        r.register(lsTool);
        r.register(readArtifactTool);
        if (agentType === "worker") {
          r.register(writeFileTool);
          r.register(editFileTool);
          r.register(applyPatchTool);
          r.register(bashTool);
        }
        return r;
      },
      hooks: this.hooks,
      resolveCustomAgent: async (name) => this.customAgents.get(name),
    });
  }

  private async startMcp(): Promise<McpManager | null> {
    return startMcpImpl({
      config: this.config,
      cwd: this.cwd,
      onMcpOpenAuthUrl: this.onMcpOpenAuthUrl,
      onMcpServerRequest: this.onMcpServerRequest,
      withToolRegistry: (fn) => fn(this.toolRegistry),
    });
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const path = sessionPath(this.id);
      const text = await readFile(path, "utf-8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          this.events.push(JSON.parse(line) as Event);
        } catch {
          /* skip malformed */
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    // Hydrate title from sidecar (if any).
    const t = await loadTitleFromDisk(this.id);
    if (t) this.title = t;
  }

  private async persistEvent(e: Event): Promise<void> {
    const path = sessionPath(this.id);
    await mkdir(SESSIONS_DIR, { recursive: true });
    await appendFile(path, JSON.stringify(e) + "\n", "utf-8");
  }

  private async rebuildSystemPrompt(): Promise<void> {
    const memory = summariseMemory(await readMemory(this.cwd));
    // Hierarchical project memory: CODEPILOT.md / AGENTS.md from cwd upward,
    // with @import expansion (claude-code style).
    const layered = await readLayeredProjectMemory(this.cwd);
    if (layered) memory.project = layered;
    // Auto memory index (claude-code v2.1.59+ equivalent). Loaded from
    // ~/.codepilot/memory/<project-hash>/MEMORY.md, capped at 200 lines / 25KB.
    const autoCfg: AutoMemoryConfig = { enabled: this.config.autoMemoryEnabled !== false };
    const autoIndex = await loadAutoMemoryIndex(this.cwd, autoCfg);
    if (autoIndex) {
      memory.user = (memory.user ? memory.user + "\n\n" : "") +
        `<!-- auto memory index -->\n${autoIndex}`;
    }
    const plan = extractPlan(this.events);
    // The system prompt advertises the *mode-filtered* tool list, so the
    // model doesn't expect tools that aren't actually available.
    const visibleTools = filterToolsByModeFromRegistry(this.toolRegistry, this.mode);
    const toolNames = visibleTools.map((t) => t.name);
    const toolSummaries: Record<string, string> = {};
    for (const t of visibleTools) {
      // First sentence of the description keeps the list compact.
      const first = t.description.split(/(?<=[.!?。！？])\s|\n/)[0]?.trim() ?? "";
      toolSummaries[t.name] = first.length > 140 ? first.slice(0, 140) + "…" : first;
    }
    // Per-tool reference docs (when_to_use / gotchas / examples), drawn from
    // the curated TOOL_REFERENCE map. MCP tools have no entry; they fall
    // back to the summary-only rendering.
    const toolReference: Record<string, string> = {};
    for (const t of visibleTools) {
      if (TOOL_REFERENCE[t.name]) toolReference[t.name] = TOOL_REFERENCE[t.name];
    }
    // Sandbox posture is part of the prompt so the model knows its boundaries.
    const sb = this.sandbox;
    const sandboxNote =
      `Sandbox: mode=${sb.mode}, network=${sb.network ? "allowed" : "blocked"}` +
      (sb.mode !== "off" ? `, writes limited to ${sb.writableRoots.join(", ")}` : "") +
      "." +
      (this._sandboxUnavailable
        ? " WARNING: no OS sandbox backend (sandbox-exec/bwrap) is available on this host; `bash` commands will be REFUSED. Set sandbox.mode=\"off\" or sandbox.fallback=\"allow-unsandboxed\" to override."
        : "");
    // Advertise custom sub-agents (claude-code `.claude/agents/` equivalent).
    const customAgentsBlock = renderCustomAgentsBlock(this.customAgents);
    // If a checkpoint exists for this session, append a short summary of
    // it to the system prompt. This is what enables a "resume" without
    // replaying the JSONL: the agent sees the last checkpoint's distilled
    // state plus the events added since the checkpoint boundary.
    const checkpoint = await readCheckpoint(this.cwd, this.id);
    const resumeNote = checkpoint
      ? `\n\n${summariseCheckpointForPrompt(checkpoint)}`
      : "";
    this.systemPromptCache = await buildSystemPrompt({
      cwd: this.cwd,
      sessionId: this.id,
      hostSurface: this.hostSurface,
      memory,
      plan,
      toolNames,
      toolSummaries,
      toolReference,
      extra: (this.systemPromptExtra ?? "") +
        (customAgentsBlock ? `\n\n${customAgentsBlock}` : "") +
        resumeNote +
        `\n\n${sandboxNote}`,
      model: this.model,
      provider: this.config.provider ?? "anthropic",
      mode: this.mode,
      outputStyle: this.outputStyle,
    });
  }

  private async maybeCompact(): Promise<void> {
    // Master toggle: when autoCompact is explicitly false, the session
    // never auto-compacts (the user must invoke /compact manually).
    if (this.config.autoCompact === false) return;
    const window = this.config.contextWindow ??
      lookupContextWindow(this.model).contextWindow;
    // Effective trigger point. Config may request a fraction of the window
    // (default 0.92, claude-code-style). The compaction engine's
    // `contextWindow` option IS the trigger threshold (it compacts when
    // tokens >= that value), so we pass the fraction-resolved threshold in.
    const fraction = this.config.compactionThreshold ?? 0.92;
    const trigger = Math.floor(window * fraction);
    const decision = shouldCompact(this.events, { contextWindow: trigger });
    if (!decision.shouldCompact) return;
    // PreCompact hooks may block compaction (e.g. to preserve state during
    // a long-running task). Manual compaction is trigger "manual"; the
    // threshold-driven path here is "auto".
    const pre = await this.hooks.runPreCompact("auto").catch(() => ({
      action: "allow" as const,
      warnings: [],
    }));
    if (pre.action === "block") {
      process.stderr.write(
        `[session] compaction blocked by PreCompact hook: ${pre.reason ?? "(no reason)"}\n`
      );
      return;
    }
    const result = await compact(this.events, {
      contextWindow: window,
      // Use the small provider for summarisation (best-effort).
      summariser: buildSmallProvider(this.config),
      summaryModel: this.config.smallModel,
    } as CompactionOptions);
    if (result.events === this.events) return; // no change
    this.events = result.events;
    // Rewrite the file to match the new event list.
    const path = sessionPath(this.id);
    await mkdir(SESSIONS_DIR, { recursive: true });
    const text = this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(path, text, "utf-8");
    // Notify listeners of the new compaction event.
    const compactionEvent = this.events.find((e) => e.type === "compaction");
    if (compactionEvent) this.notify(compactionEvent);
    await this.rebuildSystemPrompt();
    // PostCompact hooks fire after the new state is committed.
    const summary = compactionEvent && compactionEvent.type === "compaction"
      ? compactionEvent.summary
      : "";
    await this.hooks.runPostCompact("auto", summary).catch(() => undefined);
  }

  private async maybeCheckpoint(): Promise<void> {
    if (!this.checkpointHook) return;
    const threshold = this.config.contextWindow
      ? Math.floor(this.config.contextWindow * 0.8)
      : resolveCompactionThreshold(this.model, undefined);
    const trigger = this.checkpointHook.check(this.events, {
      tokenThreshold: threshold,
      turnsThreshold: 6,
    });
    if (!trigger.shouldCheckpoint) return;
    try {
      const result = await writeCheckpoint(this.cwd, this.id, this.events, {
        tokenThreshold: threshold,
        turnsThreshold: 6,
        summariser: buildSmallProvider(this.config),
        summaryModel: this.config.smallModel,
      });
      this.checkpointHook.hasCheckpoint = true;
      this.checkpointHook.lastCheckpointAt = this.events.length;
      // Clear the sidecar title if it duplicates the checkpoint header —
      // the checkpoint now carries the canonical title.
      if (this.title && result.bytes > 0) {
        const cp = await readCheckpoint(this.cwd, this.id);
        const m = cp?.match(/^#\s+Checkpoint for (.+)$/m);
        if (m && m[1] && m[1].length <= 60 && !this.title) {
          this.title = m[1];
        }
      }
    } catch (err) {
      process.stderr.write(
        `[session] checkpoint write failed: ${(err as Error).message}\n`
      );
    }
  }

  /** Produce a short title for the session. Tries the small model first,
   *  then falls back to a deterministic prefix of the first user text. */
  private async refreshTitle(firstUserText: string): Promise<void> {
    const fallback = deriveTitleFromText(firstUserText);
    let candidate: string | null = null;
    try {
      const provider = buildSmallProvider(this.config);
      candidate = await callTitleModel(provider, firstUserText, this.config.smallModel);
    } catch {
      /* ignore */
    }
    const title = sanitizeTitle(candidate ?? fallback);
    if (title) await this.setTitle(title);
  }
}

// ---------------------------------------------------------------------------
// Re-exports: standalone helpers that used to live in this file. Kept so
// existing `import { ... } from "./session.js"` callers keep working; new
// code should import from "./session-utils.js" (or the barrel) directly.
// ---------------------------------------------------------------------------
export {
  SESSIONS_DIR,
  getSessionsDir,
  createSession,
  listSessions,
  searchSessions,
  exportSession,
  deleteSession,
} from "./session-utils.js";
export type {
  RichSessionSummary,
  SessionExportFormat,
} from "./session-utils.js";
