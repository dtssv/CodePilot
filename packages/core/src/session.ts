// Session: owns the tool registry, permissions, provider, and event log.
// Persists events as JSONL under ~/.codepilot/sessions/<id>.jsonl.
//
// Enhancements (2025-Q1):
// - Automatic session title: derived from the first user message; if a
// small model is configured, a tighter 10-char title is produced and
// cached. The model is asked via the smallModel provider; failures fall
// back to a deterministic prefix.
// - Checkpoint integration: a CheckpointHook is initialised in `init`;
// on each prompt the hook inspects the event log and writes a fresh
// checkpoint when triggered (token count, round count).
// - searchSessions / exportSession: pure helpers, useful from CLI and
// from `listSessions` enrichments.
//
// Module layout (2026-Q3 split):
// - session.ts — the Session class itself (this file).
// - session-mcp.ts — MCP server startup, tool registration, and the
// `@mcp:` prompt-reference resolution.
// - session-telemetry.ts— per-prompt span lifecycle (start/end).
// - session-utils.ts — standalone helpers (paths, titles, providers,
// createSession/listSessions/searchSessions/...).
// The helpers moved to session-utils are re-exported at the bottom of this
// file so existing `import { ... } from "./session.js"` callers keep working.

import { appendFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { type AgentDeps } from "./agent.js";
import { runtimeRegistry, type AgentRuntime } from "./runtime.js";
import type {
  AgentMode,
  CodepilotConfig,
  Event,
  FollowUpItem,
  ImageAttachment,
  PermissionDecision,
  PermissionRequest,
  PromptFile,
  SessionOptions,
  SessionSummary,
} from "./types.js";
import { ToolRegistry } from "./tools/types.js";
import { ArtifactStore } from "./tools/artifacts.js";
import { PermissionEngine } from "./permissions.js";
import { readMemory, readLayeredProjectMemory, FileMemorySink, summariseMemory } from "./memory.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { compact, liveTranscript, renderTranscriptArchive, shouldCompact, type CompactionOptions } from "./compaction.js";
import { extractPlan, estimateEventTokens } from "./compaction.js";
import { createSubagentRunner } from "./subagent.js";
import { discoverCustomAgents, renderCustomAgentsBlock, type CustomAgent } from "./customAgents.js";
import { loadAutoMemoryIndex, type AutoMemoryConfig } from "./autoMemory.js";
import { AuditLogger } from "./audit.js";
import { writePlanFile, setPlanFileStatus } from "./plans.js";
import { PersistentShell } from "./persistentShell.js";
import {
  extractDeliveryRootsFromText,
  formatDeliveryRoots,
  mergeDeliveryRoots,
  normalizeRoot,
} from "./deliveryRoots.js";
import type { McpManager } from "./mcp.js";
import { startMcp as startMcpImpl, resolveSessionMcpReferences } from "./session-mcp.js";
import { startPromptSpan, endPromptSpan, type PromptSpan } from "./session-telemetry.js";
import { CORE_VERSION, linkIdForEvent, readGitBranch, stampEventMeta } from "./eventMeta.js";
import {
  resolveModelAlias,
  useProvider,
  type ResolvedCodepilotConfig,
} from "./config.js";
import {
  applyProviderAndModel,
  findProviderIdForFlat,
  resolveDefaultModel,
} from "./providerCatalog.js";
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
import { onJobCompletion, readJobLog } from "./tools/bashJobs.js";
import type { OutputStyle } from "./systemPrompt.js";
import {
  resolveSandbox,
  detectSandboxBackend,
  wrapCommand,
  addWritableRoot,
  type ResolvedSandbox,
} from "./sandbox.js";
import { readUserConfigFile, writeUserConfigFile } from "./providerCatalog.js";
import { DedupCache } from "./doomLoop.js";
import { resolveImageMentions } from "./imageMentions.js";
import { materializeUploads } from "./promptFiles.js";
import { ensureProjectState, projectStatePath, scratchDir } from "./projectState.js";
import { HookEngine } from "./hooks.js";
import {
  buildStopTranscriptHint,
  resolveStopVerifyMode,
  runBuiltinStopVerify,
} from "./stopVerify.js";
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
  persistSessionCwd,
  sanitizeTitle,
  historyArchivePath,
  sessionPath,
  titleSidecarPath,
  type RichSessionSummary,
} from "./session-utils.js";

/** Max consecutive Stop-hook continues before the session forces an end
 * (Claude Code default posture). `0` disables continues entirely. */
const DEFAULT_STOP_HOOK_BLOCK_CAP = 8;

export class Session {
  readonly id: string;
  readonly cwd: string;
 /** Mutable runtime config — updated by setProvider / setEndpoint. */
  private config: CodepilotConfig;
 /** Active model. Mutable via setModel and turn-scoped overrides. */
  private model: string;
 /** Active named provider preset id, when known. */
  private activeProviderId: string | undefined;
  private readonly systemPromptExtra: string | undefined;
  private readonly onPermissionRequest?: (
    req: PermissionRequest
  ) => Promise<PermissionDecision>;
  private readonly onAskUser?: SessionOptions["onAskUser"];
  private readonly onMcpServerRequest?: SessionOptions["onMcpServerRequest"];
  private readonly onMcpOpenAuthUrl?: SessionOptions["onMcpOpenAuthUrl"];
  private readonly diagnosticsProvider?: SessionOptions["diagnosticsProvider"];
 /** Provider override (from Agent SDK / replay mode). When set, skips buildProvider. */
  private readonly providerOverride?: import("./providers/types.js").ChatProvider;
 /** Files the agent has written/edited this session, for snapshot rewind. */
  private touchedFiles: Set<string> = new Set();
 /** Unsubscribe functions for background-job completion listeners. */
  private jobListeners: Array<() => void> = [];

  private events: Event[] = [];
 /** Append-only mirror of the session JSONL. `events` is the model view
 * (may start at the last compaction); this log keeps every turn. */
  private persisted: Event[] = [];
 /** Parent-chain tip for the next persisted event (`EventMeta.parentId`). */
  private lastPersistedLinkId: string | undefined;
 /** Cached `git rev-parse --abbrev-ref HEAD` for event metadata. */
  private gitBranchCache: string | undefined;
  private listeners = new Set<(e: Event) => void>();
  private cancelController: AbortController | null = null;
 /** Session-scoped idempotent-result cache. Persists across prompts so a
 * file read in one turn is replayed (not re-read) in the next. */
  private readonly dedupCache = new DedupCache();
 /** Mid-run steering messages queued via steer; drained each agent turn.
  * `user` items are genuine human input and enter the transcript as user
  * messages. `system` items are engine-generated notices (e.g. background
  * job completion) and are injected into the per-turn runtime_context so
  * they can never be mistaken for — or spoof — a user message. */
  private steeringQueue: Array<{ source: "user" | "system"; text: string }> = [];
 /** Prompts waiting to run after the current busy `prompt()` finishes. */
  private followUpQueue: FollowUpItem[] = [];
 /** Prevents overlapping drainFollowUps kicks. */
  private drainingFollowUps = false;
  private toolRegistry: ToolRegistry;
  private artifacts: ArtifactStore;
  private permissions: PermissionEngine;
  private sandbox: ResolvedSandbox;
 /** True when sandbox mode is active but no OS backend is available and
 * fallback is "deny". Bash commands will be refused; surfaced as a
 * system-prompt note and via getSandboxStatus. */
  private _sandboxUnavailable = false;
  private hooks: HookEngine;
  private mcp: McpManager | null = null;
  private systemPromptCache: { staticPrefix: string; dynamicSuffix: string; full: string } | null = null;
  private disposed = false;
 /** Current Collaboration mode (default "agent"). */
  private mode: AgentMode = "agent";
 /** Output style (default "concise"). Controls verbosity/teaching posture. */
  private outputStyle: OutputStyle = "concise";
 /** Auto-title, generated after the first prompt. */
  private title: string | null = null;
 /** Cached checkpoint hook — initialised in `init`. */
  private checkpointHook: CheckpointHook | null = null;
 /** Aggregated usage across all prompts of this session. */
  private usageTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** Latest single-request provider `input` tokens (not cumulative). */
  private lastProviderInputTokens = 0;
 /** Set when the session was loaded with a stale in-flight status (the prior
 * run was interrupted by a crash/restart). Drives a one-shot recovery
 * instruction in the system prompt so the next turn resumes from the
 * checkpoint instead of redoing work or drifting out of scope. Cleared
 * after the first prompt completes. */
  private resumedFromInterrupt = false;
 /** Aggregate request timing across this session (persisted via `request`
 * events; this is the in-memory rollup for getStats/summaries). */
  private requestStats = { count: 0, totalMs: 0, lastMs: 0, lastTtftMs: 0, slowestMs: 0 };
 /** Custom sub-agents discovered from .codepilot/agents/ + ~/.codepilot/agents/. */
  private customAgents: Map<string, CustomAgent> = new Map();
 /** The host surface this session is running in: "cli" | "tui" | "vscode" | "idea".
 * Set by the host (TUI/IDE) so the prompt can tailor advice. Defaults to "cli". */
  private hostSurface: "cli" | "tui" | "vscode" | "idea" = "cli";
  /** The persistent shell shared across foreground bash calls. Lazily started. */
  private persistentShell: PersistentShell | null = null;
  /**
   * Where intentional project deliverables should land for this task.
   * Starts as `[cwd]`; extended from path tokens in user prompts and from
   * mid-turn approval when a write falls outside. Distinct from sandbox
   * writable roots.
   */
  private deliveryRoots: string[] = [];
 /** The permission mode active before the user entered plan mode, so we can
 * restore it on approval. */
  private prePlanMode: AgentMode | null = null;
 /** The slug of the plan file most recently written by plan_done, so
 * setPlanFileStatus can update it after the user approves. */
  private lastPlanSlug: string | null = null;
 /** Turn-scoped overrides. Set by
 * `setTurnOverrides` (e.g. from a custom `/name` command's frontmatter
 * `model` / `allowed-tools`). Applied to the NEXT `prompt` only and
 * cleared in the finally block — so the session model + permission
 * grants resume on the user's next message. */
  private turnOverrideModel: string | null = null;
  private turnOverrideAllowedTools: string[] | null = null;
 /** Saved rule list + effect so clearTurnOverrides can pop exactly what
 * setTurnOverrides pushed (rules are append-only on the engine). */
  private turnOverrideRuleCount = 0;
 /** Resolved agent runtime name (default loop when undefined). */
  private runtimeName: string | undefined;
 /** The live runtime instance, lazily resolved at the first prompt. */
  private runtime: AgentRuntime | null = null;

  constructor(
    id: string,
    opts: Required<Pick<SessionOptions, "cwd" | "config" | "model">> & SessionOptions
  ) {
    this.id = id;
    this.cwd = opts.cwd;
    this.deliveryRoots = [normalizeRoot(opts.cwd)];
    this.config = opts.config ?? {};
    const resolved =
      (opts.model && opts.model.length > 0 ? opts.model : undefined) ??
      this.config.model ??
      resolveDefaultModel(this.config as ResolvedCodepilotConfig)?.model;
    this.model = resolved ?? "";
    this.activeProviderId = findProviderIdForFlat(
      this.config as ResolvedCodepilotConfig,
    );
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
    this.artifacts = new ArtifactStore(projectStatePath(opts.cwd, "artifacts"));
    this.permissions = new PermissionEngine({
      permissionMode: this.config.permissionMode,
      autoApprove: this.config.autoApprove,
      permissions: this.config.permissions,
    });
    this.sandbox = resolveSandbox(this.config.sandbox, this.cwd);
 // Determine whether an OS sandbox backend actually enforces the policy.
 // When the mode is active but no backend exists, bash is NOT truly jailed
 // (it runs unsandboxed or is refused) — so the permission engine must not
 // treat it as sandbox-confined.
    const osEnforced =
      this.sandbox.mode !== "off" && detectSandboxBackend() !== "none";
    if (this.sandbox.mode !== "off" && detectSandboxBackend() === "none" && this.sandbox.fallback === "deny") {
      this._sandboxUnavailable = true;
    }
 // Let the permission engine auto-allow actions confined to the sandbox
 // (writes inside writable roots; ordinary bash commands) — the process
 // sandbox already contains them, so prompting is friction without safety.
 // Only when the OS backend actually enforces the jail.
 // Always wire policy so out-of-root writes can prompt to expand
 // writablePaths. Bash auto-allow still requires OS enforcement inside
 // PermissionEngine (osEnforced flag).
    this.permissions.setSandbox(this.sandbox, this.cwd);
    this.hooks = new HookEngine(this.config.hooks, this.cwd);
 // Opt-in: run command hooks under the same OS sandbox as `bash`.
    if (this.config.hookSandbox) {
      this.hooks.setCommandSandbox(this.sandbox);
    }
 // Wire hook trust (hash-based review for command hooks, ).
    this.hooks.setTrustFile(projectStatePath(this.cwd, "hook_trust.json"));
    this.hooks.onWarning = (message) => {
      const ev: Event = { type: "error", message, recoverable: true };
      this.events.push(ev);
      void this.persistEvent(ev);
      this.notify(ev);
    };
  }

  /** Load from disk and configure registries. */
  async init(): Promise<void> {
    await ensureProjectState(this.cwd, { sessionId: this.id });
    await this.artifacts.init();
    this.registerBuiltins();
    await this.loadFromDisk();
 // Reconcile a stale "running" state: if the last persisted status is
 // `running`/`waiting_permission`, the prompt that set it was interrupted
 // by a crash or a server restart — there is no live run anymore. Without
 // this the UI shows the session as executing forever and the stop button
 // does nothing (there's no cancelController to abort). Stamp an `idle`
 // status so clients reflect reality on load.
    await this.reconcileStaleStatus();
 // Stamp cwd sidecar so listSessions can filter by workspace.
    await persistSessionCwd(this.id, this.cwd).catch(() => undefined);
    this.gitBranchCache = readGitBranch(this.cwd);
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
 // Show the user's command, not the sandbox-exec wrapper (which is a
 // giant useless string). Fall back to `command` for old jobs.
        const shown = (meta.displayCommand ?? meta.command).replace(/\s+/g, " ").trim().slice(0, 80);
        const failed =
          meta.status === "failed" ||
          (meta.status === "exited" && meta.exitCode !== 0 && meta.exitCode != null);
 // On failure, inline the log tail so the model can diagnose without
 // spending another large-context turn on bash_output just to see it.
        const emit = (tail?: string): void => {
          let msg = `Background job ${meta.id} (${shown}) ${status}.`;
          if (failed && tail && tail.trim()) {
            msg += `\nLast output:\n${tail.trim().slice(-800)}`;
          } else {
            msg += ` Use bash_output({ job_id: "${meta.id}" }) to read its output.`;
          }
          this.steerSystem(msg);
        };
        if (failed) {
          readJobLog(this.cwd, meta.id, 20).then(emit).catch(() => emit());
        } else {
          emit();
        }
      })
    );
    // Structured audit log (opt-in). Attached as a plain listener — NOT via
    // subscribe — so it records only new events, never re-logs replayed
    // history on resume. Fire-and-forget; never throws into the loop.
    if (this.config.audit) {
      const dir = typeof this.config.audit === "object" ? this.config.audit.dir : undefined;
      const logger = new AuditLogger(this.id, dir ? { dir } : {});
      this.listeners.add(logger.onEvent);
    }
  }

  /**
   * Start a user turn, or enqueue it if a turn is already running.
   * Returns `"queued"` when the text was added to the follow-up queue
   * instead of starting immediately.
   */
  async prompt(
    text: string,
    images?: ImageAttachment[],
    files?: PromptFile[],
  ): Promise<"started" | "queued"> {
    if (this.disposed) throw new Error("session disposed");
    if (this.isBusy()) {
      this.enqueueFollowUp({ text, images, files });
      return "queued";
    }
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
      this.cancelController = null;
      endPromptSpan(promptSpan);
      void this.drainFollowUps();
      return "started";
    }
    let effectivePrompt = promptHook.rewrittenPrompt ?? text;

 // Resolve `@mcp:<server>/<uri>` references into inline resource content.
 // This lets users paste MCP resource URIs into their prompt to inject
 // server-side context (e.g. `@mcp:github/repos/foo/bar`).
    effectivePrompt = await resolveSessionMcpReferences(this.mcp, effectivePrompt);

 // Extend delivery roots from path-like tokens in the user prompt
 // (absolute, ~/…, drive, or relative with a slash). Generic — any task.
    const mentionedRoots = extractDeliveryRootsFromText(effectivePrompt, this.cwd);
    if (mentionedRoots.length > 0) {
      const merged = mergeDeliveryRoots(this.deliveryRoots, mentionedRoots);
      this.deliveryRoots.length = 0;
      this.deliveryRoots.push(...merged);
      await this.rebuildSystemPrompt().catch(() => undefined);
    }

    const mentioned = await resolveImageMentions(effectivePrompt, this.cwd);
    if (mentioned.failures.length > 0) {
      const ev: Event = {
        type: "error",
        message: `could not attach image: ${mentioned.failures.join("; ")}`,
        recoverable: true,
      };
      this.events.push(ev);
      await this.persistEvent(ev);
      this.notify(ev);
    }
    const attachedImages = [...(images ?? []), ...mentioned.images];

 // Uploads are written to disk and listed on the message event. The
 // attachment note is injected only when building the provider prompt
 // (see agent-messages) so the user's bubble stays clean.
    let savedUploads: Awaited<ReturnType<typeof materializeUploads>> = [];
    if (files?.length) {
      try {
        savedUploads = await materializeUploads(this.cwd, files);
        if (!effectivePrompt.trim() && savedUploads.length > 0) {
          effectivePrompt = savedUploads.length === 1
            ? `Please look at the attached file (${savedUploads[0]!.name}).`
            : "Please look at the attached files.";
        }
      } catch (err) {
        const ev: Event = {
          type: "error",
          message: `could not save attached file: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: true,
        };
        this.events.push(ev);
        await this.persistEvent(ev);
        this.notify(ev);
        this.cancelController = null;
        endPromptSpan(promptSpan);
        void this.drainFollowUps();
        return "started";
      }
    }

    try {
 // Lazily start the persistent shell (one per session). Its cwd/env
 // persist across foreground bash calls so `cd` / `export` carry over.
      if (!this.persistentShell) {
        this.persistentShell = this.startPersistentShell();
      }
 // Apply turn-scoped overrides.
 // The model override applies to THIS prompt only; allowed-tools rules
 // were already pushed onto the permission engine by setTurnOverrides
 // and are popped in the finally block below.
      const effectiveModel = this.turnOverrideModel ?? this.model;
      // Shrink an already-oversize resumed transcript before the first send.
      await this.ensureContextUnderWindow();
      const deps: AgentDeps = {
        provider:
          this.providerOverride ??
          buildProvider({ ...this.config, model: effectiveModel }),
        tools: this.toolRegistry,
        artifacts: this.artifacts,
        permissions: this.permissions,
        config: { ...this.config, model: effectiveModel },
        cwd: this.cwd,
        systemPrompt: this.systemPromptCache ?? undefined,
        signal: this.cancelController.signal,
        agentMode: this.mode,
        sandbox: this.sandbox,
        expandSandboxWritable: (dir, opts) =>
          this.expandWritablePath(dir, opts).then(() => undefined),
        deliveryRoots: this.deliveryRoots,
        scratchDir: scratchDir(this.cwd, this.id),
        projectStateDir: projectStatePath(this.cwd),
        addDeliveryRoot: (dir) => this.addDeliveryRoot(dir),
        hooks: this.hooks,
        // Live handle — expandWritablePath may close+replace the shell
        // mid-turn; do not capture the instance by value.
        persistentShell: this.livePersistentShellHandle(),
        diagnosticsProvider: this.diagnosticsProvider,
        parentSpan: promptSpan,
        dedupCache: this.dedupCache,
        drainSteering: () => {
          const q = this.steeringQueue;
          this.steeringQueue = [];
          return q;
        },
        onEvent: async (e) => {
          if (e.type === "retry" || e.type === "activity") {
 // Transient UI notice — never part of the transcript.
            this.notify(e);
            return;
          }
 // Stream deltas are for live UI only. Persisting every 1–2 char
 // fragment balloons ~/.codepilot/sessions/*.jsonl (90%+ of events
 // in real runs) and inflates token estimates; the final `message`
 // event already holds the complete text / tool_use blocks.
          if (e.type === "message_delta") {
            this.notify(e);
            return;
          }
          if (e.type === "subagent") {
            const inner = e.event?.type;
            const replayable = inner === undefined || inner === "message" || inner === "tool_call" ||
              inner === "tool_result" || inner === "plan" || inner === "error";
            if (!replayable) {
              this.notify(e);
              return;
            }
            e = slimSubagentEvent(e);
          }
          this.events.push(e);
          await this.persistEvent(e);
          this.notify(e);
          if (
            e.type === "usage" &&
            typeof e.usage?.input === "number" &&
            e.usage.input > 0
          ) {
            this.lastProviderInputTokens = e.usage.input;
          }
 // plan_done approval: leave plan mode. Land in `agent` so the
 // approved plan can be executed — UNLESS the user entered plan mode
 // from `chat` (they wanted answers + a plan, not autonomous edits),
 // in which case restore `chat` and let them opt into agent mode.
          if (e.type === "mode_request") {
            const target = e.mode === "agent" && this.prePlanMode === "chat"
              ? "chat"
              : e.mode;
            await this.setAgentMode(target);
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
        // Mid-run compaction: agent already detected pressure (local estimate
        // OR last provider inputTokens). Force — do not re-gate on the local
        // estimator, which under-counts vs gateway usage and previously let
        // requests climb past the configured contextWindow (e.g. 220k > 200k).
        compactNow: async () => {
          const before = this.events;
          await this.maybeCompact({ force: true });
          if (this.events === before) return null;
          return this.events.slice();
        },
        lastProviderInputTokens: this.lastProviderInputTokens,
      };

 // Resolve the agent runtime. Default loop wraps
 // runAgent; unknown explicit names throw here so a misconfigured
 // plugin runtime never silently falls back to the default loop.
      const runtime = this.getRuntime();

      // Stop-hook continue loop: when a Stop hook blocks ending the turn,
      // re-enter the agent with the reason as feedback (capped).
      const stopCap =
        typeof this.config.stopHookBlockCap === "number" && this.config.stopHookBlockCap >= 0
          ? this.config.stopHookBlockCap
          : DEFAULT_STOP_HOOK_BLOCK_CAP;
      let stopHookActive = false;
      let stopContinueCount = 0;
      let turnText = effectivePrompt;
      let turnImages = attachedImages;
      let turnFiles = savedUploads;

      for (;;) {
        // Continues after Stop/stopVerify inject feedback for the model only
        // (`systemContinue`) — never as a persisted user bubble.
        const isStopContinue = stopContinueCount > 0;
        await runtime.prompt(
          {
            history: this.events,
            userText: isStopContinue ? "" : turnText,
            ...(isStopContinue
              ? { systemContinue: turnText }
              : {
                  images: turnImages.length > 0 ? turnImages : undefined,
                  files: turnFiles.length > 0 ? turnFiles : undefined,
                }),
          },
          deps,
        );

        // The interrupt-recovery guidance (if any) has now reached the model.
        this.resumedFromInterrupt = false;

        if (this.title == null && stopContinueCount === 0) {
          await this.refreshTitle(effectivePrompt);
        }

        await this.maybeCompact();
        await this.rebuildSystemPrompt().catch(() => undefined);
        await this.maybeCheckpoint();

        // User cancel: do not let Stop hooks force a continue.
        if (this.cancelController?.signal.aborted) break;

        const stopMode = resolveStopVerifyMode(this.config.stopVerify);
        const hasUserStop = this.hooks.hasHooks("Stop");
        if (stopMode === "off" && !hasUserStop) break;

        const stopPayload = {
          reason: stopContinueCount === 0 ? "prompt_completed" : "stop_hook_continue",
          stop_hook_active: stopHookActive,
          stop_continue_count: stopContinueCount,
          stop_continue_cap: stopCap,
          session_id: this.id,
          transcript_hint: buildStopTranscriptHint(this.events),
        };

        // Built-in validity gate first, then user-configured Stop hooks.
        let stopResult: import("./hooks.js").PreHookResult =
          stopMode === "off"
            ? { action: "allow", warnings: [] }
            : await runBuiltinStopVerify(stopMode, {
                cwd: this.cwd,
                ...stopPayload,
                resolvers: this.hooks.getResolvers(),
              }).catch((): import("./hooks.js").PreHookResult => ({
                action: "allow",
                warnings: ["built-in stopVerify threw; ignored"],
              }));

        if (stopResult.action !== "block" && hasUserStop) {
          stopResult = await this.hooks
            .runStop(stopPayload)
            .catch((): import("./hooks.js").PreHookResult => ({
              action: "allow",
              warnings: ["Stop hook threw; ignored"],
            }));
        }

        for (const w of stopResult.warnings) {
          // Soft skips / rate-limit noise from stopVerify stay off the transcript.
          if (/rate.?limit|\b429\b|skipped|no prompt resolver/i.test(w)) continue;
          const ev: Event = { type: "error", message: w, recoverable: true };
          this.events.push(ev);
          await this.persistEvent(ev).catch(() => undefined);
          this.notify(ev);
        }

        if (stopResult.action !== "block") break;

        if (stopContinueCount >= stopCap) {
          const ev: Event = {
            type: "error",
            message:
              `Stop verify kept blocking after ${stopCap} continue(s); ending the turn ` +
              `(set stopHookBlockCap to raise the limit, or stopVerify: "off").`,
            recoverable: true,
          };
          this.events.push(ev);
          await this.persistEvent(ev).catch(() => undefined);
          this.notify(ev);
          break;
        }

        stopContinueCount += 1;
        stopHookActive = true;
        const reason =
          stopResult.reason?.trim() ||
          "Stop verify blocked ending this turn without a reason.";
        // UI-only progress event (not persisted).
        this.notify({
          type: "stop_continue",
          count: stopContinueCount,
          cap: stopCap,
          reason,
        });
        turnText =
          `<stop_hook_continue count="${stopContinueCount}" cap="${stopCap}">\n` +
          `${reason}\n` +
          `Address this feedback, then finish the task. Do not stop until the ` +
          `concern is resolved or you must ask the user a clarifying question.\n` +
          `</stop_hook_continue>`;
        turnImages = [];
        turnFiles = [];
      }
    } finally {
      this.cancelController = null;
 // Clear turn-scoped overrides so the session model + permission
 // grants resume on the user's next message.
      this.clearTurnOverrides();
 // End the telemetry span (no-op when disabled).
      endPromptSpan(promptSpan);
 // Kick the next queued follow-up (if any) once we are no longer busy.
      void this.drainFollowUps();
    }
    return "started";
  }

 /**
 * Runtime collaboration-mode switch. Takes effect on the next `prompt`
 * (and on tool dispatch — see `runOneTool`'s mode gate in agent.ts). The
 * system prompt is rebuilt so the new mode's guidance reaches the model
 * on the next turn. Emits a `mode` event so subscribers (and protocol
 * clients) can react immediately.
 *
 * Plan-mode bookkeeping: when the
 * user enters `plan` mode, the previous mode is stashed in `prePlanMode`
 * so it can be restored on approval. When the agent calls `plan_done` and
 * the user approves, the session switches to `agent` mode (not back to
 * plan entry) — restore the pre-plan permission *tier*
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
 // If we're leaving plan mode (the plan_done approval path), mark the
 // plan file approved regardless of whether we land in agent or restore
 // chat — the user accepted the plan either way.
    if (this.mode === "plan" && mode !== "plan" && this.lastPlanSlug) {
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

 /** Active named provider preset id (undefined when using flat config only). */
  getProviderId(): string | undefined {
    return this.activeProviderId;
  }

 /** Snapshot of the runtime config (provider / baseURL / keys / models). */
  getConfig(): CodepilotConfig {
    return { ...this.config, model: this.model };
  }

 /** Read-only view of the system prompt the session currently sends (built
 * on init and after each prompt). Null until first built. Useful for hosts
 * that surface the active prompt and for tests. */
  getSystemPrompt(): { staticPrefix: string; dynamicSuffix: string; full: string } | null {
    return this.systemPromptCache;
  }

 /**
 * Merge named provider presets into the live session config (e.g. after the
 * user saves providers in Settings while a session is already open).
 */
  mergeProviders(providers: Record<string, import("./config.js").ProviderPreset>): void {
    const cur = (this.config as import("./config.js").ResolvedCodepilotConfig).providers ?? {};
    this.config = {
      ...this.config,
      providers: { ...cur, ...providers },
    } as CodepilotConfig;
  }

 /**
 * Persistently switch the session model (optionally across providers).
 * When `providerId` is set, applies that preset first via `useProvider`.
 * Emits a `{ type: "model" }` event for UI clients.
 */
  async setModel(model: string, providerId?: string): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    if (!model) return;
    if (providerId) {
      await this.setEndpoint({ model, providerId });
      return;
    }
    const resolved = resolveModelAlias({ ...this.config, model }) ?? model;
    if (resolved === this.model && !providerId) return;
    this.model = resolved;
    this.config = { ...this.config, model: resolved };
    await this.rebuildSystemPrompt();
    await this.emitModelEvent();
  }

 /**
 * Switch to a named provider preset from `config.providers`. Optionally
 * override the model (defaults to the preset's `model`).
 */
  async setProvider(providerId: string, model?: string): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    const applied = useProvider(this.config, providerId);
    const nextModel =
      model ??
      applied.model ??
      this.model;
    await this.setEndpoint({ model: nextModel, providerId });
  }

 /**
 * Switch provider + model in one step (cross-vendor picker).
 */
  async setEndpoint(opts: {
    model: string;
    providerId?: string;
  }): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    const { config, providerId, model } = applyProviderAndModel(
      this.config,
      opts.providerId,
      opts.model,
    );
    this.config = config;
    this.model = model;
    this.activeProviderId = providerId;
    await this.rebuildSystemPrompt();
    await this.emitModelEvent();
  }

  private async emitModelEvent(): Promise<void> {
    const ev: Event = {
      type: "model",
      model: this.model,
      providerId: this.activeProviderId,
    };
    this.events.push(ev);
    await this.persistEvent(ev);
    this.notify(ev);
  }

 /**
 * Set turn-scoped overrides. The
 * `model` override (use `"inherit"` to keep the session model) and the
 * `allowedTools` permission grant apply to the NEXT `prompt` only and
 * are cleared in that prompt's finally block — so the session resumes
 * its normal model + permission posture on the user's next message.
 *
 * Calling this while a prompt is running is a no-op (the overrides would
 * be cleared by the in-flight prompt's finally before they take effect);
 * hosts should call it immediately before `prompt`.
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

 /** True while a `prompt()` is in flight (including waiting on permission /
  * questions). Used by the protocol layer to keep background runs alive when
  * the last UI client disconnects (e.g. browser refresh) instead of cancelling. */
  isBusy(): boolean {
    return this.cancelController !== null;
  }

  cancel(): void {
    if (this.cancelController) {
 // Active run: abort it. The agent loop + provider stream observe the
 // signal and unwind; the prompt's own finally emits the idle status.
      this.cancelController.abort();
      return;
    }
 // No active run (e.g. the run was interrupted by a restart but the UI
 // still shows it as executing). Give the client a definitive `idle` so
 // the stop button always has an effect instead of silently no-opping.
 // Skip during disposal — no client is listening and we don't want to
 // append a trailing status to a session being torn down.
    if (this.disposed) return;
    const ev: Event = { type: "status", status: "idle" };
    this.events.push(ev);
    void this.persistEvent(ev).catch(() => undefined);
    this.notify(ev);
  }

 /**
 * Resolve the agent runtime for this session. The
 * instance is created lazily on first use and cached. Default name
 * (undefined or "default") yields the built-in loop that wraps
 * `runAgent`. A plugin-registered runtime is instantiated through its
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
    this.steeringQueue.push({ source: "user", text });
  }

  /** Snapshot of prompts waiting to run after the current busy turn. */
  listFollowUps(): FollowUpItem[] {
    return this.followUpQueue.map((item) => ({ ...item }));
  }

  /**
   * Enqueue a prompt to run after the current busy turn. Emits a `followup`
   * event for UIs. Safe while idle too (will drain on the next `finally`).
   */
  enqueueFollowUp(opts: {
    text: string;
    images?: ImageAttachment[];
    files?: PromptFile[];
  }): FollowUpItem {
    const item: FollowUpItem = {
      id: `fu_${randomUUID().slice(0, 8)}`,
      text: opts.text,
      images: opts.images,
      files: opts.files,
      queuedAt: Date.now(),
    };
    this.followUpQueue.push(item);
    this.emitFollowUp("queued");
    return item;
  }

  /** Remove one queued follow-up by id. Returns true if it was present. */
  removeFollowUp(id: string): boolean {
    const before = this.followUpQueue.length;
    this.followUpQueue = this.followUpQueue.filter((item) => item.id !== id);
    if (this.followUpQueue.length === before) return false;
    this.emitFollowUp("removed");
    return true;
  }

  /** Replace the text of a queued follow-up. Returns true if it was present. */
  updateFollowUp(id: string, text: string): boolean {
    const item = this.followUpQueue.find((x) => x.id === id);
    if (!item) return false;
    item.text = text;
    this.emitFollowUp("updated");
    return true;
  }

  /**
   * Take a queued follow-up and inject it into the current run (steer),
   * without cancelling. Text-only: attachments on the queued item are dropped
   * with a short note. When idle, starts a normal prompt (attachments kept).
   */
  sendFollowUpNow(id: string): "steered" | "started" | false {
    const idx = this.followUpQueue.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    const [item] = this.followUpQueue.splice(idx, 1);
    if (!item) return false;
    this.emitFollowUp("removed");

    if (this.isBusy()) {
      let text = item.text;
      if ((item.images?.length ?? 0) > 0 || (item.files?.length ?? 0) > 0) {
        text =
          `${text.trim()}\n\n[note: queued attachments were not injected into the ` +
          `current run — re-attach them if still needed.]`;
      }
      this.steer(text);
      return "steered";
    }

    void this.prompt(item.text, item.images, item.files);
    return "started";
  }

  /** Drop every queued follow-up. */
  clearFollowUps(): void {
    if (this.followUpQueue.length === 0) return;
    this.followUpQueue = [];
    this.emitFollowUp("cleared");
  }

  private emitFollowUp(
    action: "queued" | "removed" | "cleared" | "started" | "updated",
  ): void {
    const ev: Event = {
      type: "followup",
      action,
      items: this.listFollowUps(),
    };
    this.notify(ev);
  }

  /**
   * Start the next follow-up if idle. Called from `prompt()`'s finally and
   * after remove/clear when appropriate. Never overlaps a busy run.
   */
  private async drainFollowUps(): Promise<void> {
    if (this.disposed || this.drainingFollowUps || this.isBusy()) return;
    if (this.followUpQueue.length === 0) return;
    this.drainingFollowUps = true;
    try {
      while (!this.disposed && !this.isBusy() && this.followUpQueue.length > 0) {
        const next = this.followUpQueue.shift()!;
        this.emitFollowUp("started");
        await this.prompt(next.text, next.images, next.files);
      }
    } finally {
      this.drainingFollowUps = false;
    }
  }

 /**
  * Queue an engine-generated notice for the model's next turn. Unlike
  * {@link steer}, this is NOT persisted as a user message: it rides in the
  * per-turn runtime_context (like the plan-stall notice), so a system
  * notice can never be mistaken for — or impersonate — human input. Used
  * for background-job completion and similar out-of-band events.
  */
  private steerSystem(text: string): void {
    if (text.trim().length === 0) return;
    this.steeringQueue.push({ source: "system", text });
  }

 /** The long-lived shell for foreground bash, started inside the sandbox.
 * Null when the policy can't be enforced: bash then runs each command
 * one-shot, where the sandbox fallback (deny / warn) applies. */
  private startPersistentShell(): PersistentShell | null {
    if (this.sandbox.mode === "off") return new PersistentShell({ cwd: this.cwd });
    const shell = process.env.SHELL || "/bin/bash";
    const wrapped = wrapCommand(`exec ${shell} -i`, this.sandbox);
    if (!wrapped.sandboxed) return null;
    return new PersistentShell({
      cwd: this.cwd,
      shell: wrapped.shell ?? "/bin/sh",
      shellArgs: [...(wrapped.shellArgs ?? ["-c"]), wrapped.command],
    });
  }

  /**
   * Stable AgentDeps handle for bash. Always forwards to the current
   * `this.persistentShell` so a mid-turn `expandWritablePath` restart
   * does not leave tools holding a closed instance ("PersistentShell closed").
   */
  private livePersistentShellHandle(): AgentDeps["persistentShell"] {
    if (!this.persistentShell) return undefined;
    return {
      run: (command, opts) => {
        if (!this.persistentShell) {
          this.persistentShell = this.startPersistentShell();
        }
        if (!this.persistentShell) {
          return Promise.reject(new Error("PersistentShell unavailable after sandbox expand"));
        }
        return this.persistentShell.run(command, opts);
      },
    };
  }

 /** Current sandbox policy (read-only view for hosts/tests). */
  getSandbox(): ResolvedSandbox {
    return this.sandbox;
  }

 /**
 * Grant an extra writable directory (Claude-style add-dir).
 * `persist: true` also appends to user `sandbox.writablePaths`.
 * Restarts the persistent shell when an OS sandbox is active so bash
 * picks up the new roots.
 */
  /** Add a directory as a task delivery root (session-scoped).
   * Mutates the live array in place so mid-turn ToolContext stays current. */
  addDeliveryRoot(dir: string): void {
    const merged = mergeDeliveryRoots(this.deliveryRoots, [dir]);
    this.deliveryRoots.length = 0;
    this.deliveryRoots.push(...merged);
    void this.rebuildSystemPrompt().catch(() => undefined);
  }

  /** Current delivery roots (copy). */
  getDeliveryRoots(): string[] {
    return [...this.deliveryRoots];
  }

  async expandWritablePath(
    dir: string,
    opts: { persist?: boolean } = {},
  ): Promise<string> {
    addWritableRoot(this.sandbox, dir);
    this.config = {
      ...this.config,
      sandbox: {
        ...this.config.sandbox,
        mode: this.config.sandbox?.mode ?? this.sandbox.mode,
        writablePaths: [...this.sandbox.writablePaths],
      },
    };
    this.permissions.setSandbox(this.sandbox, this.cwd);
    if (this.persistentShell) {
      try {
        this.persistentShell.close();
      } catch {
 /* ignore */
      }
      this.persistentShell = this.startPersistentShell();
    }
    if (opts.persist) {
      await persistSandboxWritablePath(dir);
    }
    return resolve(dir);
  }

 /** Sandbox availability status. When `unavailable` is true, bash commands
 * are being refused because sandbox mode is active but no OS backend
 * exists and fallback is "deny". The host should surface this to the
 * user (e.g. a warning banner). */
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
 // Replay history first — the FULL transcript (see getHistory), not the
 // compacted model-facing set, so a UI that renders the replay keeps the
 // user's original messages after a compaction. Before any compaction the
 // two are identical, so this is a no-op for the common case.
    for (const e of this.persisted) {
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

 /**
  * The full append-only transcript, including turns that compaction dropped
  * from the model-facing set. Use this for DISPLAY (session list, resume,
  * reconnect) so the user keeps seeing their original messages after a
  * compaction — unlike {@link getEvents}, which returns the shortened,
  * model-facing working set. The two intentionally diverge once a
  * compaction has run: the model sees the summary + recent tail (token-
  * efficient), the UI sees everything (with the `compaction` event marking
  * where the summary was inserted).
  */
  getHistory(): Event[] {
    return this.persisted.slice();
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
 * base SessionSummary is kept tight for back-compat; callers that want
 * the rich fields use this method. */
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
    forked.deliveryRoots = [...this.deliveryRoots];
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
    this.followUpQueue = [];
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
    this.toolRegistry.register(readArtifactTool);
    this.toolRegistry.register(askUserQuestionTool);

 // The tools below carry per-session wiring (sink, plan file, sub-agent
 // runner). The exported objects are module singletons shared by every
 // session in the process, so each session registers its own copy —
 // mutating the shared one let the newest session's runner (its endpoint,
 // cwd and transcript) serve every other session's `task` calls.
    const memoryWrite = { ...memoryWriteTool };
    const planDone = { ...planDoneTool };
    const task = { ...taskTool };
    this.toolRegistry.register(memoryWrite);
    this.toolRegistry.register(task);
    this.toolRegistry.register(planDone);

 // Wire the memory sink (MEMORY.md + progressive index/topic mirror).
    memoryWrite.sink = new FileMemorySink(this.cwd, {
      autoMemory:
        this.config.autoMemoryEnabled === false ? false : { enabled: true },
    });

 // Wire plan_done's plan-file persistence. The plan is written to
 // .codepilot/plans/<slug>.md before the approval prompt; on approval the
 // file's status is updated.
    planDone.writePlan = async (summary, steps) => {
      const pf = await writePlanFile(this.cwd, this.id, summary, steps, {
        plansDirectory: this.config.plansDirectory,
        status: "pending",
      });
      this.lastPlanSlug = pf.slug;
      return pf.path;
    };
    planDone.currentPlan = () => extractPlan(this.events);

 // Wire the subagent runner so `task` works. "explore" agents are
 // read-only; "worker" agents additionally get write + bash tools.
    task.runner = createSubagentRunner({
      cwd: this.cwd,
      config: this.config,
      model: this.model,
      getEndpoint: () => ({ config: this.config, model: this.model }),
      permissions: this.permissions,
      onPermissionRequest: this.onPermissionRequest,
      getSandbox: () => this.sandbox,
      expandSandboxWritable: (dir, opts) =>
        this.expandWritablePath(dir, opts).then(() => undefined),
      getDeliveryRoots: () => this.deliveryRoots,
      addDeliveryRoot: (dir) => this.addDeliveryRoot(dir),
      scratchDir: () => scratchDir(this.cwd, this.id),
      projectStateDir: () => projectStatePath(this.cwd),
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
 // Per-sub-agent wall-clock budget (optional). Enforced by the task tool's
 // shared semaphore so a stuck worker can't starve a parallel fan-out.
    task.subagentTimeoutMs = this.config.subagentTimeoutMs;

    this.wireHookResolvers(task.runner);
  }

  /**
   * Wire prompt/agent/MCP resolvers so Stop (and other) hooks can use
   * non-command handlers. Safe to call once builtins are registered.
   */
  private wireHookResolvers(
    subagentRunner: ReturnType<typeof createSubagentRunner> | undefined,
  ): void {
    this.hooks.setResolvers({
      prompt: async (prompt, payload) => {
        const provider = buildSmallProvider(this.config);
        const model = this.config.smallModel ?? provider.smallModel ?? this.model;
        const body =
          `${prompt}\n\n` +
          `Respond with a single JSON object only, e.g. ` +
          `{"decision":"allow"} or {"decision":"block","reason":"…"}.\n\n` +
          `Payload:\n${JSON.stringify(payload).slice(0, 40_000)}`;
        let out = "";
        for await (const ev of provider.stream({
          model,
          messages: [{ role: "user", content: [{ type: "text", text: body }] }],
          maxTokens: 1024,
        })) {
          if (ev.kind === "text_delta") out += ev.text;
          if (ev.kind === "error") throw new Error(ev.message);
        }
        return out.trim();
      },
      agent: async (objective, payload) => {
        if (!subagentRunner) {
          return JSON.stringify({
            decision: "allow",
            reason: "agent hook: no sub-agent runner available",
          });
        }
        const result = await subagentRunner.run({
          objective:
            `${objective}\n\n` +
            `When finished, reply with JSON only: ` +
            `{"decision":"allow"} or {"decision":"block","reason":"…"}.\n\n` +
            `Context payload:\n${JSON.stringify(payload).slice(0, 20_000)}`,
          cwd: this.cwd,
          agentType: "explore",
          maxSteps: 20,
        });
        return result.conclusion.trim() || JSON.stringify({ decision: "allow" });
      },
      // Lazy: MCP starts after builtins; read `this.mcp` at call time.
      mcp: async (serverTool, args) => {
        const mgr = this.mcp;
        if (!mgr) throw new Error("MCP manager unavailable");
        const colon = serverTool.indexOf(":");
        const server = colon > 0 ? serverTool.slice(0, colon) : "";
        const tool = colon > 0 ? serverTool.slice(colon + 1) : serverTool;
        if (!server || !tool) throw new Error(`invalid mcp tool id: ${serverTool}`);
        const r = await mgr.invoke(server, tool, args);
        return (r.content ?? "").trim() || JSON.stringify(r);
      },
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
          this.persisted.push(JSON.parse(line) as Event);
        } catch {
 /* skip malformed */
        }
      }
      this.events = liveTranscript(this.persisted);
      for (let i = this.persisted.length - 1; i >= 0; i--) {
        const link = linkIdForEvent(this.persisted[i]!);
        if (link) {
          this.lastPersistedLinkId = link;
          break;
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

 /**
 * After loading history, clear a stale in-flight status. A session whose
 * last `status` event is `running` or `waiting_permission` was interrupted
 * mid-prompt (crash/restart) — the agent loop and its AbortController are
 * gone, so the run can never complete or be cancelled. We append a final
 * `idle` status (and persist it) so clients stop showing "executing" and
 * the user can prompt again. No-op for cleanly-finished sessions.
 */
  private async reconcileStaleStatus(): Promise<void> {
    let lastStatus: string | null = null;
    for (const e of this.events) {
      if (e.type === "status") lastStatus = e.status;
    }
    if (lastStatus === "running" || lastStatus === "waiting_permission") {
      const ev: Event = { type: "status", status: "idle" };
      this.events.push(ev);
      await this.persistEvent(ev).catch(() => undefined);
 // The prior run was cut off mid-flight. Flag it so the next prompt's
 // system prompt carries a recovery instruction (resume from checkpoint,
 // don't redo finished steps).
      this.resumedFromInterrupt = true;
    }
  }

  private async persistEvent(e: Event): Promise<void> {
    // Refresh branch occasionally (cheap spawn); keep last known value on miss.
    if (this.persisted.length % 25 === 0) {
      this.gitBranchCache = readGitBranch(this.cwd) ?? this.gitBranchCache;
    }
    const stamped = stampEventMeta(e, {
      cwd: this.cwd,
      gitBranch: this.gitBranchCache,
      parentId: this.lastPersistedLinkId,
      version: CORE_VERSION,
    });
    const link = linkIdForEvent(stamped);
    if (link) this.lastPersistedLinkId = link;
    this.persisted.push(stamped);
    const path = sessionPath(this.id);
    await mkdir(SESSIONS_DIR, { recursive: true });
    await appendFile(path, JSON.stringify(stamped) + "\n", "utf-8");
  }

  private async rebuildSystemPrompt(): Promise<void> {
    const memory = summariseMemory(await readMemory(this.cwd));
 // Hierarchical shareable docs (CODEPILOT.md / AGENTS.md in the tree) plus
 // agent-written project-state MEMORY.md (already in memory.project).
    const layered = await readLayeredProjectMemory(this.cwd);
    if (layered) {
      memory.project = memory.project
        ? `${memory.project.trim()}\n\n---\n\n${layered}`
        : layered;
    }
 // Progressive memory index (thin). Full topic bodies via read_file.
 // ~/.codepilot/memory/<project-hash>/MEMORY.md — capped at 200 lines / 25KB.
    const autoCfg: AutoMemoryConfig = { enabled: this.config.autoMemoryEnabled !== false };
    const autoIndex = await loadAutoMemoryIndex(this.cwd, autoCfg);
    if (autoIndex) {
      memory.progressive = autoIndex;
    }
    const plan = extractPlan(this.events);
 // The system prompt advertises the *mode-filtered* tool list, so the
 // model doesn't expect tools that aren't actually available.
    const visibleTools = filterToolsByModeFromRegistry(this.toolRegistry, this.mode);
    const toolNames = visibleTools.map((t) => t.name);
 // Sandbox posture is part of the prompt so the model knows its boundaries.
    const sb = this.sandbox;
    const sandboxNote =
      `Sandbox: mode=${sb.mode}, network=${sb.network ? "allowed" : "blocked"}` +
      (sb.mode !== "off" ? `, writes limited to ${sb.writableRoots.join(", ")}` : "") +
      "." +
      (this._sandboxUnavailable
        ? " WARNING: no OS sandbox backend (sandbox-exec/bwrap) is available on this host; `bash` commands will be REFUSED. Set sandbox.mode=\"off\" or sandbox.fallback=\"allow-unsandboxed\" to override."
        : "");
 // Advertise custom sub-agents.
    const customAgentsBlock = renderCustomAgentsBlock(this.customAgents);
 // If a checkpoint exists for this session, append a short summary of
 // it to the system prompt. This is what enables a "resume" without
 // replaying the JSONL: the agent sees the last checkpoint's distilled
 // state plus the events added since the checkpoint boundary.
    const checkpoint = await readCheckpoint(this.cwd, this.id);
    let resumeNote = checkpoint
      ? `\n\n${summariseCheckpointForPrompt(checkpoint)}`
      : "";
 // One-shot recovery only for a true crash/restart (stale running status).
 // A normal text-only turn end is not an interrupt — do not inject this.
    if (this.resumedFromInterrupt) {
      resumeNote +=
        `\n\n<interrupted_run>\n` +
        `The previous run in this session was cut off by a crash or server restart ` +
        `(not a normal end-of-turn, and not a user cancel). Treat the user's next ` +
        `message as continuing the same conversation:\n` +
        `- Read the plan and the checkpoint above to see which steps are already ` +
        `done — do NOT repeat completed work.\n` +
        `- Resume at the first unfinished step and stay inside the original task.\n` +
        `- If the prior state is unclear, briefly say what you think is done and ` +
        `ask before redoing it.\n` +
        `</interrupted_run>`;
    }
    const deliveryNote =
      `Delivery roots (intentional project deliverables — not the OS sandbox):\n` +
      formatDeliveryRoots(this.deliveryRoots) +
      `\nTemp/runtime files go in scratch_dir; expanding sandbox writablePaths does not change delivery roots.`;
    this.systemPromptCache = await buildSystemPrompt({
      cwd: this.cwd,
      sessionId: this.id,
      hostSurface: this.hostSurface,
      memory,
      plan,
      toolNames,
      scratchDir: scratchDir(this.cwd, this.id),
      projectStateDir: projectStatePath(this.cwd),
      deliveryRoots: this.deliveryRoots,
      extra: (this.systemPromptExtra ?? "") +
        (customAgentsBlock ? `\n\n${customAgentsBlock}` : "") +
        resumeNote +
        `\n\n${sandboxNote}` +
        `\n\n${deliveryNote}`,
      model: this.model,
      provider: this.config.provider ?? "anthropic",
      mode: this.mode,
      outputStyle: this.outputStyle,
    });
  }

  /**
   * If the last provider input (or a usage event on a resumed transcript)
   * already nears the configured window, force compaction before sending.
   */
  private async ensureContextUnderWindow(): Promise<void> {
    if (this.config.autoCompact === false) return;
    const window =
      this.config.contextWindow ?? lookupContextWindow(this.model).contextWindow;
    if (this.lastProviderInputTokens <= 0) {
      for (let i = this.events.length - 1; i >= 0; i--) {
        const e = this.events[i]!;
        if (e.type === "usage" && typeof e.usage?.input === "number" && e.usage.input > 0) {
          this.lastProviderInputTokens = e.usage.input;
          break;
        }
      }
    }
    if (this.lastProviderInputTokens >= Math.floor(window * 0.9)) {
      await this.maybeCompact({ force: true });
    }
  }

  private async maybeCompact(opts: { force?: boolean } = {}): Promise<void> {
 // Master toggle: when autoCompact is explicitly false, the session
 // never auto-compacts (the user must invoke /compact manually).
    if (this.config.autoCompact === false) return;
    const modelWindow = lookupContextWindow(this.model);
    const window = this.config.contextWindow ?? modelWindow.contextWindow;
 // Effective trigger point. Config may request a fraction of the window
 // (default 0.92). The compaction engine's `contextWindow` option IS the
 // trigger threshold (it compacts when tokens >= that value). Cap by a
 // hard usable window (reserve output tokens) so we never wait until the
 // provider rejects the request.
    const fraction = this.config.compactionThreshold ?? 0.92;
    const outputReserve = Math.max(
      1_024,
      this.config.maxTokens ?? modelWindow.maxOutputTokens ?? 8_192,
    );
    const hardUsable = Math.max(4_000, window - outputReserve);
    const trigger = Math.min(hardUsable, Math.floor(window * fraction));
    if (!opts.force) {
      const decision = shouldCompact(this.events, { contextWindow: trigger });
      if (!decision.shouldCompact) return;
    }
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
      contextWindow: trigger,
      force: opts.force === true,
 // Use the small provider for summarisation (best-effort).
      summariser: buildSmallProvider(this.config),
      summaryModel: this.config.smallModel,
    } as CompactionOptions);
    if (result.events === this.events) return; // no change
    // Local estimate no longer reflects the last oversize API call.
    if (opts.force) this.lastProviderInputTokens = 0;
    if (result.droppedRange) {
 // The original transcript stays on disk; some UIs
 // then tells the model where to re-read it. We do both: leave the
 // JSONL append-only, and write a Markdown archive the model can grep.
      const head = result.events[0];
      if (head?.type === "compaction") {
        let keepFrom = this.persisted.length;
        for (const e of result.events.slice(1)) {
          const idx = this.persisted.indexOf(e);
          if (idx >= 0) {
            keepFrom = idx;
            break;
          }
        }
        const archive = historyArchivePath(this.id);
        let pointer = "";
        try {
          const dropped = this.events.slice(result.droppedRange.from, result.droppedRange.to);
          await appendFile(
            archive,
            `\n## Compacted ${new Date().toISOString()}\n\n${renderTranscriptArchive(dropped)}`,
            "utf-8",
          );
          pointer =
            `\n\nFull text of the summarised turns: ${archive} (Markdown, oldest first). ` +
            `When you need something exact from before this summary — a design or plan you wrote, code, ` +
            `an error message, the user's literal words — grep that file for a keyword and read around ` +
            `the match instead of guessing or redoing the work.`;
        } catch {
 /* archive is best-effort; the JSONL still has the turns */
        }
        result.events[0] = { ...head, keepFrom, summary: `${head.summary}${pointer}` };
      }
    }
    this.events = result.events;
 // Append only events the JSONL does not already have (the new summary,
 // and a rescued plan if compact synthesised one). Never rewrite —
 // dropped turns stay in the file for resume / export / grep.
    for (const e of this.events) {
      if (this.persisted.includes(e)) continue;
      await this.persistEvent(e);
    }
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
 * then falls back to a deterministic prefix of the first user text. */
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

/** Append a path to user-level `sandbox.writablePaths` (idempotent). */
async function persistSandboxWritablePath(dir: string): Promise<void> {
  const abs = resolve(dir);
  const { raw } = await readUserConfigFile();
  const sandbox =
    raw.sandbox && typeof raw.sandbox === "object"
      ? { ...(raw.sandbox as Record<string, unknown>) }
      : {};
  const prev = Array.isArray(sandbox.writablePaths)
    ? (sandbox.writablePaths as string[])
    : [];
  if (prev.some((p) => resolve(p) === abs)) return;
  sandbox.writablePaths = [...prev, abs];
  raw.sandbox = sandbox;
  await writeUserConfigFile(raw);
}

/** Sub-agent tool outputs are only for display; cap them so a fan-out that
 * reads big files doesn't balloon the parent's JSONL. */
const SUBAGENT_RESULT_CAP = 4_000;
function slimSubagentEvent(e: Extract<Event, { type: "subagent" }>): Event {
  const inner = e.event;
  if (inner?.type !== "tool_result" || inner.content.length <= SUBAGENT_RESULT_CAP) return e;
  return {
    ...e,
    event: {
      ...inner,
      content: `${inner.content.slice(0, SUBAGENT_RESULT_CAP)}\n… [${inner.content.length - SUBAGENT_RESULT_CAP} more chars]`,
      images: undefined,
    },
  };
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
