// Session: owns the tool registry, permissions, provider, and event log.
// Persists events as JSONL under ~/.codepilot/sessions/<id>.jsonl.
//
// Module split (2026-Q3): session.ts (this file), session-mcp.ts (MCP startup
// + `@mcp:` refs), session-telemetry.ts (span lifecycle), session-utils.ts
// (helpers, re-exported here for backward-compatible imports).

import { appendFile, mkdir, readFile, writeFile, stat, truncate } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { type AgentDeps } from "./agent.js";
import {
  createPromptPermissionClassifier,
  type PermissionClassifier,
} from "./permissionClassifier.js";
import { INTERRUPTED_RESULT, NOT_STARTED_RESULT, decideLazyMcp, buildProviderMessages, buildProviderToolDefs, listAdvertisedToolNames } from "./agent-messages.js";
import { runtimeRegistry, type AgentRuntime, type PluginToolDef } from "./runtime.js";
import { BoundedSinkQueue } from "./sessionSink.js";
import type {
  AgentMode,
  CodepilotConfig,
  Event,
  FollowUpItem,
  ImageAttachment,
  InterruptedRunInfo,
  PermissionDecision,
  PermissionMode,
  PermissionPresetName,
  PermissionResolution,
  PermissionRequest,
  PromptFile,
  SessionOptions,
  SessionSummary,
} from "./types.js";
import { PERMISSION_PRESETS } from "./types.js";
import { ToolRegistry, zodToJsonSchema, type ToolDef } from "./tools/types.js";
import { buildSubagentToolRegistry } from "./tools/subagentTools.js";
import { ArtifactStore } from "./tools/artifacts.js";
import { PermissionEngine } from "./permissions.js";
import { readMemory, readLayeredProjectMemory, readCompactInstructions, FileMemorySink, summariseMemory } from "./memory.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { compact, liveTranscript, renderTranscriptArchive, shouldCompact, type CompactionOptions, type CompactionResult } from "./compaction.js";
import {
  extractPlan,
  estimateEventTokens,
  compactionGeometry,
  mergeCompactInstructions,
  DEFAULT_COMPACTION_FRACTION,
  PROVIDER_INPUT_COMPACTION_RATIO,
  HARD_TRIM_RATIO,
  FORCED_SHRINK_RATIO,
} from "./compaction.js";
import { createSubagentRunner } from "./subagent.js";
import { discoverCustomAgents, renderCustomAgentsBlock, type CustomAgent } from "./customAgents.js";
import { discoverSkills, type Skill } from "./skills.js";
import { createSkillTool, StaticSkillStore, type SkillToolHandle } from "./tools/skill.js";
import { LspManager } from "./lsp.js";
import { makeLspNavigateTool } from "./tools/lsp_navigate.js";
import { loadAutoMemoryIndex, type AutoMemoryConfig } from "./autoMemory.js";
import { recallRelevantMemories } from "./memoryRecall.js";
import {
  extractSessionMemory,
  maybeConsolidateMemory,
  type MemoryConsolidationConfig,
} from "./memoryConsolidation.js";
import { AuditLogger } from "./audit.js";
import { compileRedactionPatterns } from "./redact.js";
import { writePlanFile, setPlanFileStatus } from "./plans.js";
import { PersistentShell } from "./persistentShell.js";
import {
  extractDeliveryRootsFromText,
  formatDeliveryRoots,
  mergeDeliveryRoots,
  normalizeRoot,
} from "./deliveryRoots.js";
import type { McpManager } from "./mcp.js";
import { acquireSessionLock, type SessionLease } from "./sessionLock.js";
import { startMcp as startMcpImpl, resolveSessionMcpReferences, jsonSchemaToZod, formatInboundNotification } from "./session-mcp.js";
import type { McpServerRequestHandler } from "./mcp-types.js";
import { startPromptSpan, endPromptSpan, type PromptSpan } from "./session-telemetry.js";
import { getTracer } from "./telemetry.js";
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
  imageGenTool,
  resolveImageEndpoint,
  readFileTool,
  readImageTool,
  writeFileTool,
  editFileTool,
  applyPatchTool,
  codeModeTool,
  harnessBridgeTool,
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
  startNewTaskTool,
  suggestModeTool,
  startGoalTool,
  goalStatusTool,
  makeMcpMetaTool,
  makeToolCatalogTool,
  filterToolsByModeFromRegistry,
  filterToolsByModel,
  subagentListTool,
  subagentWaitTool,
  subagentInterruptTool,
  BackgroundSubagentRegistry,
  type BackgroundSubagentMeta,
} from "./tools/index.js";
import { onJobCompletion, readJobLog } from "./tools/bashJobs.js";
import type { OutputStyle } from "./systemPrompt.js";
import {
  resolveSandbox,
  detectSandboxBackend,
  buildSandboxUnavailable,
  wrapCommand,
  addWritableRoot,
  isWriteOutsideSandbox,
  type ResolvedSandbox,
  type SandboxBackend,
  type SandboxUnavailable,
} from "./sandbox.js";
import { readUserConfigFile, writeUserConfigFile } from "./providerCatalog.js";
import { DedupCache } from "./doomLoop.js";
import { FileObservationStore } from "./fsObservation.js";
import { resolveImageMentions } from "./imageMentions.js";
import { materializeUploads } from "./promptFiles.js";
import { ensureProjectState, projectStatePath, scratchDir } from "./projectState.js";
import { HookEngine } from "./hooks.js";
import {
  buildStopTranscriptHint,
  effectiveStopVerifyMode,
  resolveStopVerifyForceContinue,
  runBuiltinStopVerify,
  STOP_VERIFY_ADVICE_PREFIX,
} from "./stopVerify.js";
import { estimateTokens, estimateCostUSD, lookupContextWindow, resolveCompactionThreshold } from "./tokens.js";
import { analyzeCacheWaste, type CacheTurn, type CacheWasteReport } from "./cacheStats.js";
import { decideCacheWarm, cacheTtlMs } from "./cacheWarmer.js";
import {
  writeCheckpointFromSnapshot,
  buildCheckpointSnapshot,
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
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { thawSession, readColdSessionText } from "./sessionCompression.js";
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

 /** Max consecutive Stop-hook continues before the session forces an end.
 * `0` disables continues entirely. */
const DEFAULT_STOP_HOOK_BLOCK_CAP = 8;

/** Default continue cap for a FORCED built-in stopVerify (stopVerify.forceContinue
 * = true) when stopHookBlockCap is unset. Deliberately low: a false negative at
 * the completion boundary should re-run at most a couple of times, not spin to
 * the full user Stop-hook cap. */
const DEFAULT_STOP_VERIFY_FORCE_CAP = 2;

/** Checkpoint fires at this fraction of the compaction hard trigger, so it
 * always snapshots pre-compaction state (checkpoint ≤ compaction) no matter
 * how large the output reserve pushes the compaction trigger down. */
const CHECKPOINT_BELOW_COMPACTION_RATIO = 0.9;

/** Default number of consecutive failed/ineffective auto-compactions before the
 * circuit breaker disables auto-compaction for the session. */
const DEFAULT_AUTOCOMPACT_MAX_FAILURES = 3;

/** A queued mid-run steering message. See `steeringQueue`. */
interface SteeringItem {
  source: "user" | "system";
  text: string;
  delivery: "steer" | "followup";
}

/** Sandbox availability status returned by {@link Session.getSandboxStatus} and
 * {@link Session.setSandboxMode}. When `unavailable` is true the active sandbox
 * mode has no usable OS backend and bash is being refused (fail-closed);
 * `reason` then carries structured, platform-specific install guidance. */
export interface SandboxStatus {
  mode: ResolvedSandbox["mode"];
  unavailable: boolean;
  backend: SandboxBackend;
  reason?: SandboxUnavailable;
}

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
  ) => Promise<PermissionResolution>;
  private readonly onAskUser?: SessionOptions["onAskUser"];
  private readonly onGoalRequest?: SessionOptions["onGoalRequest"];
  private readonly onMcpServerRequest?: SessionOptions["onMcpServerRequest"];
  private readonly onMcpOpenAuthUrl?: SessionOptions["onMcpOpenAuthUrl"];
 /** Detaches this session's MCP reverse-request handler from the (possibly
  * shared) manager. Set once MCP starts; called on dispose so a shared manager
  * never routes a server reverse request to this disposed session. */
  private mcpUnregisterRequestHandler: (() => void) | null = null;
  private mcpUnregisterToolsChanged: (() => void) | null = null;
 /** Unregister fn for the opt-in inbound-notification handler (detached on
  * dispose, same rationale as the reverse-request cleanup). */
  private mcpUnregisterNotification: (() => void) | null = null;
 /** This session's own MCP reverse-request handler, used to tag direct
  * `mgr.invoke` calls (the `mcp` meta-tool path) for per-call reverse-request
  * affinity on a shared manager. */
  private mcpRequestHandler: McpServerRequestHandler | null = null;
  private readonly diagnosticsProvider?: SessionOptions["diagnosticsProvider"];
  /** Deployment-configured extra redaction patterns, compiled once from
   * `config.redact.patterns`. Applied on top of the built-in secret floor. */
  private readonly redactPatterns: readonly import("./redact.js").RedactionPattern[];
 /** Provider override (from Agent SDK / replay mode). When set, skips buildProvider. */
  private readonly providerOverride?: import("./providers/types.js").ChatProvider;
 /** Files the agent has written/edited this session, for snapshot rewind. */
  private touchedFiles: Set<string> = new Set();
  /** Snapshot id taken at the start of the current prompt (undo baseline). */
  private turnBaselineId: string | null = null;
  /** Files touched during the current prompt only. */
  private turnTouchedFiles: Set<string> = new Set();
  /** Undo stack: baseline (pre-turn) + after (post-turn) snapshot ids. */
  private undoStack: Array<{ baselineId: string; afterId: string; label: string }> = [];
  private redoStack: Array<{ baselineId: string; afterId: string; label: string }> = [];
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
  /** Read-before-write + staleness guard store (session-scoped). */
  private readonly fileObservations = new FileObservationStore();
 /** Mid-run steering messages queued via steer; drained each agent turn.
  * `user` items are genuine human input and enter the transcript as user
  * messages. `system` items are engine-generated notices (e.g. background
  * job completion) and are injected into the per-turn runtime_context so
  * they can never be mistaken for — or spoof — a user message.
  *
  * `delivery` controls when a `user` item is consumed:
  *  - `"steer"`: the model should see it as soon as possible — at the next
  *    injection boundary within the current logical turn (mid-stream before
  *    any tool call, or right after a tool batch).
  *  - `"followup"`: it waits for the next top-level user turn.
  * `system` notices are always `"steer"`. */
  private steeringQueue: SteeringItem[] = [];
 /** Aborts only the in-flight provider SSE so a mid-stream steer can be
  * injected without cancelling the whole run. Distinct from
  * `cancelController` (user Stop), so a steer never marks the run cancelled. */
  private steerController: AbortController | null = null;
 /** Prompts waiting to run after the current busy `prompt()` finishes. */
  private followUpQueue: FollowUpItem[] = [];
 /** Prevents overlapping drainFollowUps kicks. */
  private drainingFollowUps = false;
  private toolRegistry: ToolRegistry;
  private artifacts: ArtifactStore;
  private permissions: PermissionEngine;
 /** Lazily-built small-model classifier for `auto` permission mode. */
  private permissionClassifier?: PermissionClassifier;
 /** In-flight permission prompts awaiting a host decision, keyed by requestId.
  * When one is resolved with always/always-project the new rule re-preflights
  * the others; any now-allowed waiter auto-resolves (pending-batch unlock). */
  private pendingPermissionWaiters = new Map<
    string,
    { tool: ToolDef; input: unknown; resolve: (r: PermissionResolution) => void }
  >();
  private sandbox: ResolvedSandbox;
 /** Monotonic prompt/turn counter, stamped into each execution claim so a
  * resumer can order runs. Starts at the count of user messages already in the
  * loaded transcript so a resumed session does not restart at 1. */
  private turnCounter = 0;
 /** True when sandbox mode is active but no OS backend is available and
 * fallback is "deny". Bash commands will be refused; surfaced as a
 * system-prompt note and via getSandboxStatus. */
  private _sandboxUnavailable = false;
  private hooks: HookEngine;
  private mcp: McpManager | null = null;
 /** Background MCP bring-up; session resume must not await this (npx is slow). */
  private mcpReady: Promise<McpManager | null> = Promise.resolve(null);
  private systemPromptCache: { staticPrefix: string; dynamicSuffix: string; full: string; stableContext?: string; volatileSuffix?: string } | null = null;
  private disposed = false;
 /** Current Collaboration mode (default "agent"). */
  private mode: AgentMode = "agent";
  /** When true, suggest_mode switches are applied without re-asking the user
   * (set via config, or the "Always switch" choice in the confirmation). */
  private autoAcceptModeSuggestions = false;
 /** Output style (default "concise"). Controls verbosity/teaching posture. */
  private outputStyle: OutputStyle = "concise";
 /** Auto-title, generated after the first prompt. */
  private title: string | null = null;
 /** Cached checkpoint hook — initialised in `init`. */
  private checkpointHook: CheckpointHook | null = null;
  /** In-flight background checkpoint write, if any. The snapshot is built
   * synchronously on the hot path; the slow small-model distillation + disk
   * write run here so a completed turn is not held up by a checkpoint. At most
   * one runs at a time (a new trigger while one is in flight is skipped —
   * the next turn re-triggers). `dispose()` awaits this so a clean shutdown
   * never drops a checkpoint. */
  private pendingCheckpoint: Promise<void> | null = null;
 /** Aggregated usage across all prompts of this session. */
  private usageTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
 /** Latest provider rate-limit snapshot, when a recent response carried
  * rate-limit headers. Surfaced into the status-line payload. */
  private rateLimitSnapshot:
    | { requestsRemaining?: number; tokensRemaining?: number; resetsInSeconds?: number }
    | undefined;
 /** Per-turn cache-relevant usage, for cache-waste attribution (`getCacheWaste`). */
  private cacheTurns: CacheTurn[] = [];
 /** True when the context changed (compaction/branch) just before the next
  * recorded usage turn, so its re-bill is counted as expected, not waste. */
  private contextChangedForNextTurn = false;
  /** Query-relevant memory notes selected for the current turn (progressive
   * recall). Set at the start of `prompt()` and consumed when building the
   * agent-loop deps; rides the volatile per-turn context only, never persisted. */
  private pendingRelevantMemories: string | null = null;
  /** Latest single-request provider `input` tokens (not cumulative). */
  private lastProviderInputTokens = 0;
  /** Measured context anchor for the hybrid context estimate: the provider's
   * last reported prompt size paired with the event-log length at that moment.
   * `contextReport` reads `anchor.input` as ground truth and adds a heuristic
   * estimate for only the events appended after the anchor, so a large
   * tool_result landing after the last usage event is reflected immediately
   * instead of waiting for the next response. Cleared on a model switch and at
   * a compaction boundary (both re-bill the whole prompt, so the old
   * measurement no longer anchors anything). */
  private contextAnchor: { input: number; eventCount: number } | null = null;
 /** Set when the session was loaded with a stale in-flight status (the prior
 * run was interrupted by a crash/restart). Drives a one-shot recovery
 * instruction in the system prompt so the next turn resumes from the
 * checkpoint instead of redoing work or drifting out of scope. Cleared
 * after the first prompt completes. */
  private resumedFromInterrupt = false;
 /** Set during init() when loadFromDisk found a crash-interrupted run and the
  * reconcile sealed it to idle. Lets a host that attaches after init — and the
  * boot-time recovery sweep — retrieve the recovery outcome. */
  private interruptedRecovery?: InterruptedRunInfo;
 /** Count of torn-tail repairs this session performed on load (a crash left an
  * incomplete final JSONL line that was truncated back to the last complete
  * record). Surfaced for observability; normally 0. */
  private tornTailRepairs = 0;
 /** True for a read-only open: the single-writer lease is not acquired and no
  * event is ever appended to the JSONL (prompt / persisted mode-model changes /
  * reconcile seal are all inert). */
  private readonly readOnly: boolean;
 /** Held single-writer lease (null for a read-only open). Acquired at the top
  * of init() before any load/append, released in dispose(). A crashed owner's
  * lock is reclaimed by the next acquirer via a pid-liveness check. */
  private writerLease: SessionLease | null = null;
 /** Lock-file identity (daemon url/token) recorded in the lease so a second
  * opener can be redirected to attach to this owner as a subscriber. */
  private readonly lockIdentity?: SessionOptions["lockIdentity"];
 /** Turn-boundary pre-compaction cache. After a turn ends with tokens over a
 * soft threshold (but below the hard trigger), we compact in the background
 * while the user reads / thinks, and stash the result here keyed by a
 * fingerprint of the exact history it summarised. The next turn's
 * `maybeCompact` reuses it IFF the history is unchanged — turning an
 * otherwise blocking small-model summary into a free, already-done step.
 * A stale fingerprint (history moved on) discards it and falls back to the
 * normal synchronous path, so it can never apply an outdated summary. */
  private precompact: { fingerprint: string; result: CompactionResult } | null = null;
 /** Guards against two overlapping background pre-compactions. */
  private precompactInFlight = false;
 /** Auto-compaction circuit breaker. `compactFailStreak` counts consecutive
  * failed compactions (threw or made no change); `compactNoopStreak` counts
  * compactions that succeeded but left the live transcript still at/over the
  * hard trigger ("compacted but still full" — real thrashing). When either
  * reaches `autoCompactMaxConsecutiveFailures`, auto-compaction (and its
  * precompute) is disabled for the rest of the session; a successful MANUAL
  * `/compact` that gets back under budget clears the breaker. */
  private compactFailStreak = 0;
  private compactNoopStreak = 0;
  private autoCompactDisabled = false;
 /** Guards against two overlapping background memory-pipeline runs. */
  private memoryPipelineInFlight = false;
 /** Set when a background consolidation rewrote the progressive-memory index.
  * The next turn forces a system-prompt rebuild so the model sees the updated
  * memory instead of the stale index captured in `systemPromptCache`. */
  private memoryIndexDirty = false;
 /** Cached project "compact instructions" (a `## Compact Instructions` section
  * in CODEPILOT.md / AGENTS.md / CLAUDE.md). Loaded lazily before compaction and
  * invalidated whenever memory changes (same trigger as `memoryIndexDirty`).
  * `undefined` means "not loaded yet"; a loaded-but-absent value is `null`. */
  private compactInstructionsCache: string | null | undefined = undefined;
 /** Pending prompt-cache warm timer + its abort controller. Scheduled at a
  * turn end when a warm is cost-effective; cancelled when the next real turn
  * starts (it supersedes the warm) or on dispose. */
  private cacheWarmTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheWarmAbort: AbortController | null = null;
 /** Measured probability the user continues within the cache TTL. Conservative
  * default; warming only fires when expected savings still clear the gate. */
  private cacheWarmContinuationProb = 0.3;
 /** Aggregate request timing across this session (persisted via `request`
 * events; this is the in-memory rollup for getStats/summaries). */
  private requestStats = { count: 0, totalMs: 0, lastMs: 0, lastTtftMs: 0, slowestMs: 0 };
 /** Custom sub-agents discovered from .codepilot/agents/ + ~/.codepilot/agents/. */
  private customAgents: Map<string, CustomAgent> = new Map();
  /** Skills discovered for this session (advertised in the prompt + loadable
   * via the `skill` tool). Populated in init(); re-discovered is cheap. */
  private discoveredSkills: Skill[] = [];
  /** Handle on the registered `skill` tool so init() can inject the store. */
  private skillToolHandle: SkillToolHandle | null = null;
  /** Language-server manager backing the `lsp_navigate` tool. Lazily spawns
   * servers per language; stopped on dispose. */
  private lspManager: LspManager | null = null;
 /** Loopback egress proxy backing a "proxy" network policy. Started in
  * init() when configured; stopped on dispose. */
  private netProxy: import("./netProxy.js").RunningNetProxy | null = null;
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
 /** Per-session registry of background sub-agents dispatched with
  * `run: "background"`. Owned here (not a module singleton) so parallel
  * sessions never see each other's jobs; interrupted on dispose. */
  private backgroundSubagents = new BackgroundSubagentRegistry();
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
 /** Plugin-installed context transform (via the runtime toolkit). Applied to
  * a copy of the provider view before each request, validated + fail-soft.
  * Undefined when no plugin set one. */
  private pluginContextTransform: ((view: import("./providers/types.js").ProviderMessage[]) => import("./providers/types.js").ProviderMessage[]) | undefined;
 /** Additive event sink mirroring the JSONL log to an external data source,
  * wrapped in a bounded fail-soft queue. Registered by a plugin runtime (via
  * the toolkit) or passed directly by a host. Undefined → no mirror. JSONL
  * stays the source of truth; the sink never gates the canonical write. */
  private eventSink: import("./sessionSink.js").BoundedSinkQueue | undefined;
 /** Extra skill/agent directories contributed by installed plugins. Merged
  * into discovery during `init()` so a plugin's skills/agents actually reach
  * the running session. Empty when no plugins contribute them. */
  private readonly pluginSkillDirs: string[];
  private readonly pluginAgentDirs: string[];
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
    this.onGoalRequest = opts.onGoalRequest;
    this.onMcpServerRequest = opts.onMcpServerRequest;
    this.onMcpOpenAuthUrl = opts.onMcpOpenAuthUrl;
    this.diagnosticsProvider = opts.diagnosticsProvider;
    this.redactPatterns = compileRedactionPatterns(opts.config.redact?.patterns);
    this.providerOverride = opts.provider;
    this.runtimeName = opts.runtime ?? opts.config?.runtime;
    this.pluginSkillDirs = opts.pluginSkillDirs ?? [];
    this.pluginAgentDirs = opts.pluginAgentDirs ?? [];
    this.readOnly = opts.readOnly === true;
    this.lockIdentity = opts.lockIdentity;
    this.mode = opts.agentMode ?? opts.config.agentMode ?? "agent";
    this.autoAcceptModeSuggestions = opts.config.autoAcceptModeSuggestions === true;
    this.hostSurface = opts.hostSurface ?? "cli";
    this.toolRegistry = new ToolRegistry();
    this.artifacts = new ArtifactStore(projectStatePath(opts.cwd, "artifacts"));
    this.permissions = new PermissionEngine({
      permissionMode: this.config.permissionMode,
      autoApprove: this.config.autoApprove,
      permissions: this.config.permissions,
      permissionAuto: this.config.permissionAuto,
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
  // Auto-allow sandbox-confined actions (writable-root writes, ordinary bash)
  // since the OS jail already contains them; wire policy so out-of-root writes
  // can prompt to expand writablePaths. Bash auto-allow needs OS enforcement
  // (osEnforced flag in PermissionEngine).
    this.permissions.setSandbox(this.sandbox, this.cwd);
    // Seed the engine's view of the in-boundary working set: delivery roots and
    // any configured extra working directories (the boundary policy itself is
    // read from config in the engine constructor).
    this.permissions.setDeliveryRoots(this.deliveryRoots);
    for (const d of this.config.permissions?.additionalWorkingDirectories ?? []) {
      this.permissions.addWorkingDirectory(d);
    }
    // Pending-batch unlock: when an always grant (or CRUD hot-load) adds a
    // session rule, re-preflight the other in-flight permission prompts.
    this.permissions.setOnRuleAdded(() => this.unlockPendingPermissions());
    // High-risk model gate: a risky active model ignores persisted allow rules.
    this.applyHighRiskModelGate();
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
 // Cross-process single-writer lease. Acquire BEFORE loading — loadFromDisk is
 // read-only but reconcileStaleStatus below appends a seal/idle, and every
 // later prompt appends, so the lease must already be held. A read-only open
 // skips the lease entirely and never writes. Throws SessionLockedError if a
 // live owner (another daemon / CLI) already holds it; the error carries the
 // owner's identity so a caller can redirect the client to attach there.
    if (!this.readOnly) {
      this.writerLease = acquireSessionLock(this.id, {
        ...(this.lockIdentity?.host ? { host: this.lockIdentity.host } : {}),
        ...(this.lockIdentity?.url ? { url: this.lockIdentity.url } : {}),
        ...(this.lockIdentity?.token ? { token: this.lockIdentity.token } : {}),
      });
    }
    try {
      await this.initAfterLease();
    } catch (err) {
      // A later init step failed after the lease was taken — release it so the
      // id is not left wedged by a half-constructed session that is never
      // disposed.
      try {
        this.writerLease?.release();
      } catch {
        /* reclaim handles a leftover lock */
      }
      this.writerLease = null;
      throw err;
    }
  }

  private async initAfterLease(): Promise<void> {
    await ensureProjectState(this.cwd, { sessionId: this.id });
    await this.artifacts.init();
    await this.startNetProxyIfConfigured();
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
 // MCP (esp. `npx -y …`) can take many seconds — do not block resume/UI.
 // Tools register when ready; prompt() awaits mcpReady before the agent turn.
    this.mcpReady = this.startMcp()
      .then(async (mcp) => {
        if (this.disposed) {
          this.mcpUnregisterRequestHandler?.();
          this.mcpUnregisterRequestHandler = null;
          this.mcpRequestHandler = null;
          this.mcpUnregisterToolsChanged?.();
          this.mcpUnregisterToolsChanged = null;
          this.mcpUnregisterNotification?.();
          this.mcpUnregisterNotification = null;
          const { releaseSharedMcp } = await import("./mcp-pool.js");
          await releaseSharedMcp(mcp);
          return null;
        }
        this.mcp = mcp;
        await this.rebuildSystemPrompt().catch(() => undefined);
        return mcp;
      })
      .catch((err) => {
        process.stderr.write(
          `[session] MCP background start failed: ${(err as Error).message}\n`,
        );
        return null;
      });
 // Load trusted hook hashes (for command-hook trust enforcement).
    await this.hooks.loadTrustedHashes();
 // Discover custom sub-agents from .codepilot/agents/ + ~/.codepilot/agents/
 // plus any installed plugins' agents/ dirs. Fail-soft: a bad dir yields [].
    this.customAgents = await discoverCustomAgents(this.cwd, {
      extraDirs: this.pluginAgentDirs,
    }).catch(() => new Map<string, CustomAgent>());
    // Discover skills: advertise in the prompt and back the `skill` tool store
    // so installed skills load on demand. Plugin skill dirs merge in as
    // extraDirs. `config.skills`: `enabled:false` disables discovery; `dirs`
    // adds roots; `disabled` omits named skills (unioned with user config).
    const skillsCfg = this.config.skills;
    if (skillsCfg?.enabled === false) {
      this.discoveredSkills = [];
    } else {
      const configuredDirs = (skillsCfg?.dirs ?? []).filter(
        (d): d is string => typeof d === "string" && d.trim().length > 0,
      );
      this.discoveredSkills = await discoverSkills(this.cwd, {
        extraDirs: [...this.pluginSkillDirs, ...configuredDirs],
        ...(skillsCfg?.disabled ? { disabledNames: skillsCfg.disabled } : {}),
      }).catch(() => []);
    }
    this.skillToolHandle?.setStore(new StaticSkillStore(this.discoveredSkills));
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
      const logger = new AuditLogger(this.id, { ...(dir ? { dir } : {}), redactPatterns: this.redactPatterns });
      this.listeners.add(logger.onEvent);
    }
  }

  /**
   * Start a user turn, or enqueue it if a turn is already running.
   * Returns `"queued"` when the text was added to the follow-up queue
   * instead of starting immediately.
   */
  /**
   * Resume the last turn from the existing transcript instead of sending a
   * new message. Use after a turn ended in a recoverable error (provider
   * failure, tool failure, Stop-verify cap) so "retry" picks up where it
   * stopped — WITHOUT adding another user bubble. Re-enters the agent loop
   * driven purely by `this.events`; dangling `tool_use` calls are repaired by
   * the provider-message builder. Returns "noop" when there is nothing to
   * resume (no prior user turn, or the last turn did not end in an error).
   */
  async resumeLastTurn(): Promise<"started" | "queued" | "noop"> {
    if (this.disposed) throw new Error("session disposed");
    if (this.isBusy()) return "queued";
    if (!this.canResumeLastTurn()) return "noop";
    const lastUserText = this.lastUserPromptText() ?? "";
    return this.prompt(lastUserText, undefined, undefined, { resume: true });
  }

  /**
   * True when the last turn ended in a recoverable error and there is a user
   * prompt to resume from. Clients use this to show a "retry from here" affordance
   * distinct from "send a new message".
   */
  canResumeLastTurn(): boolean {
    let sawUser = false;
    for (const e of this.events) if (e.type === "message" && e.role === "user") sawUser = true;
    if (!sawUser) return false;
    // Walk back past transient/bookkeeping events to the last meaningful one.
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.type === "status" || e.type === "usage" || e.type === "activity") continue;
      return e.type === "error";
    }
    return false;
  }

  /** Text of the most recent persisted user message, or null. */
  private lastUserPromptText(): string | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.type === "message" && e.role === "user") {
        const text = e.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        return text || null;
      }
    }
    return null;
  }

  async prompt(
    text: string,
    images?: ImageAttachment[],
    files?: PromptFile[],
    opts?: { resume?: boolean },
  ): Promise<"started" | "queued"> {
    if (this.disposed) throw new Error("session disposed");
    if (this.isBusy()) {
      this.enqueueFollowUp({ text, images, files });
      return "queued";
    }
    const resume = opts?.resume === true;
    // A real turn supersedes any pending prompt-cache warm.
    this.cancelCacheWarm();
    // Reset per-turn recall; recomputed below for a fresh prompt, absent on resume.
    this.pendingRelevantMemories = null;
    this.cancelController = new AbortController();
    this.steerController = new AbortController();

    // Undo baseline: capture pre-turn state of files we already know about.
    this.turnTouchedFiles = new Set();
    try {
      this.turnBaselineId = await this.snapshot(`pre-turn-${Date.now()}`);
    } catch {
      this.turnBaselineId = null;
    }

 // Telemetry: wrap each prompt in a span (no-op when OTEL is not configured).
    const promptSpan: PromptSpan = startPromptSpan(this.id, text.length);

 // Run UserPromptSubmit hooks. A blocking hook stops the prompt; a
 // rewriting hook replaces the text (first hook wins).
    const promptHook = resume
      ? ({ action: "allow" as const, warnings: [] as string[] })
      : await this.hooks.runUserPromptSubmit(text).catch((): {
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
    // On resume there is no fresh user input: skip @mcp resolution,
    // delivery-root extraction, image mentions and uploads — they all act on
    // a NEW prompt. `effectivePrompt` stays the recovered last prompt (used
    // only as the compaction fallback), `attachedImages`/`savedUploads` empty.
    let effectivePrompt = resume ? text : (promptHook.rewrittenPrompt ?? text);
    let attachedImages: ImageAttachment[] = [];
    let savedUploads: Awaited<ReturnType<typeof materializeUploads>> = [];

    if (!resume) {
 // Wait for background MCP (if still starting) so tools / @mcp refs work.
    await this.mcpReady.catch(() => null);
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
      // Delivery roots are not the OS jail. When the user EXPLICITLY names a
      // target directory, the sandbox must grant it up-front — otherwise the
      // write is silently blocked by the jail, or the model is forced to ask.
      // The sandbox itself requests the directory's permission here (host
      // prompt in ask-mode; auto-granted in auto-edit/yolo), so a user-named
      // path "just works" without the LLM negotiating for it.
      await this.grantSandboxForMentionedRoots(mentionedRoots).catch(() => undefined);
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
    attachedImages = [...(images ?? []), ...mentioned.images];

 // Uploads are written to disk and listed on the message event. The
 // attachment note is injected only when building the provider prompt
 // (see agent-messages) so the user's bubble stays clean.
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

    // Query-time progressive recall: pick the memory topic files most relevant
    // to this query and stash their truncated bodies for the volatile per-turn
    // context. Fail-soft and non-blocking — recall never holds up the turn.
    this.pendingRelevantMemories = await this.recallRelevantMemories(effectivePrompt).catch(
      () => null,
    );
    } // end preprocessing (skipped on resume)

    try {
 // Durable-execution claim: atomically append a `running` status carrying the
 // execution identity BEFORE the agent loop starts. If the process dies mid-run
 // this claim is the tail of the JSONL; the crash-recovery sweep finds it, seals
 // any orphaned tool call, and flips the session to a clean idle. The agent
 // loop's own per-step `running` heartbeats are claim-less; only this opening
 // marker carries the claim, and the trailing `idle` releases it.
      this.turnCounter += 1;
      const claimStatus: Event = {
        type: "status",
        status: "running",
        claim: {
          executionId: `exec_${randomUUID()}`,
          turn: this.turnCounter,
          model: this.turnOverrideModel ?? this.model,
          fingerprint: this.historyFingerprint(),
          startedAt: Date.now(),
        },
      };
      this.events.push(claimStatus);
      await this.persistEvent(claimStatus).catch(() => undefined);
      this.notify(claimStatus);
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
      // Resolve the agent runtime now (memoized). A plugin runtime installs
      // its tools / context transform during resolution, so this must happen
      // before we build `deps` that reads `this.pluginContextTransform`.
      const runtime = this.getRuntime();
      // Lazily ensure the system prompt exists. Resume defers the init-time
      // build (to return history faster), so build on first use if needed.
      // Also rebuild when a background consolidation updated the memory index,
      // so the model never reads a stale MEMORY.md after it was consolidated.
      if (!this.systemPromptCache || this.memoryIndexDirty) {
        this.memoryIndexDirty = false;
        await this.rebuildSystemPrompt().catch(() => undefined);
      }
      const deps: AgentDeps = {
        provider:
          this.providerOverride ??
          buildProvider({ ...this.config, model: effectiveModel }),
        tools: this.toolRegistry,
        artifacts: this.artifacts,
        permissions: this.permissions,
        config: { ...this.config, model: effectiveModel },
        cwd: this.cwd,
        sessionId: this.id,
        systemPrompt: this.systemPromptCache ?? undefined,
        promptCacheKey: this.id,
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
        redactPatterns: this.redactPatterns,
        // Installed during runtime resolution above (a plugin runtime may set
        // it); undefined → agent.ts treats the transform as a no-op.
        contextTransform: this.pluginContextTransform,
        parentSpan: promptSpan,
        dedupCache: this.dedupCache,
        fileObservations: this.fileObservations,
        relevantMemories: this.pendingRelevantMemories ?? undefined,
        drainSteering: (opts) => {
          const scope = opts?.scope ?? "all";
          // Any drain that consumes user steers rotates the steer controller so
          // the next provider request starts with a fresh (un-aborted) signal.
          const rotate = (): void => {
            if (this.steerController?.signal.aborted) {
              this.steerController = new AbortController();
            }
          };
          if (scope === "all") {
            const q = this.steeringQueue;
            this.steeringQueue = [];
            rotate();
            return q;
          }
          // scope === "steer": take steer-delivery items + all system notices;
          // leave followup items queued for the next top-level turn.
          const take: SteeringItem[] = [];
          const keep: SteeringItem[] = [];
          for (const item of this.steeringQueue) {
            if (item.source === "system" || item.delivery === "steer") take.push(item);
            else keep.push(item);
          }
          this.steeringQueue = keep;
          rotate();
          return take;
        },
        peekSteering: () =>
          this.steeringQueue.some(
            (i) => i.source === "user" && i.delivery === "steer",
          ),
        getSteerSignal: () => this.steerController?.signal,
        onEvent: async (e) => {
          if (e.type === "retry" || e.type === "activity" || e.type === "edit_delta") {
 // Transient UI notice — never part of the transcript. `edit_delta`
 // is live edit progress; the tool_result holds the final outcome.
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
            // Persist usage so sub-agent token totals survive resume and can
            // be shown separately from the parent until rollup.
            const replayable = inner === undefined || inner === "message" || inner === "tool_call" ||
              inner === "tool_result" || inner === "plan" || inner === "error" || inner === "usage";
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
            !e.rollup &&
            typeof e.usage?.input === "number" &&
            e.usage.input > 0
          ) {
            this.lastProviderInputTokens = e.usage.input;
            // Anchor the hybrid context estimate to this measurement: the
            // provider tokenised everything in the log up to now, so the event
            // count here is the boundary past which later events are estimated.
            this.contextAnchor = { input: e.usage.input, eventCount: this.events.length };
          }
 // plan_done approval: leave plan mode. Land in `agent` so the
 // approved plan can be executed — UNLESS the user entered plan mode
 // from `chat` (they wanted answers + a plan, not autonomous edits),
 // in which case restore `chat` and let them opt into agent mode.
          if (e.type === "mode_request") {
            // A suggest_mode acceptance may carry "remember" → auto-accept
            // future suggestions this session (the "Always switch" choice), and
            // persist the preference to the user config so it survives a restart.
            if (e.rememberAuto) {
              this.autoAcceptModeSuggestions = true;
              void persistAutoAcceptModeSuggestions().catch(() => undefined);
            }
            const target = e.mode === "agent" && this.prePlanMode === "chat"
              ? "chat"
              : e.mode;
            await this.setAgentMode(target);
          }
 // Track files touched by write/edit/apply_patch/notebook_edit for snapshot
 // rewind.
          if (e.type === "tool_call") {
            const t = e as { type: "tool_call"; name: string; input: unknown };
            if (
              t.name === "write_file" ||
              t.name === "edit_file" ||
              t.name === "apply_patch" ||
              t.name === "notebook_edit"
            ) {
              const inp = t.input as Record<string, unknown> | undefined;
              // notebook_edit names its target `notebook_path`; the others `path`.
              const path = t.name === "notebook_edit" ? inp?.notebook_path : inp?.path;
              if (typeof path === "string") {
                this.touchedFiles.add(path);
                this.turnTouchedFiles.add(path);
              }
 // apply_patch may touch multiple files — parse is expensive, so
 // we rely on the patch's own `*** Update/Add/Delete File:` lines.
              if (t.name === "apply_patch" && typeof inp?.patch === "string") {
                for (const m of (inp.patch as string).matchAll(/\*\*\* (?:Add|Delete|Update) File: (.+)/g)) {
                  const p = m[1]!.trim();
                  this.touchedFiles.add(p);
                  this.turnTouchedFiles.add(p);
                }
              }
            }
          }
        },
        // Wrapped so an always/always-project grant unlocks other in-flight
        // permission prompts the new rule now covers (pending-batch unlock).
        onPermissionRequest: this.onPermissionRequest
          ? (req) => this.onPermissionRequestWithBatch(req)
          : undefined,
        // Background classifier for `auto` permission mode. Built lazily and
        // reused; only consulted by agent-tools when the mode is `auto`.
        permissionClassifier: this.getPermissionClassifier(),
        onAskUser: this.onAskUser,
        onUsage: (u) => {
          this.usageTotal.input += u.input ?? 0;
          this.usageTotal.output += u.output ?? 0;
          this.usageTotal.cacheRead += u.cacheRead ?? 0;
          this.usageTotal.cacheWrite += u.cacheWrite ?? 0;
          // Record the turn for cache-waste attribution. A re-bill right after
          // a compaction/branch is expected (new content), so carry that flag.
          if ((u.input ?? 0) > 0) {
            this.cacheTurns.push({
              at: Date.now(),
              model: this.model,
              input: u.input ?? 0,
              cacheRead: u.cacheRead ?? 0,
              cacheWrite: u.cacheWrite ?? 0,
              contextChanged: this.contextChangedForNextTurn,
            });
            this.contextChangedForNextTurn = false;
          }
        },
        onRateLimit: (info) => {
          this.rateLimitSnapshot = info;
        },
        // Mid-run compaction: agent already detected pressure (local estimate
        // OR last provider inputTokens). Force — do not re-gate on the local
        // estimator, which under-counts vs gateway usage and can let requests
        // climb past the configured contextWindow.
        compactNow: async () => {
          const before = this.events;
          await this.maybeCompact({ force: true });
          if (this.events === before) return null;
          return this.events.slice();
        },
        onWarmableRequest: (candidate) => this.scheduleCacheWarm(candidate),
        lastProviderInputTokens: this.lastProviderInputTokens,
      };

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

      // Emit the user message before the first model round-trip so its bubble
      // shows instantly. On a fresh prompt (not resume) we append/persist/notify
      // here and tell the agent loop (userAlreadyEmitted) not to duplicate it.
      const userEmittedEarly = !resume;
      if (userEmittedEarly) {
        const userEvent: Event = {
          type: "message",
          id: `msg_${randomUUID()}`,
          role: "user",
          content: [{ type: "text", text: turnText }],
          ts: Date.now(),
          ...(turnImages.length > 0 ? { images: turnImages } : {}),
          ...(turnFiles.length > 0 ? { files: turnFiles } : {}),
        };
        this.events.push(userEvent);
        await this.persistEvent(userEvent).catch(() => undefined);
        this.notify(userEvent);
      }

      let firstPass = true;
      for (;;) {
        // Continues after Stop/stopVerify inject feedback for the model only
        // (`systemContinue`) — never as a persisted user bubble.
        const isStopContinue = stopContinueCount > 0;
        // Resume applies only to the FIRST re-entry: it re-engages the model
        // on the existing transcript with no new user event. Later passes are
        // Stop-hook continues, which use `systemContinue` instead.
        const isResume = resume && firstPass && !isStopContinue;
        // The user event was already appended+surfaced above; only the first
        // pass of a fresh prompt must suppress the loop's own emit.
        const alreadyEmitted = userEmittedEarly && firstPass && !isStopContinue;
        firstPass = false;
        await runtime.prompt(
          {
            history: this.events,
            userText: isStopContinue ? "" : turnText,
            ...(isResume ? { resume: true } : {}),
            ...(alreadyEmitted ? { userAlreadyEmitted: true } : {}),
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

        // stopVerify is strictly opt-in: it runs only when the user set a mode
        // ("prompt"/"tests"/true). No automatic "modified code → run tests"
        // upgrade. See `effectiveStopVerifyMode`.
        const stopMode = effectiveStopVerifyMode({
          configured: this.config.stopVerify,
        });
        // By default the built-in verdict is advisory (non-blocking notice). Only
        // the object form `{ mode, forceContinue: true }` re-runs the turn on a
        // negative verdict, and then with a lower default cap so a false negative
        // still can't spin to the full Stop-hook cap.
        const stopForceContinue = resolveStopVerifyForceContinue(this.config.stopVerify);
        const builtinStopCap =
          typeof this.config.stopHookBlockCap === "number" && this.config.stopHookBlockCap >= 0
            ? this.config.stopHookBlockCap
            : DEFAULT_STOP_VERIFY_FORCE_CAP;
        const hasUserStop = this.hooks.hasHooks("Stop");
        if (stopMode === "off" && !hasUserStop) break;

        const stopPayload = {
          reason: stopContinueCount === 0 ? "prompt_completed" : "stop_hook_continue",
          stop_hook_active: stopHookActive,
          stop_continue_count: stopContinueCount,
          stop_continue_cap: stopForceContinue ? builtinStopCap : stopCap,
          session_id: this.id,
          transcript_hint: buildStopTranscriptHint(this.events),
        };

        // Built-in validity gate first, then user-configured Stop hooks.
        let stopResult: import("./hooks.js").PreHookResult =
          stopMode === "off"
            ? { action: "allow", warnings: [] }
            : await runBuiltinStopVerify(
                stopMode,
                {
                  cwd: this.cwd,
                  ...stopPayload,
                  resolvers: this.hooks.getResolvers(),
                },
                { forceContinue: stopForceContinue },
              ).catch((): import("./hooks.js").PreHookResult => ({
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
          // Advisory verdicts (forceContinue off) are notices, not failures:
          // the turn still ended; surface the concern for the user to act on.
          const isAdvice = w.startsWith(STOP_VERIFY_ADVICE_PREFIX);
          const message = isAdvice
            ? `${w} (advisory — the turn ended; set stopVerify.forceContinue to re-run instead)`
            : w;
          const ev: Event = { type: "error", message, recoverable: true };
          this.events.push(ev);
          await this.persistEvent(ev).catch(() => undefined);
          this.notify(ev);
        }

        if (stopResult.action !== "block") break;

        // Forced continues use the lower built-in cap; user Stop hooks use the
        // full configured cap.
        const effectiveCap = stopForceContinue ? builtinStopCap : stopCap;
        if (stopContinueCount >= effectiveCap) {
          const ev: Event = {
            type: "error",
            message:
              `Stop verify kept blocking after ${effectiveCap} continue(s); ending the turn ` +
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
          cap: effectiveCap,
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
      // Record undo boundary when this turn mutated files.
      if (
        this.turnBaselineId &&
        this.turnTouchedFiles.size > 0 &&
        !this.cancelController?.signal.aborted
      ) {
        try {
          const afterId = await this.snapshot(`post-turn-${Date.now()}`);
          const entry = {
            baselineId: this.turnBaselineId,
            afterId,
            label: `turn ${this.undoStack.length + 1}`,
          };
          this.undoStack.push(entry);
          this.redoStack = [];
          // Persist the boundary so `/undo` survives a reload. A control event:
          // not sent to the model, not shown in the transcript.
          await this.persistUndoBoundary("push", entry);
        } catch {
          /* ignore snapshot failures */
        }
      }
      this.turnBaselineId = null;
      this.turnTouchedFiles = new Set();
      const turnAborted = this.cancelController?.signal.aborted === true;
      this.cancelController = null;
 // Clear turn-scoped overrides so the session model + permission
 // grants resume on the user's next message.
      this.clearTurnOverrides();
 // End the telemetry span (no-op when disabled).
      endPromptSpan(promptSpan);
 // Kick the next queued follow-up (if any) once we are no longer busy.
      void this.drainFollowUps();
 // Turn-boundary pre-compaction: if tokens are in the soft band (approaching
 // the hard trigger but not there yet), compact in the background now — while
 // the history is frozen and the user is reading — so the next turn reuses it
 // for free instead of blocking on the small model. Fire-and-forget; the
 // fingerprint guard discards it if the next prompt changes the transcript.
      if (!turnAborted) void this.precomputeCompaction();
 // Fold this session's durable learnings into project memory in the
 // background (fire-and-forget, fail-soft): extract notes from the
 // transcript, then run a project-wide consolidation when its dual gate
 // (time since last run + accumulated drafts) is satisfied.
      if (!turnAborted) void this.runMemoryPipeline();
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
    // Apply per-model capabilities (contextWindow, maxOutputTokens) from the
    // provider's `modelCapabilities`, not just the model name — otherwise a
    // model-only switch keeps a stale window. `applyProviderAndModel` is a
    // no-op when no caps are configured.
    const applied = applyProviderAndModel(this.config, this.activeProviderId, resolved);
    this.model = applied.model;
    this.config = applied.config;
    if (applied.providerId) this.activeProviderId = applied.providerId;
    // A different model re-bills the whole prompt under its own tokeniser, so
    // the previous measurement no longer anchors the estimate.
    this.lastProviderInputTokens = 0;
    this.contextAnchor = null;
    this.applyHighRiskModelGate();
    await this.rebuildSystemPrompt();
    await this.emitModelEvent();
  }

  /**
   * Set reasoning / extended-thinking effort for subsequent turns.
   * Pass `undefined` (or call with no effort) to turn thinking off.
   * Clears any explicit `thinkingBudget` so effort mapping takes effect.
   */
  setReasoningEffort(effort: "low" | "medium" | "high" | undefined): void {
    if (this.disposed) throw new Error("session disposed");
    this.config = {
      ...this.config,
      reasoningEffort: effort,
      thinkingBudget: undefined,
    };
  }

  getReasoningEffort(): "low" | "medium" | "high" | undefined {
    return this.config.reasoningEffort;
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
    // The endpoint/model changed → the prior provider measurement no longer
    // anchors the estimate.
    this.lastProviderInputTokens = 0;
    this.contextAnchor = null;
    this.applyHighRiskModelGate();
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
 /** Names of the tools currently available to the model (after any
  * `filterToolRegistry`). Introspection for clients and tests. */
  getToolNames(): string[] {
    return this.toolRegistry.all().map((t) => t.name);
  }

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
   * Hybrid estimate of the tokens the NEXT send will cost. Prefers the
   * provider's last measured prompt size as an anchor and adds a heuristic
   * estimate for only the events appended after that measurement, so a large
   * tool_result produced this turn (before the next response) is reflected
   * immediately. With no anchor (before the first response, or just after a
   * model switch / compaction) `fallback` stands in. Shared by `contextReport`
   * (gauge) and `ensureContextUnderWindow` (compaction precheck) so both read
   * the same number.
   */
  private effectiveContextTokens(fallback: number): number {
    const anchor = this.contextAnchor;
    if (anchor && anchor.input > 0) {
      const trailing = this.events.slice(anchor.eventCount);
      const trailingTokens =
        trailing.length > 0 ? estimateEventTokens(trailing, estimateTokens) : 0;
      return anchor.input + trailingTokens;
    }
    const providerInputTokens = Math.max(0, this.lastProviderInputTokens);
    return providerInputTokens > 0 ? providerInputTokens : fallback;
  }

 /**
 * Produce a structured breakdown of the session's context usage for the
 * `/context` command. Returns total estimated tokens, a per-event-type
 * breakdown, the context window + trigger threshold, usage %, and a list
 * of files that have been read more than once (dedup hint).
 */
  contextReport(): {
    totalTokens: number;
    sentTokens: number;
    providerInputTokens: number;
    window: number;
    triggerThreshold: number;
    triggerFraction: number;
    usagePercent: number;
    autoCompactEnabled: boolean;
    byEventType: { type: string; tokens: number; count: number }[];
    byCategory: { category: string; tokens: number; isDeferred?: boolean }[];
    topFileReads: { path: string; reads: number; tokens: number }[];
    duplicateReads: { path: string; reads: number }[];
  } {
    const modelWindow = lookupContextWindow(this.model);
    const window = this.config.contextWindow ?? modelWindow.contextWindow;
    // Use the SAME geometry as the real compaction path (`maybeCompact`), which
    // reserves output tokens — so the displayed trigger line matches where
    // compaction actually fires, not a plain `window × fraction`.
    const geometry = compactionGeometry({
      window,
      thresholdFraction: this.config.compactionThreshold,
      maxTokens: this.config.maxTokens,
      maxOutputTokens: modelWindow.maxOutputTokens,
    });
    const trigger = geometry.hardTrigger;
    const fraction = this.config.compactionThreshold ?? DEFAULT_COMPACTION_FRACTION;
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

    // Semantic breakdown: what KIND of content fills the window, not just the
    // event type. The system prompt + tool/MCP schemas are sent every turn but
    // live outside the event log, so they must be estimated separately. The
    // event-log total above is the "conversation/subagent" side.
    const sp = this.systemPromptCache;
    // The <skills> catalogue sits inside the stable system-prompt section; when
    // present, count it under its own category and subtract it from `system`.
    const skillsSection = sp ? extractSkillsSection(sp.full) : "";
    const skillsTokens = skillsSection ? estimateTokens(skillsSection) : 0;
    const systemTokens = sp
      ? Math.max(0, estimateTokens(sp.full) - skillsTokens)
      : 0;
    // Surface the last user turn separately so the breakdown can show
    // "this message vs. everything before it".
    let lastMessageTokens = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.type === "message" && e.role === "user") {
        lastMessageTokens = estimateEventTokens([e], estimateTokens);
        break;
      }
    }
    // Tool definitions sent to the provider this mode. Split MCP out — its
    // schemas are often the biggest and most surprising contributor. When lazy
    // MCP discovery is active, the individual MCP schemas are NOT sent (only the
    // `mcp` meta-tool is); account for those deferred schemas in a separate
    // bucket that is visible but does not count toward the context total.
    let toolTokens = 0;
    let mcpTokens = 0;
    let mcpDeferredTokens = 0;
    let pluginDeferredTokens = 0;
    const mcpToolCount = this.toolRegistry.all().filter((t) => t.source === "mcp").length;
    const lazyMcp = decideLazyMcp(
      mcpToolCount,
      this.config.mcpToolDiscovery,
      this.config.mcpLazyThreshold,
    );
    const pluginToolCount = this.toolRegistry.all().filter((t) => t.source === "plugin").length;
    const lazyPlugin = decideLazyMcp(
      pluginToolCount,
      this.config.pluginToolDiscovery ?? "eager",
      this.config.pluginLazyThreshold,
    );
    // Start mode-filtered (keeps MCP/plugin tools visible so the deferred buckets
    // can be estimated), then apply the per-model toolExposure downgrade so a
    // tool the provider request drops is not counted toward the send total.
    let visibleTools = filterToolsByModeFromRegistry(this.toolRegistry, this.mode);
    if (this.config.toolExposure && this.config.toolExposure.length > 0) {
      visibleTools = filterToolsByModel(visibleTools, this.model, this.config.toolExposure);
    }
    for (const t of visibleTools) {
      const def = {
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
      };
      const tok = estimateTokens(JSON.stringify(def));
      if (t.source === "mcp") {
        // Under lazy discovery these schemas ride the `mcp` meta-tool on demand,
        // not the per-turn request, so they are deferred (shown, not counted).
        if (lazyMcp) mcpDeferredTokens += tok;
        else mcpTokens += tok;
      } else if (t.source === "plugin") {
        // Under lazy plugin discovery these ride the `tool_catalog` meta-tool on
        // demand, so they are deferred (shown, not counted toward the total).
        if (lazyPlugin) pluginDeferredTokens += tok;
        else toolTokens += tok;
      } else {
        toolTokens += tok;
      }
    }
    // Event-log tokens split into conversation vs sub-agent work.
    let subagentTokens = 0;
    let conversationTokens = 0;
    for (const e of this.events) {
      const tok = estimateEventTokens([e], estimateTokens);
      if (e.type === "subagent") subagentTokens += tok;
      else conversationTokens += tok;
    }
    // Split the current user message out of the conversation bucket so the two
    // don't double-count. `lastMessage` only counts when it is genuinely part
    // of the (non-subagent) conversation total.
    const conversationRest = Math.max(0, conversationTokens - lastMessageTokens);
    const byCategory: { category: string; tokens: number; isDeferred?: boolean }[] = [
      { category: "system", tokens: systemTokens },
      { category: "skills", tokens: skillsTokens },
      { category: "tools", tokens: toolTokens },
      { category: "mcp", tokens: mcpTokens },
      // Deferred MCP schemas: reachable via the `mcp` meta-tool on demand, not
      // sent each turn — shown for visibility but excluded from the total.
      { category: "mcp_deferred", tokens: mcpDeferredTokens, isDeferred: true },
      // Deferred plugin schemas: reachable via the `tool_catalog` meta-tool on
      // demand — shown for visibility but excluded from the total.
      { category: "plugin_deferred", tokens: pluginDeferredTokens, isDeferred: true },
      { category: "conversation", tokens: conversationRest },
      { category: "lastMessage", tokens: lastMessageTokens },
      { category: "subagent", tokens: subagentTokens },
    ]
      .filter((c) => c.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);

    const topFileReads = [...fileReads.entries()]
      .map(([path, v]) => ({ path, reads: v.reads, tokens: v.tokens }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10);
    const duplicateReads = topFileReads
      .filter((f) => f.reads > 1)
      .map((f) => ({ path: f.path, reads: f.reads }));
    // `sentTokens` is the accurate per-turn send estimate: event-log tokens
    // PLUS the fixed cost of the system prompt + skills + tool/MCP schemas,
    // which ride every request but live outside the event log. The gauge
    // percentage is driven by this grand total — the plain event-log `total`
    // understates real usage by that fixed cost.
    const sentTokens = total + systemTokens + skillsTokens + toolTokens + mcpTokens;
    // Hybrid estimate shared with the compaction precheck: measured anchor plus
    // an estimate for only the events appended after it (so a large tool_result
    // produced this turn is reflected immediately), falling back to the full
    // `sentTokens` estimate when there is no anchor.
    const providerInputTokens = Math.max(0, this.lastProviderInputTokens);
    const effectiveTotal = this.effectiveContextTokens(sentTokens);
    return {
      // Kept for back-compat: the event-log-only total some callers rely on.
      totalTokens: total,
      // The full per-turn send estimate (event log + system + tools + MCP).
      sentTokens,
      // Provider-reported prompt size from the last request (0 until the first
      // response), the most accurate numerator when available.
      providerInputTokens,
      window,
      triggerThreshold: trigger,
      triggerFraction: fraction,
      usagePercent: window > 0 ? Math.round((effectiveTotal / window) * 100) : 0,
      autoCompactEnabled: this.config.autoCompact !== false,
      byEventType,
      byCategory,
      topFileReads,
      duplicateReads,
    };
  }

  /**
   * Exact prompt token count via the provider's count-tokens API, for the
   * `/context --precise` opt-in. Gated behind `context.preciseCount: "on-demand"`
   * and the provider actually implementing `countTokens` (Anthropic). Builds the
   * same request the next turn would send (system + tools + folded history) and
   * returns the measured input tokens, or `null` when precise counting is off,
   * unsupported, or the call fails — callers fall back to the heuristic gauge.
   * Never runs automatically and never feeds the compaction threshold.
   */
  async preciseContextCount(): Promise<{ inputTokens: number } | null> {
    if (this.disposed) return null;
    if (this.config.context?.preciseCount !== "on-demand") return null;
    const provider = this.providerOverride ?? buildProvider(this.config);
    if (typeof provider.countTokens !== "function") return null;
    try {
      if (!this.systemPromptCache) {
        await this.rebuildSystemPrompt().catch(() => undefined);
      }
      const sp = this.systemPromptCache;
      const systemPrompt = sp?.full ?? undefined;
      const messages = buildProviderMessages(this.events, [], "");
      const lazyMcp = decideLazyMcp(
        this.toolRegistry.all().filter((t) => t.source === "mcp").length,
        this.config.mcpToolDiscovery,
        this.config.mcpLazyThreshold,
      );
      const tools = buildProviderToolDefs(this.toolRegistry, this.mode, {
        lazyMcp,
        model: this.model,
        toolExposure: this.config.toolExposure,
      });
      const res = await provider.countTokens({
        model: this.model,
        systemPrompt,
        messages,
        tools,
      });
      return { inputTokens: res.inputTokens };
    } catch {
      return null;
    }
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

  /** Undo the last agent turn's file edits. */
  /** Append (and persist) an `undo_boundary` control event so the undo/redo
   * stacks can be rebuilt after a reload. Not notified to subscribers and not a
   * model-visible event. */
  private async persistUndoBoundary(
    action: "push" | "undo" | "redo",
    entry: { baselineId: string; afterId: string; label: string },
  ): Promise<void> {
    const ev: Event = { type: "undo_boundary", action, ...entry };
    this.events.push(ev);
    await this.persistEvent(ev).catch(() => undefined);
  }

  async undo(): Promise<{ restored: string[]; deleted: string[]; label: string }> {
    const entry = this.undoStack.pop();
    if (!entry) throw new Error("Nothing to undo.");
    const result = await rewindToSnapshot(this.cwd, entry.baselineId);
    // Delete files created during the turn (present in after, absent/tombstone in baseline).
    try {
      const afterPath = pathResolve(
        projectStatePath(this.cwd, "snapshots"),
        entry.afterId,
        "manifest.json",
      );
      const beforePath = pathResolve(
        projectStatePath(this.cwd, "snapshots"),
        entry.baselineId,
        "manifest.json",
      );
      if (existsSync(afterPath) && existsSync(beforePath)) {
        const after = JSON.parse(await readFile(afterPath, "utf-8")) as {
          files: Record<string, string>;
        };
        const before = JSON.parse(await readFile(beforePath, "utf-8")) as {
          files: Record<string, string>;
        };
        const { rm } = await import("node:fs/promises");
        for (const rel of Object.keys(after.files)) {
          const prev = before.files[rel];
          if (!prev || prev === "__TOMBSTONE__") {
            const abs = pathResolve(this.cwd, rel);
            if (existsSync(abs)) {
              await rm(abs, { force: true });
              if (!result.deleted.includes(rel)) result.deleted.push(rel);
            }
          }
        }
      }
    } catch {
      /* best-effort */
    }
    this.redoStack.push(entry);
    await this.persistUndoBoundary("undo", entry);
    // The filesystem is reverted but the transcript still claims those writes
    // happened. Append a model-visible notice so the next turn sees the real
    // state. Append-only (no truncation) keeps the event-sourced log intact.
    const changed = [...new Set([...result.restored, ...result.deleted])].sort();
    const fileList = changed.length > 0 ? changed.join(", ") : "(no tracked files)";
    const notice: Event = {
      type: "message",
      id: `msg_${randomUUID()}`,
      role: "user",
      content: [
        {
          type: "text",
          text:
            `<undo_notice>\n` +
            `The previous turn's file edits were reverted by the user (/undo: ${entry.label}). ` +
            `The working tree is back to its pre-turn state. Affected paths: ${fileList}. ` +
            `Any earlier tool_result in this conversation that reported writing or editing ` +
            `these files is now STALE — the changes no longer exist on disk. Re-read any file ` +
            `before assuming its contents. Note: only tracked workspace files are restored — ` +
            `side effects of shell/MCP/network operations (commands run, git pushes, API calls, ` +
            `deletes outside the tracked set) are NOT undone.\n` +
            `</undo_notice>`,
        },
      ],
    };
    this.events.push(notice);
    await this.persistEvent(notice).catch(() => undefined);
    this.notify(notice);
    return { ...result, label: entry.label };
  }

  /** Re-apply the last undone turn's file edits (`/redo`). */
  async redo(): Promise<{ restored: string[]; deleted: string[]; label: string }> {
    const entry = this.redoStack.pop();
    if (!entry) throw new Error("Nothing to redo.");
    const result = await rewindToSnapshot(this.cwd, entry.afterId);
    this.undoStack.push(entry);
    await this.persistUndoBoundary("redo", entry);
    // Symmetric to undo: the edits are back on disk, so a prior undo_notice in
    // the transcript (which told the model the changes were gone) is now itself
    // stale. Append a reconciling notice so the next turn sees current state.
    const changed = [...new Set([...result.restored, ...result.deleted])].sort();
    const fileList = changed.length > 0 ? changed.join(", ") : "(no tracked files)";
    const notice: Event = {
      type: "message",
      id: `msg_${randomUUID()}`,
      role: "user",
      content: [
        {
          type: "text",
          text:
            `<redo_notice>\n` +
            `The previously undone turn's file edits were re-applied by the user (/redo: ${entry.label}). ` +
            `Those changes are back on disk. Affected paths: ${fileList}. If an earlier undo_notice ` +
            `said these files were reverted, that is no longer true. Re-read any file before ` +
            `assuming its contents. Note: only tracked workspace files are re-applied — ` +
            `side effects of shell/MCP/network operations are not replayed.\n` +
            `</redo_notice>`,
        },
      ],
    };
    this.events.push(notice);
    await this.persistEvent(notice).catch(() => undefined);
    this.notify(notice);
    return { ...result, label: entry.label };
  }

  undoDepth(): number {
    return this.undoStack.length;
  }

  redoDepth(): number {
    return this.redoStack.length;
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

  /**
   * Resolve once the session is idle (no `prompt()` in flight AND no queued
   * follow-ups left to drain). Returns immediately if already idle. Used by the
   * goal loop so it does not advance a round until the round it just enqueued —
   * because the session was busy — has actually executed. Without this, a goal
   * loop driven over a busy session spins at memory speed, enqueuing one
   * `renderRoundPrompt` per iteration (the queued round prompts pile up and the
   * loop never sees fresh output), rather than running one round at a time.
   */
  async waitUntilIdle(): Promise<void> {
    if (this.disposed) return;
    if (!this.isBusy() && this.followUpQueue.length === 0) return;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.disposed || (!this.isBusy() && this.followUpQueue.length === 0)) {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = this.subscribe((e) => {
        // Re-check on every status transition; `idle` is the one that matters,
        // but checking on any event keeps this robust to future status values.
        if (e.type === "status") check();
      });
      // A follow-up draining back-to-back can flip busy→idle→busy between our
      // check and the subscribe, so verify once more after wiring the listener.
      check();
    });
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
    this.runtime = runtimeRegistry.resolve(this.runtimeName, {
      cwd: this.cwd,
      registerTool: (def) => this.registerPluginTool(def),
      setContextTransform: (transform) => this.setPluginContextTransform(transform),
      registerEventSink: (sink) => this.registerPluginEventSink(sink),
    });
    return this.runtime;
  }

  /**
   * Install a plugin-provided context transform. The ABI type
   * `PluginContextTransform` is the structural twin of a transform over
   * `ProviderMessage[]`, so this stores it directly; `agent.ts` applies it on
   * a copy of the view, validates the result, and falls back to the
   * untransformed view on any problem (fail-soft). Setting it again replaces
   * the previous transform.
   */
  private setPluginContextTransform(
    transform: (view: import("./providers/types.js").ProviderMessage[]) => import("./providers/types.js").ProviderMessage[],
  ): void {
    this.pluginContextTransform = transform;
  }

  /**
   * Register a plugin-provided additive event sink. The sink is wrapped in a
   * {@link BoundedSinkQueue} so it mirrors JSONL lines on a background drain
   * and can never block or fail the canonical append (fail-soft enforced by
   * the host). Registering again closes the previous sink and installs the
   * new one. The ABI `PluginEventSink` is the structural twin of
   * `SessionEventSink`, so it is stored directly.
   */
  private registerPluginEventSink(
    sink: import("./sessionSink.js").SessionEventSink,
  ): void {
    const prev = this.eventSink;
    this.eventSink = new BoundedSinkQueue(sink, {
      onError: (err) =>
        process.stderr.write(`[session] event sink error: ${err.message}\n`),
    });
    if (prev) void prev.close();
  }

  /**
   * Adapt a plugin-contributed {@link PluginToolDef} into a real registry
   * entry the model can call. The JSON-schema input is converted to Zod with
   * the same helper MCP tools use (`jsonSchemaToZod`), so it type-checks and
   * flows through the normal validation + PreToolUse/PostToolUse + permission
   * pipeline. A plugin tool may NOT overwrite a built-in (or earlier plugin)
   * tool of the same name — the first registration wins and later ones are
   * rejected with a warning, so a plugin cannot silently hijack `bash`/`read_file`.
   */
  private registerPluginTool(def: PluginToolDef): void {
    const name = typeof def?.name === "string" ? def.name.trim() : "";
    if (!name) throw new Error("plugin tool is missing a name");
    if (this.toolRegistry.get(name)) {
      process.stderr.write(
        `[session] plugin tool "${name}" ignored — a tool with that name already exists\n`,
      );
      return;
    }
    const schema = def.parameters && typeof def.parameters === "object" ? def.parameters : { type: "object", properties: {} };
    this.toolRegistry.register({
      name,
      description: typeof def.description === "string" ? def.description : "",
      inputSchema: jsonSchemaToZod(schema as Record<string, unknown>),
      permission: def.permission ?? "execute",
      source: "plugin",
      execute: async (input, ctx) => {
        // Run the plugin's handler with an ABI-safe context subset. Any throw
        // becomes an error tool_result, never a crash (fail-soft).
        try {
          const r = await def.execute(input, { cwd: ctx.cwd, signal: ctx.signal });
          return {
            content: typeof r?.content === "string" ? r.content : String(r?.content ?? ""),
            isError: r?.isError === true,
          };
        } catch (err) {
          return { content: `plugin tool "${name}" failed: ${(err as Error).message}`, isError: true };
        }
      },
    });
  }

 /** The configured runtime name (for `/runtime`-style introspection). */
  getRuntimeName(): string {
    return this.runtimeName ?? "default";
  }

 /**
 * Queue a mid-run steering message. It is injected as a user message as soon
 * as the agent reaches an injection boundary — mid-stream before any tool call
 * starts, or right after the current tool batch — rather than waiting for the
 * next top-level turn. To make the mid-stream boundary reachable immediately,
 * this aborts only the in-flight provider stream (never the whole run), so any
 * text already generated is kept and the model re-samples with the correction
 * in view. Safe to call while a prompt is running or idle; messages queued
 * while idle are prepended to the next prompt's transcript.
 */
  steer(text: string): void {
    if (text.trim().length === 0) return;
    this.steeringQueue.push({ source: "user", text, delivery: "steer" });
    // Wake the stream so the correction lands this turn, not the next one.
    // Harmless when idle (a fresh controller is created on the next prompt).
    this.steerController?.abort();
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
    this.steeringQueue.push({ source: "system", text, delivery: "steer" });
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
    // Keep the permission engine's boundary check in sync — a delivery root is
    // part of the in-boundary working set.
    this.permissions.setDeliveryRoots(this.deliveryRoots);
    void this.rebuildSystemPrompt().catch(() => undefined);
  }

  /** Current delivery roots (copy). */
  getDeliveryRoots(): string[] {
    return [...this.deliveryRoots];
  }

  /**
   * When the user explicitly names target directories in a prompt, open the OS
   * sandbox for them proactively. For each named dir the sandbox would block:
   *  - `yolo` / `auto-edit` → grant silently (these modes already allow writes);
   *  - otherwise → ask the host once (the same sandbox-expand prompt a blocked
   *    write would raise), and grant on allow/always (persist on "always"). On
   *    deny we leave it blocked — an explicit user decision.
   * The point: the SANDBOX requests the directory's permission, instead of
   * silently blocking the write or forcing the model to negotiate for it.
   */
  private async grantSandboxForMentionedRoots(dirs: string[]): Promise<void> {
    if (this.sandbox.mode === "off" || this.sandbox.mode === "read-only") return;
    const mode = this.permissions.getMode();
    for (const raw of dirs) {
      const dir = resolve(this.cwd, raw);
      // Already writable in the jail → nothing to request.
      if (!isWriteOutsideSandbox(dir, this.sandbox, this.cwd)) continue;
      if (mode === "yolo" || mode === "auto-edit") {
        await this.expandWritablePath(dir, { persist: false });
        continue;
      }
      // ask-mode (and plan): let the sandbox request the directory's permission
      // through the host. No handler → leave blocked (a blocked write will
      // still raise the per-write prompt later), never silently widen the jail.
      if (!this.onPermissionRequest) continue;
      let resolution: PermissionResolution;
      try {
        resolution = await this.onPermissionRequest({
          requestId: `sandbox_grant_${Math.random().toString(36).slice(2, 10)}`,
          toolName: "sandbox",
          input: { path: dir },
          reason:
            `You asked to work in “${dir}”, which is outside the sandbox's writable roots. ` +
            `Allow once grants it for this session; Always also saves it to sandbox.writablePaths.`,
          sandboxExpand: { path: dir },
        });
      } catch {
        continue; // host error → leave blocked; per-write prompt still guards
      }
      // Normalize the resolution. A decline-with-feedback object means "don't
      // widen the jail, but the user left a correction" — there is no
      // tool_result to attach it to here (the sandbox grant is pre-emptive, not
      // a tool call), so surface the feedback to the model as a system notice so
      // its next step sees the instruction. A plain deny stays silent.
      const decision: PermissionDecision | "abort" =
        typeof resolution === "string" ? resolution : resolution.decision;
      if (decision === "allow" || decision === "always" || decision === "always-project") {
        await this.expandWritablePath(dir, {
          persist: decision === "always" || decision === "always-project",
        });
      } else if (
        typeof resolution !== "string" &&
        resolution.decision === "deny" &&
        resolution.feedback.trim().length > 0
      ) {
        this.steerSystem(
          `The user declined to extend the sandbox's writable roots to “${dir}” and ` +
            `instructed: ${resolution.feedback.trim()}`,
        );
      }
    }
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
    // The granted folder is now part of the in-boundary working set too (the
    // boundary policy reads it alongside writable roots).
    this.permissions.addWorkingDirectory(dir);
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

  /**
   * Hot-apply a new sandbox mode to the LIVE session (the host also persists it
   * to the user config so the next session inherits it). Re-resolves the policy,
   * re-wires the permission engine + command-hook sandbox, recomputes the
   * "no OS backend" availability flag, and restarts the persistent shell so the
   * next bash command runs under the new policy. Mirrors the wiring done once in
   * the constructor (and the restart done by {@link expandWritablePath}), so a
   * mid-session switch cannot leave a stale jail behind.
   *
   * This is deliberately the ONLY mutation entry point for the mode — writes go
   * through the same `resolveSandbox` + `setSandbox` path as startup, so there is
   * no second code path that could drift from the real enforcement.
   */
  setSandboxMode(mode: ResolvedSandbox["mode"]): SandboxStatus {
    // Preserve the operator's other sandbox settings (network/writablePaths/
    // fallback); only the mode changes.
    this.config = {
      ...this.config,
      sandbox: { ...this.config.sandbox, mode },
    };
    this.sandbox = resolveSandbox(this.config.sandbox, this.cwd);
    this._sandboxUnavailable =
      this.sandbox.mode !== "off" &&
      detectSandboxBackend() === "none" &&
      this.sandbox.fallback === "deny";
    this.permissions.setSandbox(this.sandbox, this.cwd);
    if (this.config.hookSandbox) {
      this.hooks.setCommandSandbox(this.sandbox);
    }
    // Restart the persistent shell so the next command is (un)jailed per the new
    // policy. A command already in flight keeps its old shell; the switch takes
    // effect from the next bash call — the honest boundary for a live change.
    if (this.persistentShell) {
      try {
        this.persistentShell.close();
      } catch {
        /* ignore */
      }
      this.persistentShell = this.startPersistentShell();
    }
    return this.getSandboxStatus();
  }

 /** Sandbox availability status. When `unavailable` is true, bash commands
 * are being refused because sandbox mode is active but no OS backend
 * exists and fallback is "deny". The host should surface this to the
 * user (e.g. a warning banner) — `reason` carries structured, platform
 * specific install guidance when unavailable. */
  getSandboxStatus(): SandboxStatus {
    const backend = detectSandboxBackend();
    return {
      mode: this.sandbox.mode,
      unavailable: this._sandboxUnavailable,
      backend,
      reason: this._sandboxUnavailable ? buildSandboxUnavailable() : undefined,
    };
  }

  /**
   * Hot-apply a new permission mode to the LIVE session. The engine reads its
   * mode at every preflight, so this takes effect from the next tool call. Also
   * updates `config.permissionMode` so anything that re-derives from config
   * (e.g. a system-prompt rebuild) sees the new posture. Returns the applied
   * mode. This is the permission-side counterpart of {@link setSandboxMode}.
   */
  setPermissionMode(mode: PermissionMode): PermissionMode {
    this.config = { ...this.config, permissionMode: mode };
    this.permissions.setMode(mode);
    return mode;
  }

  /** Active permission mode. */
  getPermissionMode(): PermissionMode {
    return this.permissions.getMode();
  }

 /** Recovery outcome if a crash-interrupted run was sealed to idle when this
  * session loaded (else undefined). The host can surface it ("the previous run
  * was interrupted — you can continue") after attaching, since the matching
  * `interrupted_run` event fires during init before any host subscribes. */
  getInterruptedRecovery(): InterruptedRunInfo | undefined {
    return this.interruptedRecovery;
  }

 /** How many torn-tail repairs this session performed on load (a crash-left
  * incomplete final JSONL line truncated to the last complete record). Normally
  * 0; non-zero indicates a prior crash during an append. */
  getTornTailRepairs(): number {
    return this.tornTailRepairs;
  }

  /**
   * Apply a named permission preset: a single switch that sets BOTH the
   * permission mode and the sandbox mode. Composes the two existing live
   * switches ({@link setPermissionMode} + {@link setSandboxMode}) so a preset
   * can never drift from the real enforcement. Returns the resolved posture.
   * The host is responsible for persisting the choice if it wants it to
   * survive the session (the sandbox half already persists via the
   * `config/setSandbox` RPC path when driven through the server).
   */
  setPreset(name: PermissionPresetName): {
    preset: PermissionPresetName;
    permissionMode: PermissionMode;
    sandbox: ReturnType<Session["getSandboxStatus"]>;
  } {
    const spec = PERMISSION_PRESETS[name];
    this.setPermissionMode(spec.permissionMode);
    const sandbox = this.setSandboxMode(spec.sandbox);
    return { preset: name, permissionMode: spec.permissionMode, sandbox };
  }

 /** Active permission rules (session + config), for UI display. */
  getPermissionRules() {
    return this.permissions.rules();
  }

 /** True when the active model is high-risk and persisted allow rules are being
  * ignored during matching (deny / ask + floors still apply). Lets a UI surface
  * a "saved allow rules bypassed" badge so the stricter posture is visible. */
  isIgnoringPersistedAllows(): boolean {
    return this.permissions.isIgnoringPersistedAllows();
  }

 /** Persisted permission rules by scope (repo / user), for the saved-rule
  * management surface. Reads the config files directly — the on-disk source of
  * truth for durable rules — not the in-memory merged set. */
  async listSavedPermissionRules(scope: "repo" | "user" = "repo") {
    const { listPersistedRules } = await import("./permissions.js");
    return listPersistedRules(this.cwd, scope);
  }

 /** Add a persisted permission rule in a scope and hot-apply it to the live
  * engine (so it takes effect this session and unlocks any pending prompt it
  * covers). Returns the config path written. */
  async addSavedPermissionRule(
    rule: string,
    effect: "allow" | "ask" | "deny",
    scope: "repo" | "user" = "repo",
  ): Promise<string> {
    const { persistRule } = await import("./permissions.js");
    const path = await persistRule(this.cwd, rule, effect, scope);
    this.permissions.addConfigRule(rule, effect);
    return path;
  }

 /** Remove a persisted permission rule from a scope and hot-apply the removal
  * to the live engine. Returns true when a rule was removed. */
  async removeSavedPermissionRule(
    rule: string,
    effect: "allow" | "ask" | "deny",
    scope: "repo" | "user" = "repo",
  ): Promise<boolean> {
    const { removePersistedRule } = await import("./permissions.js");
    const removed = await removePersistedRule(this.cwd, rule, effect, scope);
    if (removed) this.permissions.removeConfigRule(rule, effect);
    return removed;
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

 /**
  * Attribute re-billed (un-cached) input tokens to a cause — idle-TTL expiry,
  * model switch, or an expected re-bill at a compaction boundary — and quantify
  * the dollar waste. Pure view over the per-turn usage this session recorded;
  * drives cost visibility in `/session`. Fail-soft: unknown model price yields
  * a zero-cost (but still token-counted) miss.
  */
  getCacheWaste(): CacheWasteReport {
    return analyzeCacheWaste(
      this.cacheTurns,
      cacheTtlMs(this.model, this.config.promptCache?.ttl) ?? undefined,
    );
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

 /** Status-line configuration (declarative preset or custom script). */
  getStatusLineConfig(): import("./types.js").StatusLineConfig | undefined {
    return this.config.statusLine;
  }

 /** Latest provider rate-limit snapshot, or undefined when none captured. Fed
  * into the status-line payload so a preset/script can show remaining budget. */
  getRateLimitSnapshot():
    | { requestsRemaining?: number; tokensRemaining?: number; resetsInSeconds?: number }
    | undefined {
    return this.rateLimitSnapshot;
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

  /**
   * Create a new session seeded with this session's history.
   *
   * By default the fork copies `this.events` — the MODEL-FACING view, which
   * after a compaction starts at the latest summary and omits the archived
   * pre-compaction turns. That is the right default: the fork continues from
   * the same context the parent currently has, not re-inflated history the
   * parent itself already dropped.
   *
   * Pass `{ fullHistory: true }` to instead copy `this.persisted` — the
   * complete append-only log, including everything before the last compaction.
   * Use this when the fork must be able to replay the full original trajectory
   * (e.g. audit / branch-from-arbitrary-point). `atEventIndex` slices whichever
   * source is selected.
   */
  async fork(
    atEventIndex?: number,
    opts?: { fullHistory?: boolean },
  ): Promise<Session> {
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
    const source = opts?.fullHistory ? this.persisted : this.events;
    const slice = atEventIndex === undefined
      ? source
      : source.slice(0, atEventIndex);
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
    // Interrupt any still-running background sub-agents so they stop promptly
    // and release their permits when the session goes away.
    this.backgroundSubagents.interruptAll();
    // Flush any buffered telemetry spans so a clean shutdown never drops the
    // last batch (spans otherwise flush at ~64 or every 5s). Best-effort.
    await getTracer().flush().catch(() => undefined);
    // Flush an in-flight background checkpoint so a clean shutdown never drops
    // it. Only a true crash (no dispose) can lose one, and the next session at
    // the same threshold simply rewrites it. Fail-soft: the task already logs.
    if (this.pendingCheckpoint) {
      await this.pendingCheckpoint.catch(() => undefined);
    }
    // Drain + close the additive event sink so a clean shutdown mirrors every
    // queued line. Best-effort (the queue swallows sink errors); never blocks
    // the rest of dispose for long because the queue is bounded.
    if (this.eventSink) {
      const sink = this.eventSink;
      this.eventSink = undefined;
      await sink.close().catch(() => undefined);
    }
    this.cancelCacheWarm();
    this.cancel();
    this.listeners.clear();
 // Detach background-job completion listeners.
    for (const off of this.jobListeners) {
      try { off(); } catch { /* ignore */ }
    }
    this.jobListeners = [];
    if (this.lspManager) {
      const mgr = this.lspManager;
      this.lspManager = null;
      void mgr.stopAll().catch(() => undefined);
    }
    if (this.netProxy) {
      const proxy = this.netProxy;
      this.netProxy = null;
      void proxy.close().catch(() => undefined);
    }
    if (this.persistentShell) {
      this.persistentShell.close();
      this.persistentShell = null;
    }
    const mcp = this.mcp;
    this.mcp = null;
    this.mcpReady = Promise.resolve(null);
    // Detach our reverse-request handler BEFORE releasing: on a shared manager
    // the handler set outlives this session's ref, so leaving it registered
    // would route a later server reverse request to this disposed session.
    this.mcpUnregisterRequestHandler?.();
    this.mcpUnregisterRequestHandler = null;
    this.mcpRequestHandler = null;
    this.mcpUnregisterToolsChanged?.();
    this.mcpUnregisterToolsChanged = null;
    this.mcpUnregisterNotification?.();
    this.mcpUnregisterNotification = null;
    if (mcp) {
      const { releaseSharedMcp } = await import("./mcp-pool.js");
      await releaseSharedMcp(mcp);
    }
    // Release the single-writer lease last, after all writes are done, so the id
    // becomes acquirable by another process. A crash (no dispose) leaves a stale
    // lock that the next acquirer reclaims via a pid-liveness check.
    try {
      this.writerLease?.release();
    } catch {
      /* best-effort — a crashed-owner reclaim handles a leftover lock */
    }
    this.writerLease = null;
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

  /**
   * Surface a `goal_progress` event to subscribers (UIs) without persisting it.
   * The authoritative per-round record lives in the goal checkpoint file; this
   * is purely a live notification so a host driving `driveGoalRounds` can show
   * round/status progress. Informational only — never part of model context.
   */
  emitGoalProgress(info: {
    round: number;
    status: "running" | "completed" | "blocked" | "round_limit";
    maxRounds?: number;
    reason?: string;
    blockedReason?: string;
  }): void {
    this.notify({
      type: "goal_progress",
      round: info.round,
      status: info.status,
      ...(info.maxRounds !== undefined ? { maxRounds: info.maxRounds } : {}),
      ...(info.reason !== undefined ? { reason: info.reason } : {}),
      ...(info.blockedReason !== undefined ? { blockedReason: info.blockedReason } : {}),
    });
  }

  private registerBuiltins(): void {
    this.toolRegistry.register(bashTool);
    this.toolRegistry.register(bashOutputTool);
    this.toolRegistry.register(bashKillTool);
    this.toolRegistry.register(writeStdinTool);
    this.toolRegistry.register(notebookEditTool);
    this.toolRegistry.register(webFetchTool);
    this.toolRegistry.register(webSearchTool);
    // image_gen is opt-in: only register when an image endpoint is configured
    // (baseURL + apiKey), since not every provider can generate images.
    if (resolveImageEndpoint(this.config.imageGen)) {
      imageGenTool.config = this.config.imageGen;
      this.toolRegistry.register(imageGenTool);
    }
    this.toolRegistry.register(readFileTool);
    this.toolRegistry.register(readImageTool);
    this.toolRegistry.register(writeFileTool);
    this.toolRegistry.register(editFileTool);
    this.toolRegistry.register(applyPatchTool);
    this.toolRegistry.register(codeModeTool);
    // harness_bridge invokes an external agent CLI (claude/codex/custom) as a
    // sandboxed subprocess. Opt-in: only register when explicitly enabled, so
    // the tool table isn't polluted on hosts without those CLIs installed.
    if (this.config.enableHarnessBridge === true) {
      this.toolRegistry.register(harnessBridgeTool);
    }
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
    // start_new_task: model-triggered task boundary → clearWorkingContext.
    const startNewTask = { ...startNewTaskTool };
    startNewTask.onStartNewTask = (reason) => this.clearWorkingContext(reason);
    this.toolRegistry.register(startNewTask);
    // suggest_mode: model proposes a collaboration-mode switch; the user
    // confirms (or auto-accepts). Per-session copy so the wiring is isolated.
    const suggestMode = { ...suggestModeTool };
    suggestMode.currentMode = () => this.mode;
    suggestMode.autoAccept = () => this.autoAcceptModeSuggestions;
    this.toolRegistry.register(suggestMode);
    // start_goal: model escalates the current task into a long-horizon goal
    // loop. The tool emits a `goal_request` event (parsed in the agent loop);
    // the handle reports whether a host goal-driver accepted it. Without a
    // host handler it degrades to a no-op ack so the model just continues.
    const startGoal = { ...startGoalTool };
    startGoal.onStartGoal = async (objective, maxRounds, reason) => {
      if (!this.onGoalRequest) return false;
      return await this.onGoalRequest({
        objective,
        ...(maxRounds ? { maxRounds } : {}),
        ...(reason ? { reason } : {}),
      });
    };
    this.toolRegistry.register(startGoal);
    // goal_status: structured channel for reporting a goal loop's terminal
    // state. Emits a `goal_status` event (parsed in the agent loop) the goal
    // loop trusts ahead of the text markers; a no-op outside a goal loop.
    this.toolRegistry.register(goalStatusTool);
    this.toolRegistry.register(memoryWrite);
    const skillHandle = createSkillTool();
    this.skillToolHandle = skillHandle;
    this.toolRegistry.register(skillHandle.tool);
    this.lspManager = new LspManager(this.config.lsp?.servers);
    this.toolRegistry.register(
      makeLspNavigateTool(() => this.lspManager, () => this.cwd),
    );
    this.toolRegistry.register(task);
    this.toolRegistry.register(planDone);
    // `mcp` meta-tool for on-demand MCP tool discovery (list/describe/call).
    // Only registered when MCP servers are configured; it becomes the primary
    // access path when lazy discovery hides individual MCP tool schemas. Reads
    // the registry lazily so MCP tools that register after boot are visible.
    const hasMcp = Object.values(this.config.mcpServers ?? {}).some((c) => c && !c.disabled);
    if (hasMcp) {
      this.toolRegistry.register(makeMcpMetaTool(() => this.toolRegistry));
    }
    // `tool_catalog` meta-tool for on-demand access to plugin tools whose
    // schemas are hidden under lazy discovery. Only registered when plugin lazy
    // discovery is opted into ("lazy"/"auto"); the default ("eager") sends every
    // plugin schema directly, so the meta-tool is absent and the default
    // behaviour is unchanged. Reads the registry lazily so plugin tools that
    // register after boot are reachable.
    const pluginDiscovery = this.config.pluginToolDiscovery ?? "eager";
    if (pluginDiscovery === "lazy" || pluginDiscovery === "auto") {
      this.toolRegistry.register(
        makeToolCatalogTool(() => this.toolRegistry, (t) => t.source === "plugin"),
      );
    }

 // Wire the memory sink (MEMORY.md + progressive index/topic mirror).
    memoryWrite.sink = new FileMemorySink(this.cwd, {
      autoMemory:
        this.config.autoMemoryEnabled === false ? false : { enabled: true },
      redactPatterns: this.redactPatterns,
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
      onAskUser: this.onAskUser,
      getSandbox: () => this.sandbox,
      expandSandboxWritable: (dir, opts) =>
        this.expandWritablePath(dir, opts).then(() => undefined),
      getDeliveryRoots: () => this.deliveryRoots,
      addDeliveryRoot: (dir) => this.addDeliveryRoot(dir),
      scratchDir: () => scratchDir(this.cwd, this.id),
      projectStateDir: () => projectStatePath(this.cwd),
      // Model-visible history for a `context: "fork"` sub-agent — the same
      // post-compaction working set the model itself sees.
      getParentEvents: () => this.getEvents(),
      buildToolRegistry: (agentType) =>
        buildSubagentToolRegistry(agentType, {
          getManager: () => this.lspManager,
          getCwd: () => this.cwd,
        }),
      hooks: this.hooks,
      resolveCustomAgent: async (name) => this.customAgents.get(name),
    });
 // Per-sub-agent wall-clock budget (optional). Enforced by the task tool's
 // shared semaphore so a stuck worker can't starve a parallel fan-out.
    task.subagentTimeoutMs = this.config.subagentTimeoutMs;
 // Scale knobs for large fan-out (config-overridable, conservative defaults):
 // nesting depth, concurrent threads, and a total-spawn cap that bounds the
 // whole run regardless of tree shape. See tools/task.ts for the guards.
    if (typeof this.config.subagentMaxDepth === "number") task.maxDepth = this.config.subagentMaxDepth;
    if (typeof this.config.subagentMaxThreads === "number") task.maxThreads = this.config.subagentMaxThreads;
    if (typeof this.config.subagentMaxTotal === "number") task.maxTotal = this.config.subagentMaxTotal;
 // Durable conclusion-reuse cache policy (default on, 24h TTL). See types.ts.
    task.cacheEnabled = this.config.subagentCache?.enabled;
    if (typeof this.config.subagentCache?.ttlHours === "number") {
      task.cacheTtlMs = this.config.subagentCache.ttlHours * 60 * 60 * 1000;
    }
    // Background sub-agents (`run: "background"`): a per-session registry so a
    // dispatched job can be listed / waited / interrupted, and so its one-time
    // completion summary is steered back to the parent. Shared with the control
    // tools below.
    task.backgroundRegistry = this.backgroundSubagents;
    this.backgroundSubagents.onCompletion((meta) => {
      this.deliverBackgroundCompletion(meta);
    });
    subagentListTool.registry = this.backgroundSubagents;
    subagentWaitTool.registry = this.backgroundSubagents;
    subagentInterruptTool.registry = this.backgroundSubagents;
    this.toolRegistry.register(subagentListTool);
    this.toolRegistry.register(subagentWaitTool);
    this.toolRegistry.register(subagentInterruptTool);

    this.wireHookResolvers(task.runner);
  }

  /**
   * Deliver a background sub-agent's one-time completion summary to the parent.
   * Rides the same out-of-band system-steer channel as other background-job
   * notices (bash jobs, MCP notifications): it lands in the current turn when
   * busy, or is picked up at the start of the next turn when idle. This is a
   * single notice, not a chat channel — to iterate with the sub-agent the model
   * re-dispatches with `continue_session_id`.
   */
  private deliverBackgroundCompletion(meta: BackgroundSubagentMeta): void {
    const obj =
      meta.objective.length > 100 ? `${meta.objective.slice(0, 97)}…` : meta.objective;
    const summary = meta.summary ? `\n\n${meta.summary}` : "";
    const verb =
      meta.status === "interrupted"
        ? "was interrupted"
        : meta.status === "failed"
          ? "failed"
          : "finished";
    this.steerSystem(
      `[background sub-agent ${meta.sessionId} ${verb}] objective: ${obj}` +
        `${summary}\n\n(To continue this sub-agent, dispatch task with ` +
        `continue_session_id: "${meta.sessionId}".)`,
    );
  }

  /**
   * Host permission handler wrapper that implements the pending-batch unlock:
   * tracks each in-flight prompt so that when one is answered always /
   * always-project (adding a session rule), the others are re-preflighted and
   * any now-allowed waiter auto-resolves. Falls back to the raw host handler
   * when none is configured.
   */
  private onPermissionRequestWithBatch(
    req: PermissionRequest,
  ): Promise<PermissionResolution> {
    const host = this.onPermissionRequest;
    if (!host) return Promise.resolve("deny" as PermissionResolution);
    const tool = this.toolRegistry.get(req.toolName);
    return new Promise<PermissionResolution>((resolve) => {
      let settled = false;
      const done = (r: PermissionResolution): void => {
        if (settled) return;
        settled = true;
        this.pendingPermissionWaiters.delete(req.requestId);
        resolve(r);
      };
      // Only track waiters we can re-preflight (need the ToolDef + input).
      if (tool) {
        this.pendingPermissionWaiters.set(req.requestId, {
          tool,
          input: req.input,
          resolve: done,
        });
      }
      host(req).then(done, () => done("deny" as PermissionResolution));
    });
  }

  /**
   * Re-preflight every still-pending permission waiter against the current
   * engine rules; auto-resolve those that now evaluate to allow. Called after a
   * session rule is added (an always grant or a CRUD hot-load). The waiter that
   * triggered the grant has already been removed, so this only unlocks the rest.
   */
  private unlockPendingPermissions(): void {
    if (this.pendingPermissionWaiters.size === 0) return;
    for (const [id, w] of Array.from(this.pendingPermissionWaiters)) {
      const check = this.permissions.preflight(w.tool, w.input);
      if (check !== "ask" && check.decision === "allow") {
        this.pendingPermissionWaiters.delete(id);
        w.resolve("allow");
      }
    }
  }

  /**
   * Re-evaluate the high-risk-model gate against the active model and tell the
   * permission engine whether to ignore persisted allow rules. Idempotent; call
   * whenever the model changes so a switch to (or away from) a high-risk model
   * tightens (or relaxes) matching immediately.
   */
  private applyHighRiskModelGate(): void {
    const list = this.config.highRiskModels ?? [];
    const model = (this.model ?? "").toLowerCase();
    const highRisk =
      !!model && list.some((m) => model.includes(m.toLowerCase()));
    this.permissions.setIgnorePersistedAllows(highRisk, {
      dropSessionAllows: this.config.highRiskDropSessionAllows,
    });
  }

  /**
   * Build (once) the small-model classifier used by the `auto` permission
   * mode. Reuses the same small-model wiring as the Stop verifier's prompt
   * resolver; any failure in the underlying call maps to `uncertain`, so the
   * engine falls back to an interactive prompt rather than silently allowing.
   */
  private getPermissionClassifier(): PermissionClassifier {
    if (this.permissionClassifier) return this.permissionClassifier;
    this.permissionClassifier = createPromptPermissionClassifier(
      async (policy, payload, signal) => {
        const provider = buildSmallProvider(this.config);
        const model = this.config.smallModel ?? provider.smallModel ?? this.model;
        const body =
          `${policy}\n\n` +
          `Respond with a single JSON object only.\n\n` +
          `Call:\n${JSON.stringify(payload).slice(0, 8_000)}`;
        let out = "";
        for await (const ev of provider.stream({
          model,
          messages: [{ role: "user", content: [{ type: "text", text: body }] }],
          maxTokens: 512,
          signal,
        })) {
          if (ev.kind === "text_delta") out += ev.text;
          if (ev.kind === "error") throw new Error(ev.message);
        }
        return out.trim();
      },
    );
    return this.permissionClassifier;
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
        const r = await mgr.invoke(server, tool, args, this.mcpRequestHandler);
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
      setMcpRequestHandlerCleanup: (unregister) => {
        this.mcpUnregisterRequestHandler = unregister;
      },
      setMcpRequestHandler: (handler) => {
        this.mcpRequestHandler = handler;
      },
      setMcpToolsChangedCleanup: (unregister) => {
        this.mcpUnregisterToolsChanged = unregister;
      },
      onMcpInboundNotification: (server, method, params) => {
        this.steerSystem(formatInboundNotification(server, method, params));
      },
      setMcpNotificationCleanup: (unregister) => {
        this.mcpUnregisterNotification = unregister;
      },
    });
  }

  /**
   * Fold persisted `pin` control events onto their target messages. Latest
   * pin per message id wins (so a later unpin overrides an earlier pin). Runs
   * on load and is cheap (one pass; sessions rarely have many pins).
   */
  private applyPersistedPins(): void {
    const latest = new Map<string, boolean>();
    for (const e of this.events) {
      if (e.type === "pin") latest.set(e.messageId, e.pinned);
    }
    if (latest.size === 0) return;
    for (const e of this.events) {
      if (e.type === "message" && latest.has(e.id)) {
        e.pinned = latest.get(e.id) ? true : undefined;
      }
    }
  }

  /**
   * Rebuild the undo/redo stacks from persisted `undo_boundary` events so
   * `/undo` works after a reload. Replays each action in order (push appends an
   * undo entry and clears redo; undo moves the top undo entry to redo; redo moves
   * it back). An entry whose snapshot directories no longer exist on disk is
   * dropped — its file state can't be restored, so offering it would fail.
   */
  private rebuildUndoStacks(): void {
    const snapshotsDir = projectStatePath(this.cwd, "snapshots");
    const snapshotExists = (id: string): boolean =>
      existsSync(pathResolve(snapshotsDir, id, "manifest.json"));
    const undo: Array<{ baselineId: string; afterId: string; label: string }> = [];
    const redo: Array<{ baselineId: string; afterId: string; label: string }> = [];
    for (const e of this.persisted) {
      if (e.type !== "undo_boundary") continue;
      const entry = { baselineId: e.baselineId, afterId: e.afterId, label: e.label };
      if (e.action === "push") {
        undo.push(entry);
        redo.length = 0;
      } else if (e.action === "undo") {
        if (undo.length > 0) undo.pop();
        redo.push(entry);
      } else {
        // redo
        if (redo.length > 0) redo.pop();
        undo.push(entry);
      }
    }
    // Drop entries whose snapshots are gone (both ids must be restorable).
    this.undoStack = undo.filter((e) => snapshotExists(e.baselineId) && snapshotExists(e.afterId));
    this.redoStack = redo.filter((e) => snapshotExists(e.baselineId) && snapshotExists(e.afterId));
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const path = sessionPath(this.id);
      // Cold-storage: a session compressed by housekeeping has only a `.jsonl.br`.
      // A write-open session is thawed back to plaintext first (it is about to
      // append); a read-only open reads the compressed text directly without
      // materializing the plaintext. Both are no-ops for a normal live session.
      let text: string;
      if (!this.readOnly) {
        await thawSession(this.id).catch(() => undefined);
        text = await readFile(path, "utf-8");
      } else {
        try {
          text = await readFile(path, "utf-8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          const cold = await readColdSessionText(this.id);
          if (cold === null) throw err;
          text = cold;
        }
      }
      // Physical integrity: if the process crashed mid-append, the final line
      // can be a torn (incomplete) JSON fragment with no trailing newline. We
      // skip it when parsing (below), but a torn tail also poisons the NEXT
      // Repair a torn tail on write-open: truncate to the last complete `\n`
      // boundary so appendFile doesn't concatenate onto a partial line.
      if (!this.readOnly) {
        await this.repairTornTail(path, text).catch(() => undefined);
      }
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      // Parse synchronously and only `await` the image rehydration for the few
      // events that actually carry offloaded images. Awaiting every event (most
      // have none) forced one microtask round-trip per line — on multi-hundred-
      // line sessions that dominated resume latency for no work.
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Event;
          if (eventHasOffloadedImages(parsed)) {
            // Rehydrate offloaded images (base64 stored as an artifact ref) so
            // the in-memory transcript is complete.
            this.persisted.push(await this.rehydrateEventImages(parsed));
          } else {
            this.persisted.push(parsed);
          }
        } catch {
 /* skip malformed */
        }
      }
      this.events = liveTranscript(this.persisted);
      // Reapply compaction anchors: the latest `pin` per message id wins
      // (append-only safe — the original message line is never rewritten).
      this.applyPersistedPins();
      // Rebuild undo/redo stacks so `/undo` survives a reload.
      this.rebuildUndoStacks();
      for (let i = this.persisted.length - 1; i >= 0; i--) {
        const link = linkIdForEvent(this.persisted[i]!);
        if (link) {
          this.lastPersistedLinkId = link;
          break;
        }
      }
      // Seed the turn counter from the highest claim turn already recorded (or
      // the user-message count as a fallback), so a resumed run's claim does not
      // restart numbering at 1.
      let maxTurn = 0;
      let userMessages = 0;
      for (const e of this.persisted) {
        if (e.type === "status" && e.claim) maxTurn = Math.max(maxTurn, e.claim.turn);
        else if (e.type === "message" && e.role === "user") userMessages += 1;
      }
      this.turnCounter = Math.max(maxTurn, userMessages);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
 // Hydrate title from sidecar (if any).
    const t = await loadTitleFromDisk(this.id);
    if (t) this.title = t;
  }

 /**
  * Repair a torn JSONL tail left by a crash mid-append. `text` is the full
  * file contents already read by loadFromDisk. If the file is non-empty and its
  * final line is a torn (incomplete) JSON fragment — the file does NOT end in a
  * newline AND that trailing fragment does not parse as JSON — truncate the
  * file back to the last complete newline boundary. This keeps the log
  * self-consistent and, critically, prevents the next append from concatenating
  * a new line onto the fragment (appendFile does not insert a separator). A
  * file that already ends in a newline, is empty, or whose trailing fragment
  * happens to be valid JSON is left untouched. Best-effort and write-open only.
  */
  private async repairTornTail(path: string, text: string): Promise<void> {
    if (text.length === 0) return;
    // A trailing newline means the last record was fully flushed — nothing torn.
    if (text.endsWith("\n")) return;
    const lastNl = text.lastIndexOf("\n");
    // The bytes after the final newline (or the whole file, if there is none)
    // are the un-terminated trailing fragment.
    const tail = text.slice(lastNl + 1);
    if (tail.trim().length === 0) return;
    try {
      JSON.parse(tail);
      // The fragment is valid JSON that merely lacks a trailing newline. Don't
      // drop a good record — restore the missing separator so the next append
      // starts on its own line.
      await appendFile(path, "\n", "utf-8");
      return;
    } catch {
      /* genuinely torn — fall through to truncate */
    }
    // Truncate to the last complete record. lastNl < 0 means the file is a
    // single torn line with no prior complete record → truncate to empty.
    const keep = lastNl >= 0 ? lastNl + 1 : 0;
    await truncate(path, keep);
    this.tornTailRepairs += 1;
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
    // Read-only open holds no write lease — leave the stale status as-is rather
    // than sealing it; only the lease-holding writer may seal.
    if (this.readOnly) return;
    let lastStatus: string | null = null;
    let lastClaim: Extract<Event, { type: "status" }>["claim"] | undefined;
    for (const e of this.events) {
      if (e.type === "status") {
        lastStatus = e.status;
        // Track the most recent claim so the recovery hint can report which
        // execution was interrupted. A claim-less heartbeat does not clear it.
        if (e.claim) lastClaim = e.claim;
      }
    }
    if (lastStatus === "running" || lastStatus === "waiting_permission") {
 // The prior run was cut off mid-flight. Before flipping to `idle`, seal
 // any tool call it left unanswered so the persisted JSONL is
 // self-consistent (every tool_call has a matching tool_result). The
 // provider-message builder already repairs dangling calls in-memory
 // Seal orphan tool_calls on disk (the in-memory side is handled by
 // `closeOpenCalls`) with the same `INTERRUPTED_RESULT` so the raw log
 // stays valid for export and replay.
      const sealedToolCalls = await this.sealOrphanedToolCalls();
      const ev: Event = { type: "status", status: "idle" };
      this.events.push(ev);
      await this.persistEvent(ev).catch(() => undefined);
 // Flag it so the next prompt's system prompt carries a recovery
 // instruction (resume from checkpoint, don't redo finished steps).
      this.resumedFromInterrupt = true;
 // Record the recovery so a host that subscribes after init (and the
 // boot-time recovery sweep, which creates + inspects + disposes the
 // session) can retrieve it via getInterruptedRecovery(). The matching
 // notify below only reaches listeners already attached during init.
      this.interruptedRecovery = {
        sessionId: this.id,
        ...(lastClaim
          ? {
              claim: {
                executionId: lastClaim.executionId,
                turn: lastClaim.turn,
                model: lastClaim.model,
                startedAt: lastClaim.startedAt,
              },
            }
          : {}),
        sealedToolCalls,
      };
 // Advisory for the host: the previous run was interrupted and has been
 // sealed to a clean idle. NOT persisted and never sent to the model — the
 // model's recovery context rides on the `<interrupted_run>` system block.
 // Default posture is seal-and-idle: we do NOT auto-re-enter runAgent.
      this.notify({ type: "interrupted_run", ...this.interruptedRecovery });
    }
  }

  /**
   * Append a synthetic `tool_result` for every tool call in the log that has no
   * answering `tool_result`, so the persisted JSONL leaves no `tool_use` without
   * a result after a mid-turn crash. A tool call is identified from either a
   * `tool_call` event or a `tool_use` block inside an assistant message (the log
   * records it both ways); a result from a `tool_result` event. Order of the
   * sealed results does not matter — the message builder keys them by id — but we
   * emit them in first-seen order for a readable log. Returns the number sealed.
   */
  private async sealOrphanedToolCalls(): Promise<number> {
    const callNames = new Map<string, string>();
    const answered = new Set<string>();
    // Calls that reached execution (a `tool_started` marker was persisted).
    const started = new Set<string>();
    for (const e of this.events) {
      if (e.type === "tool_call") {
        if (!callNames.has(e.id)) callNames.set(e.id, e.name);
      } else if (e.type === "message" && e.role === "assistant") {
        for (const b of e.content) {
          if (b.type === "tool_use" && !callNames.has(b.id)) callNames.set(b.id, b.name);
        }
      } else if (e.type === "tool_result") {
        answered.add(e.toolCallId);
      } else if (e.type === "tool_started") {
        started.add(e.toolCallId);
      }
    }
    let sealed = 0;
    for (const [id, name] of callNames) {
      if (answered.has(id)) continue;
      // A call killed before it started (no marker) never took effect and is
      // safe to retry; one with a marker but no result has an UNKNOWN outcome.
      const ev: Event = {
        type: "tool_result",
        toolCallId: id,
        name,
        content: started.has(id) ? INTERRUPTED_RESULT : NOT_STARTED_RESULT,
        isError: true,
      };
      this.events.push(ev);
      await this.persistEvent(ev).catch(() => undefined);
      sealed += 1;
    }
    return sealed;
  }

  /** Link ids of every event already in the append-only log. */
  private persistedLinkIdSet(): Set<string> {
    const ids = new Set<string>();
    for (const p of this.persisted) {
      const id = linkIdForEvent(p);
      if (id) ids.add(id);
    }
    return ids;
  }

  /**
   * The subset of a compaction result that is genuinely new and must be
   * appended to the log: the synthesised `compaction` summary (new by
   * construction) plus any `plan`/pins/tail events whose stable link id is not
   * already persisted. Everything already on disk — the retained tail, folded
   * copies (same link id as their original), carried-forward pins — is skipped,
   * so the append-only log is never duplicated.
   */
  private newCompactionEvents(events: Event[]): Event[] {
    const persistedLinkIds = this.persistedLinkIdSet();
    const out: Event[] = [];
    for (const e of events) {
      // The fresh compaction summary heads the result and is always new; keep it
      // even if its (keepFrom-less) link id coincidentally collides.
      if (e.type === "compaction") {
        out.push(e);
        continue;
      }
      const id = linkIdForEvent(e);
      if (id && persistedLinkIds.has(id)) continue;
      if (this.persisted.includes(e)) continue;
      out.push(e);
    }
    return out;
  }

  /**
   * The compaction `keepFrom` boundary: the position in `this.persisted` of the
   * first retained tail event — i.e. the first event in `events` (after the new
   * prefix) that is already persisted. Matched by link id so a folded/stamped
   * copy still resolves to its on-disk original. Returns `this.persisted.length`
   * (empty tail) when no retained event is found.
   */
  private compactionKeepFrom(events: Event[]): number {
    const persistedLinkIds = this.persistedLinkIdSet();
    for (const e of events) {
      if (e.type === "compaction") continue;
      const byRef = this.persisted.indexOf(e);
      if (byRef >= 0) return byRef;
      const id = linkIdForEvent(e);
      if (id && persistedLinkIds.has(id)) {
        const idx = this.persisted.findIndex((p) => linkIdForEvent(p) === id);
        if (idx >= 0) return idx;
      }
    }
    return this.persisted.length;
  }

  private async persistEvent(e: Event): Promise<void> {
    // Read-only open: never touch the JSONL. The in-memory transcript is still
    // maintained by callers (they push to this.events); only the durable write
    // is suppressed, since this process does not hold the write lease.
    if (this.readOnly) return;
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
    // Offload large inline image base64 to the content-addressed artifact store
    // before writing the JSONL line. Identical images dedup by hash, and a
    // 5 MB screenshot no longer bloats the session log (or gets re-read on every
    // resume). The in-memory `stamped`/`this.persisted` copies keep their base64;
    // only the on-disk line is slimmed. Rehydrated in `loadFromDisk`.
    const { event: forDisk, offloads } = await this.offloadEventImages(stamped);
    const line = JSON.stringify(forDisk);
    await appendFile(path, line + "\n", "utf-8");
    // Additive mirror: hand the exact JSONL line to an optional external sink
    // AFTER the canonical append resolves. Enqueue is synchronous, bounded, and
    // fail-soft — it never blocks or fails this write (JSONL is the source of
    // truth). No-op when no plugin/host registered a sink.
    this.eventSink?.enqueue(this.id, line);
    // Record every large-payload offload as a durable content_replacement so a
    // fork can replicate it and artifact GC / audit can walk referenced refs
    // from the JSONL. Covers both image offload (just done above) and a
    // tool_result whose large content was spilled upstream (it arrives here
    // already carrying an artifactRef). These records never go to the model and
    // are rendered quietly. Skipped while persisting a content_replacement
    // itself, so there is no recursion.
    if (stamped.type !== "content_replacement") {
      await this.recordContentReplacements(stamped, offloads);
    }
  }

 /** Append a `content_replacement` audit record for each payload moved to the
  * artifact store while persisting `e`: the images just offloaded (passed in),
  * plus a tool_result that already carries an `artifactRef` from an upstream
  * spill. Best-effort — a failed audit never blocks the canonical write. */
  private async recordContentReplacements(
    e: Event,
    imageOffloads: Array<{ ref: string; bytes: number }>,
  ): Promise<void> {
    const records: Array<Extract<Event, { type: "content_replacement" }>> = [];
    for (const off of imageOffloads) {
      records.push({
        type: "content_replacement",
        ownerId: (e as { id?: string }).id ?? this.id,
        target: "image",
        artifactRef: off.ref,
        bytes: off.bytes,
      });
    }
    if (e.type === "tool_result" && e.artifactRef) {
      // The full payload's authoritative size is the stored artifact's size;
      // the inline content is only the head+tail stub.
      const bytes =
        (await this.artifacts.size(e.artifactRef)) ??
        Buffer.byteLength(e.content, "utf-8");
      records.push({
        type: "content_replacement",
        ownerId: e.toolCallId,
        target: "tool_result",
        artifactRef: e.artifactRef,
        bytes,
        tool: e.name,
      });
    }
    for (const rec of records) {
      this.events.push(rec);
      // persistEvent again — but the content_replacement short-circuits the
      // recursion guard above, so this just appends the audit line.
      await this.persistEvent(rec).catch(() => undefined);
      // Notify subscribers so a live UI can render it quietly. Non-model, not a
      // transcript row — clients surface it as an advisory (like micro-fold).
      this.notify(rec);
    }
  }

  /** Threshold above which an inline image is offloaded to an artifact. */
  private static readonly IMAGE_OFFLOAD_BYTES = 8 * 1024;

  /** Return a disk-serialisable copy of `e` with large `images[].base64`
   * replaced by `{ mediaType, ref }`, plus the list of offloads performed (ref
   * + original byte size) so the caller can record content_replacement audit
   * events. Small images stay inline. Non-image events pass through unchanged
   * (by reference — no copy cost) with an empty offload list. */
  private async offloadEventImages(
    e: Event,
  ): Promise<{ event: Event; offloads: Array<{ ref: string; bytes: number }> }> {
    const imgs = (e as { images?: ImageAttachment[] }).images;
    if (!Array.isArray(imgs) || imgs.length === 0) return { event: e, offloads: [] };
    let changed = false;
    const offloads: Array<{ ref: string; bytes: number }> = [];
    const mapped = await Promise.all(
      imgs.map(async (img) => {
        if (!img.base64 || img.base64.length < Session.IMAGE_OFFLOAD_BYTES) return img;
        try {
          const bytes = Buffer.byteLength(img.base64, "utf-8");
          const ref = await this.artifacts.write(img.base64, `image/${img.mediaType}`);
          changed = true;
          offloads.push({ ref, bytes });
          return { mediaType: img.mediaType, ref } as unknown as ImageAttachment;
        } catch {
          return img; // best-effort: keep inline if the store write fails
        }
      }),
    );
    if (!changed) return { event: e, offloads: [] };
    return { event: { ...e, images: mapped } as Event, offloads };
  }

  /** Rehydrate any offloaded `{ mediaType, ref }` images back to base64 after
   * loading from disk, so the in-memory transcript is complete. Best-effort:
   * a missing artifact leaves a placeholder note rather than crashing resume. */
  private async rehydrateEventImages(e: Event): Promise<Event> {
    const imgs = (e as { images?: Array<{ mediaType: string; base64?: string; ref?: string }> }).images;
    if (!Array.isArray(imgs) || imgs.length === 0) return e;
    let changed = false;
    const mapped = await Promise.all(
      imgs.map(async (img) => {
        if (img.base64 || !img.ref) return img;
        try {
          const base64 = await this.artifacts.read(img.ref);
          changed = true;
          return { mediaType: img.mediaType, base64 };
        } catch {
          changed = true;
          return { mediaType: img.mediaType, base64: "" }; // artifact gone
        }
      }),
    );
    if (!changed) return e;
    return { ...e, images: mapped } as Event;
  }

  private async rebuildSystemPrompt(): Promise<void> {
    const memory = summariseMemory(await readMemory(this.cwd));
 // Hierarchical shareable docs (CODEPILOT.md / AGENTS.md in the tree) plus
 // agent-written project-state MEMORY.md (already in memory.project).
    const layered = await readLayeredProjectMemory(this.cwd, {
      walkToHome: this.config.memory?.walkToHome === true,
    });
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
 // The system prompt advertises exactly the tool set the provider request
 // will carry this turn — the same filter chain (mode → lazy MCP → lazy plugin
 // → toolExposure) as buildProviderToolDefs — so the model never expects a tool
 // the request omits, and under lazy discovery it sees the `mcp` / `tool_catalog`
 // meta-tool rather than the individual schemas.
    const mcpCount = this.toolRegistry.all().filter((t) => t.source === "mcp").length;
    const lazyMcp = decideLazyMcp(
      mcpCount,
      this.config.mcpToolDiscovery,
      this.config.mcpLazyThreshold,
    );
    const pluginCount = this.toolRegistry.all().filter((t) => t.source === "plugin").length;
    const lazyPlugin = decideLazyMcp(
      pluginCount,
      this.config.pluginToolDiscovery ?? "eager",
      this.config.pluginLazyThreshold,
    );
    const toolNames = listAdvertisedToolNames(this.toolRegistry, this.mode, {
      lazyMcp,
      lazyPlugin,
      model: this.model,
      toolExposure: this.config.toolExposure,
    });
 // Sandbox posture is part of the prompt so the model knows its boundaries.
    const sb = this.sandbox;
    // Structured sandbox posture: a clear header line plus one writable root
    // per line, so the model can parse each allowed path unambiguously.
    // Lives in the cached static section — it's session-stable.
    const sandboxNote = (() => {
      const header = `Sandbox: mode=${sb.mode}, network=${sb.network ? "allowed" : "blocked"}.`;
      const roots =
        sb.mode !== "off" && sb.writableRoots.length > 0
          ? `\nWritable roots (OS sandbox — bash/write are refused outside these):\n` +
            sb.writableRoots.map((r) => `  - ${r}`).join("\n")
          : "";
      const warn = this._sandboxUnavailable
        ? `\nWARNING: no OS sandbox backend is available on this host; \`bash\` commands will be REFUSED. ${buildSandboxUnavailable().hint}`
        : "";
      return header + roots + warn;
    })();
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
      skills: this.discoveredSkills,
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
   * Query-time progressive recall: select the memory topic files most relevant
   * to `query` and return a `<relevant_memories>` block (truncated, capped) for
   * the volatile per-turn context, or null. Gated on auto-memory being on and
   * `memory.autoRecall` (default true). Skips topic files already read this
   * session (visible in the transcript). Fail-soft — never throws, never blocks.
   */
  private async recallRelevantMemories(query: string): Promise<string | null> {
    if (this.config.autoMemoryEnabled === false) return null;
    if (this.config.memory?.autoRecall === false) return null;
    if (!query || query.trim().length === 0) return null;
    try {
      const alreadyRead = new Set<string>();
      for (const e of this.events) {
        if (e.type === "tool_call" && (e as { name?: string }).name === "read_file") {
          const p = (e as { input?: { path?: string } }).input?.path;
          if (typeof p === "string") alreadyRead.add(p);
        }
      }
      return await recallRelevantMemories({
        provider: buildSmallProvider(this.config),
        smallModel: this.config.smallModel,
        cwd: this.cwd,
        query,
        recallMax: this.config.memory?.recallMax,
        alreadyRead,
        signal: this.cancelController?.signal,
      });
    } catch {
      return null;
    }
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
        if (
          e.type === "usage" &&
          !e.rollup &&
          typeof e.usage?.input === "number" &&
          e.usage.input > 0
        ) {
          this.lastProviderInputTokens = e.usage.input;
          this.contextAnchor = { input: e.usage.input, eventCount: i + 1 };
          break;
        }
      }
    }
    // Use the hybrid estimate so events appended after the last measurement
    // (e.g. a large tool_result produced this turn) count toward the trigger —
    // otherwise a single oversize result could blow the window before the next
    // measured response ever updates the anchor.
    const effective = this.effectiveContextTokens(this.lastProviderInputTokens);
    if (effective >= Math.floor(window * PROVIDER_INPUT_COMPACTION_RATIO)) {
      await this.maybeCompact({ force: true });
    }
  }

  /** Cheap content fingerprint of the live transcript. Pre-compaction results
   * are keyed by this so a cached summary is only reused when the exact
   * history it summarised is still current — a changed fingerprint discards
   * the cache and falls back to synchronous compaction. */
  private historyFingerprint(): string {
    return `${this.events.length}:${this.lastPersistedLinkId ?? ""}`;
  }

  /** Run `compact()` for the given trigger, reusing a valid turn-boundary
   * pre-computation when its fingerprint still matches the current history.
   * This is what turns the otherwise-blocking small-model summary into a
   * free, already-done step on the turn that crosses the hard trigger. */
  private async runCompaction(
    trigger: number,
    force: boolean,
    extraInstructions?: string,
    hasFocus?: boolean,
  ): Promise<CompactionResult> {
    const cached = this.precompact;
    this.precompact = null;
    // Reuse the pre-computed summary only when no per-invocation focus applies.
    // The pre-computation already folded in the project `## Compact Instructions`
    // and any PreCompact-hook additions (the auto path), so those match; but a
    // `/compact <focus…>` argument the cache couldn't know forces a fresh
    // summarise so the focus is honoured.
    if (cached && cached.fingerprint === this.historyFingerprint() && !hasFocus) {
      // The pre-computed summary was built from exactly this history — reuse
      // it verbatim (including droppedRange, so the archive write still runs),
      // skipping the small-model round-trip on the hot path.
      return cached.result;
    }
    return compact(this.events, {
      contextWindow: trigger,
      force,
      // Use the small provider for summarisation (best-effort).
      summariser: buildSmallProvider(this.config),
      summaryModel: this.config.smallModel,
      extraInstructions,
    } as CompactionOptions);
  }

  /** Load the project's `## Compact Instructions` section (CODEPILOT.md /
   * AGENTS.md / CLAUDE.md), session-cached and invalidated on memory change.
   * Returns undefined when absent. */
  private async loadCompactInstructions(): Promise<string | undefined> {
    if (this.compactInstructionsCache === undefined) {
      try {
        const walkToHome = this.config.memory?.walkToHome === true;
        this.compactInstructionsCache =
          (await readCompactInstructions(this.cwd, { walkToHome })) ?? null;
      } catch {
        this.compactInstructionsCache = null;
      }
    }
    return this.compactInstructionsCache ?? undefined;
  }

  /** Turn-boundary pre-compaction (best practice: compact at the natural pause
   * between turns, not mid-turn). After a turn ends with tokens over a soft
   * threshold — below the hard trigger, so `maybeCompact` did NOT fire — this
   * compacts in the background while the user reads the answer, and caches the
   * result keyed by the current history fingerprint. The next turn's
   * `maybeCompact` then reuses it for free instead of blocking on the small
   * model. Safe by construction: the turn has ended, so the history is frozen
   * when we compute the summary, and the fingerprint guard rejects it if the
   * next user message has already changed the transcript. */
  private async precomputeCompaction(): Promise<void> {
    if (this.config.autoCompact === false) return;
    // Honour the circuit breaker: when auto-compaction is tripped, do not spend
    // the small model on a background summary either.
    if (this.autoCompactDisabled) return;
    if (this.precompactInFlight || this.precompact) return;
    const modelWindow = lookupContextWindow(this.model);
    const window = this.config.contextWindow ?? modelWindow.contextWindow;
    // Shared geometry: `softTrigger` starts a bit below `hardTrigger` so we
    // pre-compact one turn early, based on `hardTrigger` (not the raw window) so
    // a small window with a large output reserve can't invert the band. Never
    // pre-compute once at or past the hard trigger — maybeCompact handles that
    // synchronously.
    const { hardTrigger, softTrigger } = compactionGeometry({
      window,
      thresholdFraction: this.config.compactionThreshold,
      maxTokens: this.config.maxTokens,
      maxOutputTokens: modelWindow.maxOutputTokens,
    });
    const tokens = estimateEventTokens(this.events, estimateTokens);
    if (tokens < softTrigger || tokens >= hardTrigger) return;
    // Don't pre-compact through a PreCompact hook that would block it anyway.
    // Pre-computation is the auto path: fold in the project `## Compact
    // Instructions` (no per-invocation focus here) so the cached summary matches
    // what the auto `runCompaction` would produce.
    const projectInstructions = await this.loadCompactInstructions();
    const pre = await this.hooks
      .runPreCompact("auto", projectInstructions)
      .catch(() => ({ action: "allow" as const, warnings: [] }));
    if (pre.action === "block") return;
    const extraInstructions = mergeCompactInstructions({
      project: projectInstructions,
      hook: (pre as { additionalInstructions?: string }).additionalInstructions,
    });
    this.precompactInFlight = true;
    const fingerprint = this.historyFingerprint();
    try {
      const result = await compact(this.events, {
        contextWindow: hardTrigger,
        force: true, // soft band is below the local gate; force the shrink
        summariser: buildSmallProvider(this.config),
        summaryModel: this.config.smallModel,
        extraInstructions,
      } as CompactionOptions);
      // Only keep it if the history hasn't moved under us while summarising.
      if (result.events !== this.events && this.historyFingerprint() === fingerprint) {
        this.precompact = { fingerprint, result };
      }
    } catch {
      /* best-effort: a failed pre-compaction just means the next turn blocks */
    } finally {
      this.precompactInFlight = false;
    }
  }

 /**
  * Background memory pipeline: extract durable notes from this session, then
  * consolidate drafts into project memory when the dual gate fires. Guarded so
  * at most one run is in flight; fully fail-soft (memory is an optimisation,
  * never a blocker). Skipped when auto memory is disabled.
  */
  private async runMemoryPipeline(): Promise<void> {
    if (this.config.autoMemoryEnabled === false) return;
    if (this.memoryPipelineInFlight) return;
    this.memoryPipelineInFlight = true;
    try {
      const cfg: MemoryConsolidationConfig = {
        enabled: true,
        minHoursBetweenConsolidation: this.config.memoryConsolidationMinHours,
        minDraftsForConsolidation: this.config.memoryConsolidationMinDrafts,
      };
      const deps = {
        cwd: this.cwd,
        provider: buildSmallProvider(this.config),
        model: this.config.smallModel,
        config: cfg,
        redactPatterns: this.redactPatterns,
      };
      await extractSessionMemory(this.events, deps).catch(() => 0);
      const consolidated = await maybeConsolidateMemory(deps).catch(() => false);
      // A consolidation rewrote MEMORY.md; mark the index stale so the next
      // turn rebuilds the system prompt with the updated memory.
      if (consolidated) {
        this.memoryIndexDirty = true;
        // A memory rewrite may add/change a `## Compact Instructions` section.
        this.compactInstructionsCache = undefined;
      }
    } catch {
      /* fail-soft: memory consolidation never blocks the session */
    } finally {
      this.memoryPipelineInFlight = false;
    }
  }

 /** Cancel any pending prompt-cache warm (next real turn supersedes it, or
  * the session is disposed). */
  private cancelCacheWarm(): void {
    if (this.cacheWarmTimer) {
      clearTimeout(this.cacheWarmTimer);
      this.cacheWarmTimer = null;
    }
    if (this.cacheWarmAbort) {
      this.cacheWarmAbort.abort();
      this.cacheWarmAbort = null;
    }
  }

 /**
  * Schedule a cost-gated prompt-cache warm for the turn's exact request. The
  * agent hands us the prefix size + a faithful 1-token replay closure; we
  * decide via `decideCacheWarm` whether the expected savings beat the warm's
  * own cost, and if so fire the replay at ~90% of the cache TTL. Fire-and-
  * forget and fully fail-soft — a failed warm just means the next turn may
  * miss the cache, exactly as today.
  */
  private scheduleCacheWarm(candidate: {
    prefixTokens: number;
    replay: (signal: AbortSignal) => Promise<void>;
  }): void {
    // A new candidate supersedes any pending one.
    this.cancelCacheWarm();
    if (this.config.cacheWarming !== true) return; // opt-in
    const decision = decideCacheWarm({
      model: this.model,
      ttlMs: cacheTtlMs(this.model, this.config.promptCache?.ttl),
      prefixTokens: candidate.prefixTokens,
      continuationProbability: this.cacheWarmContinuationProb,
      // A budget-derived thinking block changes with max_tokens; capping output
      // at 1 would write a different cache entry, so refuse to warm then.
      replayWouldDiffer:
        (this.config.thinkingBudget ?? 0) > 0 || this.config.reasoningEffort !== undefined,
    });
    if (!decision.warm) return;
    const abort = new AbortController();
    this.cacheWarmAbort = abort;
    this.cacheWarmTimer = setTimeout(() => {
      this.cacheWarmTimer = null;
      if (abort.signal.aborted || this.disposed) return;
      void candidate.replay(abort.signal).catch(() => undefined);
    }, decision.delayMs);
    // Don't keep the process alive just to warm a cache.
    this.cacheWarmTimer.unref?.();
  }

  private async maybeCompact(opts: { force?: boolean; focus?: string } = {}): Promise<void> {
 // Master toggle: when autoCompact is explicitly false, the session
 // never auto-compacts (the user must invoke /compact manually).
    if (this.config.autoCompact === false) return;
    const force = opts.force === true;
    // Circuit breaker: once auto-compaction has thrashed, stop auto attempts so
    // we don't burn API calls in a compact→still-full→compact loop. A manual
    // `/compact` (force) always runs and can clear the breaker.
    if (this.autoCompactDisabled && !force) return;
    const modelWindow = lookupContextWindow(this.model);
    const window = this.config.contextWindow ?? modelWindow.contextWindow;
 // Effective trigger point via the shared geometry (single source of truth
 // for every compaction coefficient). The compaction engine's `contextWindow`
 // option IS the trigger threshold (it compacts when tokens >= that value).
 // `hardTrigger` already reserves output tokens so we never wait until the
 // provider rejects the request.
    const trigger = compactionGeometry({
      window,
      thresholdFraction: this.config.compactionThreshold,
      maxTokens: this.config.maxTokens,
      maxOutputTokens: modelWindow.maxOutputTokens,
    }).hardTrigger;
    if (!force) {
      const decision = shouldCompact(this.events, { contextWindow: trigger });
      if (!decision.shouldCompact) return;
    }
    // Compact instructions: what the summary MUST preserve. Sourced from the
    // project memory's `## Compact Instructions` section, a per-invocation
    // `/compact <focus…>` argument, and (below) a PreCompact hook. The trigger
    // literal reflects whether this is a manual `/compact` (force) or the
    // threshold-driven auto path.
    const hookTrigger: "manual" | "auto" = force ? "manual" : "auto";
    const projectInstructions = await this.loadCompactInstructions();
    const fileAndFocus = mergeCompactInstructions({
      project: projectInstructions,
      focus: opts.focus,
    });
 // PreCompact hooks may block compaction (e.g. to preserve state during
 // a long-running task). They also receive the file+focus instructions and
 // may return their own `additionalInstructions` to fold in.
    const pre = await this.hooks.runPreCompact(hookTrigger, fileAndFocus).catch(() => ({
      action: "allow" as const,
      warnings: [],
    }));
    if (pre.action === "block") {
      process.stderr.write(
        `[session] compaction blocked by PreCompact hook: ${pre.reason ?? "(no reason)"}\n`
      );
      return;
    }
    const extraInstructions = mergeCompactInstructions({
      project: projectInstructions,
      focus: opts.focus,
      hook: (pre as { additionalInstructions?: string }).additionalInstructions,
    });
    let result: CompactionResult;
    try {
      result = await this.runCompaction(
        trigger,
        force,
        extraInstructions,
        !!(opts.focus && opts.focus.trim().length > 0),
      );
    } catch (err) {
      // A thrown compaction counts as a failure toward the breaker. Manual
      // compaction surfaces the error to the caller; auto swallows it (the run
      // continues, possibly oversize, and the breaker may trip).
      this.recordCompactionFailure(trigger, `error: ${(err as Error).message}`, force);
      if (force) throw err;
      return;
    }
    if (result.events === this.events) {
      // No change: compaction could not shrink anything. Treated as a failure
      // so a genuinely stuck transcript trips the breaker instead of looping.
      this.recordCompactionFailure(trigger, "no-change", force);
      return;
    }
    // The prompt prefix just changed, so the next turn's input re-bill is
    // expected content, not broken caching — flag it for cache-waste attribution.
    this.contextChangedForNextTurn = true;
    // Local estimate no longer reflects the last oversize API call.
    if (force) this.lastProviderInputTokens = 0;
    // The prompt prefix changed, so the measured anchor is stale: the next send
    // re-bills a different prompt. Drop it so the estimate rebuilds from the
    // post-compaction event log.
    this.contextAnchor = null;
    // compaction appends only what it synthesised (summary boundary + rescued
    // plan); the retained tail is already on disk and never re-appended. "New"
    // is decided by stable link id, not object reference, since `compact()`
    // rebuilds kept events ({...e}) — a reference check would duplicate the tail.
    const newEvents = this.newCompactionEvents(result.events);
    if (result.droppedRange) {
 // The original transcript stays on disk; some UIs
 // then tells the model where to re-read it. We do both: leave the
 // JSONL append-only, and write a Markdown archive the model can grep.
      const head = result.events[0];
      if (head?.type === "compaction") {
        // keepFrom points into the append-only file at the first retained turn:
        // the first event after the new prefix that is already persisted.
        const keepFrom = this.compactionKeepFrom(result.events);
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
        const withBoundary = { ...head, keepFrom, summary: `${head.summary}${pointer}` };
        result.events[0] = withBoundary;
        newEvents[0] = withBoundary;
      }
    }
    this.events = result.events;
 // Append ONLY the events compaction genuinely created (the summary, and a
 // rescued plan if compact synthesised one). Never re-append the retained
 // tail — those turns are already in the file and stay there for resume /
 // export / grep; `liveTranscript` rebuilds the model view from `keepFrom`.
    for (const e of newEvents) {
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
    await this.hooks.runPostCompact(hookTrigger, summary).catch(() => undefined);

    // Breaker evaluation on a successful compaction: if the live transcript is
    // still at/over the hard trigger, the compaction did not actually get us
    // under budget — real thrashing. Count it and trip the breaker at the
    // threshold. Otherwise the compaction worked: clear both streaks (and
    // re-enable auto when a manual /compact rescued the session).
    const after = estimateEventTokens(this.events, estimateTokens);
    if (after >= trigger) {
      this.compactNoopStreak++;
      const limit = this.config.autoCompactMaxConsecutiveFailures ?? DEFAULT_AUTOCOMPACT_MAX_FAILURES;
      if (this.compactNoopStreak >= limit) {
        this.tripAutoCompactBreaker(
          `thrashing: still over budget after compact (${after} ≥ ${trigger})`,
          { streak: this.compactNoopStreak, before: trigger, after },
        );
      }
    } else {
      this.compactFailStreak = 0;
      this.compactNoopStreak = 0;
      this.autoCompactDisabled = false;
    }
  }

  /** Record a failed auto/manual compaction and trip the breaker at the limit.
   * A failure is a throw, a no-change result, or (evaluated by the caller) a
   * success that left the transcript still over budget. */
  private recordCompactionFailure(trigger: number, reason: string, force: boolean): void {
    this.compactFailStreak++;
    const limit = this.config.autoCompactMaxConsecutiveFailures ?? DEFAULT_AUTOCOMPACT_MAX_FAILURES;
    if (!force && this.compactFailStreak >= limit) {
      this.tripAutoCompactBreaker(`compaction failing (${reason})`, {
        streak: this.compactFailStreak,
        before: trigger,
        after: trigger,
      });
    }
  }

  /** Disable auto-compaction for the rest of the session and surface why. A
   * manual `/compact` can still run and re-enable auto if it gets back under
   * budget. */
  private tripAutoCompactBreaker(
    reason: string,
    detail: { streak: number; before: number; after: number },
  ): void {
    if (this.autoCompactDisabled) return;
    this.autoCompactDisabled = true;
    // Drop any staged precompute so the breaker also halts background summary.
    this.precompact = null;
    this.notify({
      type: "error",
      message:
        `Auto-compaction disabled: ${reason}. Run /compact manually, trim the ` +
        `conversation, or raise the context budget. (streak ${detail.streak}, ` +
        `tokens ${detail.before}→${detail.after})`,
      recoverable: true,
    });
  }

  private async maybeCheckpoint(): Promise<void> {
    if (!this.checkpointHook) return;
    // Checkpoint trigger must sit strictly below the compaction hard trigger on
    // every config, else compaction fires first and snapshots already-summarised
    // history. Derive the threshold from `compactionGeometry` (clamped below
    // `hardTrigger`) so the ordering holds regardless of `outputReserve`.
    const modelWindow = lookupContextWindow(this.model);
    const window = this.config.contextWindow ?? modelWindow.contextWindow;
    const { hardTrigger } = compactionGeometry({
      window,
      thresholdFraction: this.config.compactionThreshold,
      maxTokens: this.config.maxTokens,
      maxOutputTokens: modelWindow.maxOutputTokens,
    });
    const configured = resolveCompactionThreshold(this.model, this.config.contextWindow);
    // Take the smaller of the configured 0.8-window threshold and a margin
    // below the compaction trigger, so a large output reserve can never invert
    // the order. The floor keeps a tiny/unknown window from going to zero.
    const threshold = Math.max(
      2_000,
      Math.min(configured, Math.floor(hardTrigger * CHECKPOINT_BELOW_COMPACTION_RATIO)),
    );
    const trigger = this.checkpointHook.check(this.events, {
      tokenThreshold: threshold,
      turnsThreshold: 6,
    });
    if (!trigger.shouldCheckpoint) return;
    // One background checkpoint at a time: the slow part is a small-model
    // round trip, and two concurrent writes would race on the same file. A
    // trigger that arrives while one is in flight is dropped; the next turn
    // re-evaluates and re-triggers if still warranted.
    if (this.pendingCheckpoint) return;

    // Build the snapshot NOW, on the hot path, so it captures the transcript
    // at this exact turn boundary (pre-compaction — see the threshold math
    // above). The snapshot is plain data, so the live `this.events` may keep
    // mutating while the background write runs without corrupting it.
    const snapshot = buildCheckpointSnapshot(this.events);
    // Advance the cursor immediately: the content is already captured, so the
    // next turn must treat this boundary as checkpointed even while the disk
    // write is still in flight. This prevents a re-trigger loop and keeps the
    // checkpoint≤compaction ordering (a later compaction cannot "un-take" it).
    this.checkpointHook.hasCheckpoint = true;
    this.checkpointHook.lastCheckpointAt = this.events.length;

    const summariser = buildSmallProvider(this.config);
    const summaryModel = this.config.smallModel;
    // Fire-and-forget the distillation + write. Tracked by `pendingCheckpoint`
    // so `dispose()` can await a clean shutdown; failures are fail-soft.
    this.pendingCheckpoint = (async () => {
      try {
        const result = await writeCheckpointFromSnapshot(this.cwd, this.id, snapshot, {
          tokenThreshold: threshold,
          turnsThreshold: 6,
          summariser,
          summaryModel,
        });
 // Adopt the checkpoint header as the session title when none is set —
 // the checkpoint now carries the canonical title.
        if (!this.title && result.bytes > 0) {
          const cp = await readCheckpoint(this.cwd, this.id);
          const m = cp?.match(/^#\s+Checkpoint for (.+)$/m);
          if (m && m[1] && m[1].length <= 60) {
            this.title = m[1];
          }
        }
      } catch (err) {
        process.stderr.write(
          `[session] checkpoint write failed: ${(err as Error).message}\n`
        );
      } finally {
        this.pendingCheckpoint = null;
      }
    })();
  }

  /** Start the loopback egress proxy when the sandbox network policy is
   * "proxy", and point `this.sandbox.proxyUrl` at it so wrapCommand injects
   * HTTP(S)_PROXY. Fail-soft: if the proxy can't start, log and leave the
   * policy without a proxyUrl (commands then run without proxy env — the
   * allowlist is simply not enforced, matching the cooperative best-effort
   * contract). */
  private async startNetProxyIfConfigured(): Promise<void> {
    const pol = this.sandbox.networkPolicy;
    if (pol.mode !== "proxy") return;
    try {
      const { startNetProxy } = await import("./netProxy.js");
      this.netProxy = await startNetProxy({
        allow: pol.allow,
        allowPorts: pol.allowPorts,
        denyLog: pol.denyLog,
      });
      // The OS sandbox can enforce egress through the proxy for two backends:
      // seatbelt scopes network-outbound to the proxy's loopback port, and
      // bwrap with slirp4netns confines the namespace's userspace net stack to
      // the gateway→proxy path. Either way a child cannot bypass by opening a
      // raw socket. Other cases (bwrap/wsl without slirp4netns) only get the
      // cooperative env vars — best-effort.
      const { detectSandboxBackend, slirp4netnsPath } = await import("./sandbox.js");
      const backend = detectSandboxBackend();
      const enforced =
        backend === "seatbelt" || (backend === "bwrap" && slirp4netnsPath() !== null);
      this.sandbox = {
        ...this.sandbox,
        proxyUrl: `http://127.0.0.1:${this.netProxy.port}`,
        proxyEnforcement: enforced ? "enforced" : "best-effort",
      };
    } catch (err) {
      process.stderr.write(
        `[session] network proxy failed to start: ${(err as Error).message}\n`,
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
    const title = sanitizeTitle(candidate ?? "") ?? sanitizeTitle(fallback) ?? fallback;
    if (title) await this.setTitle(title);
  }

  /**
   * Task boundary: archive the current working context and continue the SAME
   * session with a clean slate. Generic and task-agnostic — it does NOT guess
   * when a task ends; it runs only when the user (/clear) or the model
   * (start_new_task tool) explicitly asks for it.
   *
   * Mechanism (reuses the compaction + archive machinery):
   *  - Force a full handoff summary of everything so far, so nothing is lost:
   *    the full transcript stays on disk (JSONL + Markdown archive) and the
   *    summary points the model back to it.
   *  - Replace the live `events` with [summary, boundary] so the next turn
   *    starts from a short reference instead of the whole prior task's
   *    transcript. This is what actually stops cross-task context from leaking.
   *  - The boundary marker tells the model the summarised history is
   *    reference-only, not an active task to resume.
   *
   * Returns true when a boundary was drawn (there was live context to clear).
   */
  /** Public manual compaction (the `/compact` command). Forces a summary pass
   * now regardless of token pressure, keeping the session going on the same
   * task (unlike clearWorkingContext, which draws a task boundary). */
  async compact(focus?: string): Promise<void> {
    await this.maybeCompact({ force: true, focus });
  }

  /**
   * Anchor (or unanchor) a prior message against compaction. A pinned message
   * is kept verbatim through folds/trims — use it for a key requirement the
   * user wants preserved across a long session. Append-only safe: the flag is
   * applied to the in-memory event AND a `pin` control event is persisted so
   * the anchor survives a resume (last pin per message id wins on reload).
   * Returns false when no message with that id exists.
   */
  async pinMessage(messageId: string, pinned = true): Promise<boolean> {
    if (this.disposed) throw new Error("session disposed");
    let found = false;
    for (const e of this.events) {
      if (e.type === "message" && e.id === messageId) {
        e.pinned = pinned ? true : undefined;
        found = true;
      }
    }
    if (!found) return false;
    const ev: Event = { type: "pin", messageId, pinned };
    await this.persistEvent(ev).catch(() => undefined);
    this.notify(ev);
    return true;
  }

  /** Ids of currently pinned messages (anchored against compaction). */
  pinnedMessageIds(): string[] {
    const ids: string[] = [];
    for (const e of this.events) {
      if (e.type === "message" && e.pinned) ids.push(e.id);
    }
    return ids;
  }

  async clearWorkingContext(reason?: string): Promise<boolean> {
    const hasWork = this.events.some(
      (e) =>
        (e.type === "message" && e.role === "assistant") ||
        e.type === "tool_result",
    );
    if (!hasWork) return false;

    const modelWindow = lookupContextWindow(this.model);
    const window = this.config.contextWindow ?? modelWindow.contextWindow;
    const trigger = Math.max(4_000, Math.floor(window * FORCED_SHRINK_RATIO));
    const result = await this.runCompaction(trigger, true).catch(() => null);

    const summaryEvent =
      result?.events.find((e) => e.type === "compaction") ??
      this.events.find((e) => e.type === "compaction");
    const boundary: Event = {
      type: "message",
      id: `msg_${randomUUID()}`,
      role: "user",
      content: [
        {
          type: "text",
          text: TASK_BOUNDARY_MARKER + (reason ? `\n\nReason: ${reason}` : ""),
        },
      ],
    };
    const next: Event[] = summaryEvent ? [summaryEvent, boundary] : [boundary];

    this.events = next;
    this.lastProviderInputTokens = 0;
    this.contextAnchor = null;
    for (const e of next) {
      if (this.persisted.includes(e)) continue;
      await this.persistEvent(e).catch(() => undefined);
    }
    this.notify(boundary);
    await this.rebuildSystemPrompt().catch(() => undefined);
    await this.hooks.runSessionStart("clear").catch(() => undefined);
    return true;
  }
}

/** Generic, task-agnostic boundary marker injected by clearWorkingContext. */
const TASK_BOUNDARY_MARKER =
  "[task boundary] The conversation above this line was a previous, now-archived task. " +
  "Its summary is retained only as reference; the full transcript is on disk if you need it. " +
  "Do NOT resume, continue, or re-execute any plan, instruction, or tool call from before this " +
  "boundary unless the next message explicitly asks you to. Treat the next user message as the " +
  "start of a fresh task.";

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

/** Best-effort: write `autoAcceptModeSuggestions: true` to the user config so
 * the "Always switch" choice survives a restart (the session-memory flag alone
 * is lost on reload). Mirrors {@link persistSandboxWritablePath}. */
async function persistAutoAcceptModeSuggestions(): Promise<void> {
  const { raw } = await readUserConfigFile();
  if (raw.autoAcceptModeSuggestions === true) return;
  raw.autoAcceptModeSuggestions = true;
  await writeUserConfigFile(raw);
}

/** Sub-agent tool outputs are only for display; cap them so a fan-out that
 * reads big files doesn't balloon the parent's JSONL. */
const SUBAGENT_RESULT_CAP = 4_000;
/** Extract the `<skills>…</skills>` catalogue from a built system prompt, or
 * "" when absent. Used to split the skills catalogue out of the `system`
 * category in contextReport(). */
/**
 * True when an event carries at least one image stored as an artifact ref
 * (offloaded base64) that needs reading back. Lets `loadFromDisk` skip the
 * async rehydrate path — and its per-event microtask — for the vast majority
 * of events that have no images at all.
 */
function eventHasOffloadedImages(e: Event): boolean {
  const imgs = (e as { images?: Array<{ base64?: string; ref?: string }> }).images;
  if (!Array.isArray(imgs) || imgs.length === 0) return false;
  return imgs.some((img) => !img.base64 && !!img.ref);
}

function extractSkillsSection(fullPrompt: string): string {
  const start = fullPrompt.indexOf("<skills>");
  if (start < 0) return "";
  const end = fullPrompt.indexOf("</skills>", start);
  if (end < 0) return "";
  return fullPrompt.slice(start, end + "</skills>".length);
}

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
// Re-exports for `import { ... } from "./session.js"` callers. New code
// should import from "./session-utils.js" (or the barrel) directly.
// ---------------------------------------------------------------------------
export {
  SESSIONS_DIR,
  getSessionsDir,
  createSession,
  listSessions,
  searchSessions,
  exportSession,
  deleteSession,
  persistSessionCwd,
  loadSessionState,
  setSessionPinned,
  setSessionArchived,
  resetSessionIndex,
} from "./session-utils.js";
export type {
  RichSessionSummary,
  SessionExportFormat,
  SessionState,
} from "./session-utils.js";
