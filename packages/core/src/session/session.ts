// Session: thin facade over JSONL SoT, prompt turn, lifecycle, and event bus.
// Persists events as JSONL under ~/.codepilot/sessions/<id>.jsonl.
// Capability binders (owned by their folders; Session only composes them):
//   mcp/sessionBind, plugins/sessionBind, sandbox/sessionBind,
//   permissions/sessionBind, compaction/sessionBind, providers/sessionProviders.
// Session-local modules: session-lifecycle, session-persist, session-prompt,
// session-steer, session-history, session-builtins, session-runtime,
// session-config, session-fork, session-helpers, session-telemetry, session-utils.

import { appendFile, mkdir, readFile, writeFile, truncate } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { type AgentDeps } from "../agent/agent.js";
import {
  createPromptPermissionClassifier,
  type PermissionClassifier,
} from "../permissions/permissionClassifier.js";
import { INTERRUPTED_RESULT, NOT_STARTED_RESULT, decideLazyMcp, buildProviderMessages, buildProviderToolDefs, listAdvertisedToolNames } from "../agent/agent-messages.js";
import { runtimeRegistry, type AgentRuntime, type PluginToolDef } from "../agent/runtime.js";
import type { BoundedSinkQueue } from "./sessionSink.js";
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
} from "../types.js";
import { ToolRegistry, zodToJsonSchema, type ToolDef } from "../tools/types.js";
import { ArtifactStore } from "../tools/artifacts.js";
import { PermissionEngine } from "../permissions/permissions.js";
import { readMemory, readProjectInstructions, readCompactInstructions, summariseMemory } from "../memory/memory.js";
import { buildSystemPrompt } from "../systemPrompt/index.js";
import { formatClockNow } from "../config/env.js";
import { compact, liveTranscript, renderTranscriptArchive, shouldCompact, visibleHistory, type CompactionOptions, type CompactionResult } from "../compaction/compaction.js";
import { droppedFilePaths, renderRestoredFiles } from "../compaction/compactionRestore.js";
import { WorkspaceTracker } from "../workspace/workspaceTracker.js";

import {
  extractPlan,
  estimateEventTokens,
  compactionGeometry,
  mergeCompactInstructions,
  DEFAULT_COMPACTION_FRACTION,
  PROVIDER_INPUT_COMPACTION_RATIO,
  HARD_TRIM_RATIO,
  FORCED_SHRINK_RATIO,
} from "../compaction/compaction.js";
import { createSubagentRunner } from "../subagent/subagent.js";
import { discoverCustomAgents, renderCustomAgentsBlock, type CustomAgent } from "../skills/customAgents.js";
import { discoverSkills, type Skill } from "../skills/skills.js";
import { StaticSkillStore, type SkillToolHandle } from "../tools/skill.js";
import { LspManager } from "../workspace/lsp.js";
import { createPostWrite, type PostWrite } from "../workspace/postWrite.js";
import { loadAutoMemoryPromptStub, type AutoMemoryConfig } from "../memory/autoMemory.js";
import { recallRelevantMemoriesDetailed } from "../memory/memoryRecall.js";
import {
  extractSessionMemory,
  maybeConsolidateMemory,
  type MemoryConsolidationConfig,
} from "../memory/memoryConsolidation.js";
import { AuditLogger } from "../telemetry/audit.js";
import { compileRedactionPatterns } from "../permissions/redact.js";
import { PersistentShell } from "../sandbox/persistentShell.js";
import {
  extractDeliveryRootsFromText,
  mergeDeliveryRoots,
  normalizeRoot,
} from "../workspace/deliveryRoots.js";
import type { McpManager } from "../mcp/mcp.js";
import { acquireSessionLock, type SessionLease } from "./sessionLock.js";
import { startMcp as startMcpImpl, resolveSessionMcpReferences, formatInboundNotification } from "../mcp/sessionBind.js";
import type { McpServerRequestHandler } from "../mcp/mcp-types.js";
import { startPromptSpan, endPromptSpan, type PromptSpan } from "./session-telemetry.js";
import { getTracer } from "../telemetry/telemetry.js";
import { CORE_VERSION, linkIdForEvent, readGitBranch, stampEventMeta } from "../telemetry/eventMeta.js";
import {
  type ResolvedCodepilotConfig,
} from "../config/config.js";
import {
  findProviderIdForFlat,
  resolveDefaultModel,
} from "../config/providerCatalog.js";
import {
  filterToolsByModeFromRegistry,
  filterToolsByModel,
  BackgroundSubagentRegistry,
  type BackgroundSubagentMeta,
} from "../tools/index.js";
import { registerSessionBuiltins, type BuiltinHost } from "./session-builtins.js";
import {
  type HistoryHost,
  type UndoEntry,
  openWorkspaceTracker,
  persistUndoBoundary,
  rewindConversation as rewindConversationImpl,
  rewindTargets as rewindTargetsImpl,
  sessionListSnapshots,
  sessionRedo,
  sessionRewind,
  sessionSnapshot,
  sessionUndo,
} from "./session-history.js";
import {
  type SteerHost,
  type SteeringItem,
  steer as steerMessage,
  listFollowUps as listFollowUpsImpl,
  enqueueFollowUp as enqueueFollowUpImpl,
  removeFollowUp as removeFollowUpImpl,
  updateFollowUp as updateFollowUpImpl,
  sendFollowUpNow as sendFollowUpNowImpl,
  clearFollowUps as clearFollowUpsImpl,
  drainFollowUps as drainFollowUpsImpl,
  steerSystem as steerSystemImpl,
} from "./session-steer.js";
import { saveSessionInbox } from "./session-inbox.js";
import {
  type PluginHost,
  setPluginContextTransform as setPluginContextTransformImpl,
  registerPluginEventSink as registerPluginEventSinkImpl,
  registerPluginTool as registerPluginToolImpl,
} from "../plugins/sessionBind.js";
import {
  type ForkHost,
  forkSession as forkSessionImpl,
  getSessionSummary as getSessionSummaryImpl,
  getRichSessionSummary as getRichSessionSummaryImpl,
} from "./session-fork.js";
import {
  type RuntimeHost,
  startPersistentShell as startPersistentShellImpl,
  lspDiagnosticsTimeoutMs as lspDiagnosticsTimeoutMsImpl,
  diagnosticsProviderChain as diagnosticsProviderChainImpl,
  livePersistentShellHandle as livePersistentShellHandleImpl,
  deliverBackgroundCompletion as deliverBackgroundCompletionImpl,
  onPermissionRequestWithBatch as onPermissionRequestWithBatchImpl,
  wireHookResolvers as wireHookResolversImpl,
} from "./session-runtime.js";
import {
  type CompactHost,
  effectiveContextTokens as effectiveContextTokensImpl,
  contextReport as contextReportImpl,
  preciseContextCount as preciseContextCountImpl,
  sessionCompact,
  pinMessage as pinMessageImpl,
  pinnedMessageIds as pinnedMessageIdsImpl,
  clearWorkingContext as clearWorkingContextImpl,
  sessionMaybeCompact as sessionMaybeCompactImpl,
  sessionMaybePruneToolResults as sessionMaybePruneToolResultsImpl,
} from "../compaction/sessionBind.js";
import {
  type PersistHost,
  sessionLoadFromDisk as sessionLoadFromDiskImpl,
  sessionPersistEvent as sessionPersistEventImpl,
  sessionRebuildSystemPrompt as sessionRebuildSystemPromptImpl,
} from "./session-persist.js";
import {
  type SandboxHost,
  type SandboxStatus,
  getSandbox as getSandboxImpl,
  addDeliveryRoot as addDeliveryRootImpl,
  getDeliveryRoots as getDeliveryRootsImpl,
  grantSandboxForMentionedRoots as grantSandboxForMentionedRootsImpl,
  expandWritablePath as expandWritablePathImpl,
  setSandboxMode as setSandboxModeImpl,
  getSandboxStatus as getSandboxStatusImpl,
} from "../sandbox/sessionBind.js";
import {
  setPermissionMode as setPermissionModeImpl,
  getPermissionMode as getPermissionModeImpl,
  setPreset as setPresetImpl,
  getPermissionRules as getPermissionRulesImpl,
  isIgnoringPersistedAllows as isIgnoringPersistedAllowsImpl,
  listSavedPermissionRules as listSavedPermissionRulesImpl,
  addSavedPermissionRule as addSavedPermissionRuleImpl,
  removeSavedPermissionRule as removeSavedPermissionRuleImpl,
} from "../permissions/sessionBind.js";
import {
  type ConfigHost,
  applyHighRiskModelGate as applyHighRiskModelGateImpl,
  setAgentMode as setAgentModeImpl,
  getAgentMode as getAgentModeImpl,
  getOutputStyle as getOutputStyleImpl,
  getModel as getModelImpl,
  getProviderId as getProviderIdImpl,
  getConfig as getConfigImpl,
  getSystemPrompt as getSystemPromptImpl,
  mergeProviders as mergeProvidersImpl,
  setModel as setModelImpl,
  setReasoningEffort as setReasoningEffortImpl,
  getReasoningEffort as getReasoningEffortImpl,
  setProvider as setProviderImpl,
  setEndpoint as setEndpointImpl,
  setTurnOverrides as setTurnOverridesImpl,
  clearTurnOverrides as clearTurnOverridesImpl,
  getTurnOverrides as getTurnOverridesImpl,
  getToolNames as getToolNamesImpl,
  filterToolRegistry as filterToolRegistryImpl,
  setOutputStyle as setOutputStyleImpl,
  getHostSurface as getHostSurfaceImpl,
  setHostSurface as setHostSurfaceImpl,
} from "./session-config.js";
import {
  type PromptHost,
  sessionCanResumeLastTurn as sessionCanResumeLastTurnImpl,
  sessionPrompt as sessionPromptImpl,
  sessionResumeLastTurn as sessionResumeLastTurnImpl,
} from "./session-prompt.js";
import {
  type LifecycleHost,
  sessionInit as sessionInitImpl,
  sessionDispose as sessionDisposeImpl,
} from "./session-lifecycle.js";
import { onJobCompletion, readJobLog } from "../tools/bashJobs.js";
import type { OutputStyle } from "../systemPrompt/index.js";
import {
  resolveSandbox,
  detectSandboxBackend,
  buildSandboxUnavailable,
  formatSandboxPromptNote,
  assertPathAllowedAsync,
  type ResolvedSandbox,
} from "../sandbox/sandbox.js";
import { DedupCache } from "../agent/doomLoop.js";
import { FileObservationStore } from "../workspace/fsObservation.js";
import { resolveImageMentions } from "../workspace/imageMentions.js";
import { materializeUploads } from "../workspace/promptFiles.js";
import { ensureProjectState, projectStatePath, scratchDir } from "../workspace/projectState.js";
import { HookEngine } from "../hooks/hooks.js";
import {
  buildStopTranscriptHint,
  effectiveStopVerifyMode,
  resolveStopVerifyForceContinue,
  runBuiltinStopVerify,
  STOP_VERIFY_ADVICE_PREFIX,
} from "../agent/stopVerify.js";
import { estimateTokens, estimateCostUSD, lookupContextWindow, resolveCompactionThreshold } from "../compaction/tokens.js";
import { analyzeCacheWaste, type CacheTurn, type CacheWasteReport } from "../compaction/cacheStats.js";
import { decideCacheWarm, cacheTtlMs } from "../compaction/cacheWarmer.js";
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
  createSnapshotFromContents,
  readFileOrNull,
} from "./snapshots.js";
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { thawSession, readColdSessionText } from "./sessionCompression.js";
import {
  SESSIONS_DIR,
  buildProvider,
  buildSmallProvider,
  callTitleModel,
  deriveTitleFromText,
  isWeakTitleSource,
  persistSessionCwd,
  sanitizeTitle,
  historyArchivePath,
  titleSidecarPath,
  type RichSessionSummary,
} from "./session-utils.js";
import {
  CHECKPOINT_BELOW_COMPACTION_RATIO,
  DEFAULT_AUTOCOMPACT_MAX_FAILURES,
  DEFAULT_STOP_HOOK_BLOCK_CAP,
  DEFAULT_STOP_VERIFY_FORCE_CAP,
  NON_MUTATING_TOOLS,
  TASK_BOUNDARY_MARKER,
  eventHasOffloadedImages,
  extractSkillsSection,
  persistAutoAcceptModeSuggestions,
  slimSubagentEvent,
} from "./session-helpers.js";

export type { SandboxStatus } from "../sandbox/sessionBind.js";

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
  private readonly redactPatterns: readonly import("../permissions/redact.js").RedactionPattern[];
 /** Provider override (from Agent SDK / replay mode). When set, skips buildProvider. */
  private readonly providerOverride?: import("../providers/types.js").ChatProvider;
 /** Files the agent has written/edited this session, for snapshot rewind. */
  private touchedFiles: Set<string> = new Set();
  /** Pre-images (absolute path → bytes, null = did not exist) of every file a
   * file tool is about to change this turn, captured just before the first
   * such write; becomes the turn's undo baseline snapshot. */
  private turnPreImages = new Map<string, Buffer | null>();
  /** Paths each pending file-tool call will write, keyed by tool-call id. */
  private pendingWritePaths = new Map<string, string[]>();
  /** Shadow-git workspace tree taken just before the turn's first tool that may
   * change files (null when the turn has run none yet). */
  private turnBaseTree: string | null = null;
  /** The current turn still owes its base tree capture. */
  private turnTreePending = false;
  /** Whole-workspace tracker; undefined until first opened, null when unavailable. */
  private workspaceTracker: WorkspaceTracker | null | undefined;
  /** Undo stack: baseline (pre-turn) + after (post-turn) snapshot ids. */
  private undoStack: Array<UndoEntry> = [];
  private redoStack: Array<UndoEntry> = [];
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
/**
 * Mid-run steering messages drained each turn. `user` items enter the
 * transcript; `system` notices inject into runtime_context. `delivery`:
 * `"steer"` = this turn, `"followup"` = next top-level turn.
 */
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
  /** Cumulative chars attached via progressive recall this session (session byte gate). */
  private recallSessionChars = 0;
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
  /**
   * Tool names already placed on the provider wire this session. In-memory
   * only (empty on new/resume). Growth is monotonic so mode/lazy flips never
   * shrink the tools prefix mid-session; execute-time mode deny still applies.
   */
  private advertisedToolNames: Set<string> = new Set();
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
  /**
   * In-flight background checkpoint write, if any. Snapshot is built on the hot
   * path; the slow distillation + disk write runs here so a completed turn is
   * not blocked. At most one at a time; `dispose()` awaits it on shutdown.
   */
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
  /**
   * Measured context anchor: provider's last prompt size + event-log length.
   * `contextReport` reads `anchor.input` as ground truth, heuristically adding
   * events appended after it. Cleared on model switch / compaction boundary.
   */
  private contextAnchor: { input: number; eventCount: number } | null = null;
  /** Frozen folded tool_result stubs (toolCallId → stub) for prompt-cache. */
  private foldedToolResultStubs = new Map<string, string>();
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
/**
 * Turn-boundary pre-compaction cache. After a turn over a soft threshold a
 * background compaction runs and is stashed here keyed by a history
 * fingerprint. The next turn reuses it iff unchanged; stale → synchronous.
 */
  private precompact: { fingerprint: string; result: CompactionResult } | null = null;
 /** Guards against two overlapping background pre-compactions. */
  private precompactInFlight = false;
/**
 * Auto-compaction circuit breaker. `compactFailStreak`/`compactNoopStreak`
 * count failures and "still full" results; reaching
 * `autoCompactMaxConsecutiveFailures` disables auto-compaction. Manual
 * `/compact` back under budget clears it.
 */
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
  private readonly postWrite: PostWrite;
 /** Loopback egress proxy backing a "proxy" network policy. Started in
  * init() when configured; stopped on dispose. */
  private netProxy: import("../workspace/netProxy.js").RunningNetProxy | null = null;
 /** The host surface this session is running in: "cli" | "tui" | "vscode" | "idea".
 * Set by the host (TUI/IDE) so the prompt can tailor advice. Defaults to "cli". */
  private hostSurface: "cli" | "tui" | "vscode" | "idea" = "cli";
  /** The persistent shell shared across foreground bash calls. Lazily started. */
  private persistentShell: PersistentShell | null = null;
  /**
   * Where intentional project deliverables land for this task. Starts as
   * `[cwd]`; extended from path tokens in prompts and mid-turn approval of
   * out-of-cwd writes. Distinct from sandbox writable roots.
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
  private pluginContextTransform: ((view: import("../providers/types.js").ProviderMessage[]) => import("../providers/types.js").ProviderMessage[]) | undefined;
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
    this.postWrite = createPostWrite({
      formatters: opts.config.formatter,
      ...(opts.config.lsp?.diagnostics === false
        ? {}
        : {
            diagnostics: async (path, cwd) =>
              (await this.lspManager?.diagnostics(cwd, path, lspDiagnosticsTimeoutMsImpl(this as unknown as RuntimeHost))) ?? null,
          }),
    });
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
      memory: this.config.memory,
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
    applyHighRiskModelGateImpl(this as unknown as ConfigHost);
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
    return sessionInitImpl(this as unknown as LifecycleHost);
  }

  async resumeLastTurn(): Promise<"started" | "queued" | "noop"> {
    return sessionResumeLastTurnImpl(this as unknown as PromptHost);
  }

  canResumeLastTurn(): boolean {
    return sessionCanResumeLastTurnImpl(this as unknown as PromptHost);
  }

  async prompt(
    text: string,
    images?: ImageAttachment[],
    files?: PromptFile[],
    opts?: { resume?: boolean },
  ): Promise<"started" | "queued"> {
    return sessionPromptImpl(this as unknown as PromptHost, text, images, files, opts);
  }

  async setAgentMode(mode: AgentMode): Promise<void> {
    return setAgentModeImpl(this as unknown as ConfigHost, mode);
  }

  getAgentMode(): AgentMode {
    return getAgentModeImpl(this as unknown as ConfigHost);
  }

  getOutputStyle(): OutputStyle {
    return getOutputStyleImpl(this as unknown as ConfigHost);
  }

  getModel(): string {
    return getModelImpl(this as unknown as ConfigHost);
  }

  getProviderId(): string | undefined {
    return getProviderIdImpl(this as unknown as ConfigHost);
  }

  getConfig(): CodepilotConfig {
    return getConfigImpl(this as unknown as ConfigHost);
  }

  getSystemPrompt(): { staticPrefix: string; dynamicSuffix: string; full: string } | null {
    return getSystemPromptImpl(this as unknown as ConfigHost);
  }

  mergeProviders(providers: Record<string, import("../config/config.js").ProviderPreset>): void {
    mergeProvidersImpl(this as unknown as ConfigHost, providers);
  }

  async setModel(model: string, providerId?: string): Promise<void> {
    return setModelImpl(this as unknown as ConfigHost, model, providerId);
  }

  setReasoningEffort(effort: "low" | "medium" | "high" | undefined): void {
    setReasoningEffortImpl(this as unknown as ConfigHost, effort);
  }

  getReasoningEffort(): "low" | "medium" | "high" | undefined {
    return getReasoningEffortImpl(this as unknown as ConfigHost);
  }

  async setProvider(providerId: string, model?: string): Promise<void> {
    return setProviderImpl(this as unknown as ConfigHost, providerId, model);
  }

  async setEndpoint(opts: { model: string; providerId?: string }): Promise<void> {
    return setEndpointImpl(this as unknown as ConfigHost, opts);
  }

  setTurnOverrides(opts: { model?: string; allowedTools?: string[] } = {}): void {
    setTurnOverridesImpl(this as unknown as ConfigHost, opts);
  }

  clearTurnOverrides(): void {
    clearTurnOverridesImpl(this as unknown as ConfigHost);
  }

  getTurnOverrides(): { model: string | null; allowedTools: string[] | null } {
    return getTurnOverridesImpl(this as unknown as ConfigHost);
  }

  getToolNames(): string[] {
    return getToolNamesImpl(this as unknown as ConfigHost);
  }

  filterToolRegistry(allowedTools: string[]): void {
    filterToolRegistryImpl(this as unknown as ConfigHost, allowedTools);
  }

  async setOutputStyle(style: OutputStyle): Promise<void> {
    return setOutputStyleImpl(this as unknown as ConfigHost, style);
  }

  getHostSurface(): "cli" | "tui" | "vscode" | "idea" {
    return getHostSurfaceImpl(this as unknown as ConfigHost);
  }

  async setHostSurface(surface: "cli" | "tui" | "vscode" | "idea"): Promise<void> {
    return setHostSurfaceImpl(this as unknown as ConfigHost, surface);
  }

 // ---- Context visualization (/context) ----

  private effectiveContextTokens(fallback: number): number {
    return effectiveContextTokensImpl(this as unknown as CompactHost, fallback);
  }

  contextReport(): ReturnType<typeof contextReportImpl> {
    return contextReportImpl(this as unknown as CompactHost);
  }

  async preciseContextCount(): Promise<{ inputTokens: number } | null> {
    return preciseContextCountImpl(this as unknown as CompactHost);
  }

 // ---- Snapshot rewind ----

 /**
 * Snapshot the current on-disk state of every file the agent has touched
 * this session. Returns a snapshot id that can be passed to `rewind`.
 * Call this at a "known-good" boundary (e.g. after tests pass) so the
 * user can later undo a broken sequence of edits.
 */
  async snapshot(label: string): Promise<string> {
    return sessionSnapshot(this as unknown as HistoryHost, label);
  }

 /** Rewind every touched file to its state at snapshot `id`. */
  async rewind(id: string): Promise<{ restored: string[]; deleted: string[] }> {
    return sessionRewind(this as unknown as HistoryHost, id);
  }

 /** List available snapshots (oldest first). */
  async listSnapshots(): Promise<
    { id: string; label: string; createdAt: string; fileCount: number }[]
  > {
    return sessionListSnapshots(this as unknown as HistoryHost);
  }

  async undo(): Promise<{ restored: string[]; deleted: string[]; label: string }> {
    return sessionUndo(this as unknown as HistoryHost);
  }

  rewindTargets(): Array<{ messageId: string; text: string; ts?: number }> {
    return rewindTargetsImpl(this as unknown as HistoryHost);
  }

  async rewindConversation(
    toMessageId?: string,
    opts: { files?: boolean } = {},
  ): Promise<{ messageId: string; text: string; turns: number; restored: string[]; deleted: string[] }> {
    return rewindConversationImpl(this as unknown as HistoryHost, toMessageId, opts);
  }

  async redo(): Promise<{ restored: string[]; deleted: string[]; label: string }> {
    return sessionRedo(this as unknown as HistoryHost);
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
    try {
      this.runtime = runtimeRegistry.resolve(this.runtimeName, {
        cwd: this.cwd,
        registerTool: (def) => this.registerPluginTool(def),
        setContextTransform: (transform) => this.setPluginContextTransform(transform),
        registerEventSink: (sink) => this.registerPluginEventSink(sink),
      });
    } catch (err) {
      // resolve() already falls back for create() failures; an unknown name
      // still throws — pin the session to the default loop so later prompts
      // do not keep failing on the same bad runtimeName.
      if (this.runtimeName && this.runtimeName !== "default") {
        this.runtimeName = undefined;
        this.runtime = runtimeRegistry.resolve(undefined, {
          cwd: this.cwd,
          registerTool: (def) => this.registerPluginTool(def),
          setContextTransform: (transform) => this.setPluginContextTransform(transform),
          registerEventSink: (sink) => this.registerPluginEventSink(sink),
        });
      } else {
        throw err;
      }
    }
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
    transform: (view: import("../providers/types.js").ProviderMessage[]) => import("../providers/types.js").ProviderMessage[],
  ): void {
    setPluginContextTransformImpl(this as unknown as PluginHost, transform);
  }

  private registerPluginEventSink(
    sink: import("./sessionSink.js").SessionEventSink,
  ): void {
    registerPluginEventSinkImpl(this as unknown as PluginHost, sink);
  }

  private registerPluginTool(def: PluginToolDef): void {
    registerPluginToolImpl(this as unknown as PluginHost, def);
  }

 /** The configured runtime name (for `/runtime`-style introspection). */
  getRuntimeName(): string {
    return this.runtimeName ?? "default";
  }

  steer(text: string): void {
    steerMessage(this as unknown as SteerHost, text);
  }

  /** Write pending steers/follow-ups to the inbox sidecar (best-effort). */
  persistInbox(): void {
    void saveSessionInbox(this.id, {
      steering: this.steeringQueue,
      followUps: this.followUpQueue,
    }).catch(() => undefined);
  }

  listFollowUps(): FollowUpItem[] {
    return listFollowUpsImpl(this as unknown as SteerHost);
  }

  enqueueFollowUp(opts: {
    text: string;
    images?: ImageAttachment[];
    files?: PromptFile[];
  }): FollowUpItem {
    return enqueueFollowUpImpl(this as unknown as SteerHost, opts);
  }

  removeFollowUp(id: string): boolean {
    return removeFollowUpImpl(this as unknown as SteerHost, id);
  }

  updateFollowUp(id: string, text: string): boolean {
    return updateFollowUpImpl(this as unknown as SteerHost, id, text);
  }

  sendFollowUpNow(id: string): "steered" | "started" | false {
    return sendFollowUpNowImpl(this as unknown as SteerHost, id);
  }

  clearFollowUps(): void {
    clearFollowUpsImpl(this as unknown as SteerHost);
  }

  private async drainFollowUps(): Promise<void> {
    return drainFollowUpsImpl(this as unknown as SteerHost);
  }

  private steerSystem(text: string): void {
    steerSystemImpl(this as unknown as SteerHost, text);
  }

 /** The long-lived shell for foreground bash, started inside the sandbox.
 * Null when the policy can't be enforced: bash then runs each command
 * one-shot, where the sandbox fallback (deny / warn) applies. */
  private startPersistentShell(): PersistentShell | null {
    return startPersistentShellImpl(this as unknown as RuntimeHost);
  }

  private lspDiagnosticsTimeoutMs(): number {
    return lspDiagnosticsTimeoutMsImpl(this as unknown as RuntimeHost);
  }

  private diagnosticsProviderChain(): AgentDeps["diagnosticsProvider"] {
    return diagnosticsProviderChainImpl(this as unknown as RuntimeHost);
  }

  private livePersistentShellHandle(): AgentDeps["persistentShell"] {
    return livePersistentShellHandleImpl(this as unknown as RuntimeHost);
  }

  getSandbox(): ResolvedSandbox {
    return getSandboxImpl(this as unknown as SandboxHost);
  }

  addDeliveryRoot(dir: string): void {
    addDeliveryRootImpl(this as unknown as SandboxHost, dir);
  }

  getDeliveryRoots(): string[] {
    return getDeliveryRootsImpl(this as unknown as SandboxHost);
  }

  private async grantSandboxForMentionedRoots(dirs: string[]): Promise<void> {
    return grantSandboxForMentionedRootsImpl(this as unknown as SandboxHost, dirs);
  }

  async expandWritablePath(dir: string, opts: { persist?: boolean } = {}): Promise<string> {
    return expandWritablePathImpl(this as unknown as SandboxHost, dir, opts);
  }

  setSandboxMode(mode: ResolvedSandbox["mode"]): SandboxStatus {
    return setSandboxModeImpl(this as unknown as SandboxHost, mode);
  }

  getSandboxStatus(): SandboxStatus {
    return getSandboxStatusImpl(this as unknown as SandboxHost);
  }

  setPermissionMode(mode: PermissionMode): PermissionMode {
    return setPermissionModeImpl(this as unknown as SandboxHost, mode);
  }

  getPermissionMode(): PermissionMode {
    return getPermissionModeImpl(this as unknown as SandboxHost);
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
  setPreset(name: PermissionPresetName): ReturnType<typeof setPresetImpl> {
    return setPresetImpl(this as unknown as SandboxHost, name);
  }

  getPermissionRules(): ReturnType<typeof getPermissionRulesImpl> {
    return getPermissionRulesImpl(this as unknown as SandboxHost);
  }

  isIgnoringPersistedAllows(): boolean {
    return isIgnoringPersistedAllowsImpl(this as unknown as SandboxHost);
  }

  async listSavedPermissionRules(scope: "repo" | "user" = "repo") {
    return listSavedPermissionRulesImpl(this as unknown as SandboxHost, scope);
  }

  async addSavedPermissionRule(
    rule: string,
    effect: "allow" | "ask" | "deny",
    scope: "repo" | "user" = "repo",
  ): Promise<string> {
    return addSavedPermissionRuleImpl(this as unknown as SandboxHost, rule, effect, scope);
  }

  async removeSavedPermissionRule(
    rule: string,
    effect: "allow" | "ask" | "deny",
    scope: "repo" | "user" = "repo",
  ): Promise<boolean> {
    return removeSavedPermissionRuleImpl(this as unknown as SandboxHost, rule, effect, scope);
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
  getMcpManager(): import("../mcp/mcp.js").McpManager | null {
    return this.mcp;
  }

 /** The hook engine. For `/hooks`. */
  getHookEngine(): import("../hooks/hooks.js").HookEngine {
    return this.hooks;
  }

 /** Working directory (for agent/skill discovery). */
  getCwd(): string {
    return this.cwd;
  }

 /** Status-line configuration (declarative preset or custom script). */
  getStatusLineConfig(): import("../types.js").StatusLineConfig | undefined {
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
    for (const e of visibleHistory(this.persisted)) {
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
    return visibleHistory(this.persisted);
  }

 /** Returns a short summary of this session for list/search use. */
  async getSummary(): Promise<SessionSummary> {
    return getSessionSummaryImpl(this as unknown as ForkHost);
  }

 /** Returns an enriched summary including mode/model/messageCount. The
 * base SessionSummary is kept tight for back-compat; callers that want
 * the rich fields use this method. */
  async getRichSummary(): Promise<RichSessionSummary> {
    return getRichSessionSummaryImpl(this as unknown as ForkHost);
  }

  async fork(
    atEventIndex?: number,
    opts?: { fullHistory?: boolean },
  ): Promise<Session> {
    return forkSessionImpl(this as unknown as ForkHost, atEventIndex, opts);
  }

  private async seedForkChild(child: Session, slice: Event[]): Promise<void> {
    child.deliveryRoots = [...this.deliveryRoots];
    for (const e of slice) {
      child.events.push(e);
      await child.persistEvent(e);
    }
    await child.rebuildSystemPrompt();
    if (this.title) {
      await child.setTitle(this.title);
    }
  }

  async dispose(): Promise<void> {
    return sessionDisposeImpl(this as unknown as LifecycleHost);
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

  /**
   * Deliver a background sub-agent's one-time completion summary to the parent.
   * Rides the same out-of-band system-steer channel as other background-job
   * notices (bash jobs, MCP notifications): it lands in the current turn when
   * busy, or is picked up at the start of the next turn when idle. This is a
   * single notice, not a chat channel — to iterate with the sub-agent the model
   * re-dispatches with `continue_session_id`.
   */
  private deliverBackgroundCompletion(meta: BackgroundSubagentMeta): void {
    deliverBackgroundCompletionImpl(this as unknown as RuntimeHost, meta);
  }

  private onPermissionRequestWithBatch(
    req: PermissionRequest,
  ): Promise<PermissionResolution> {
    return onPermissionRequestWithBatchImpl(this as unknown as RuntimeHost, req);
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
    wireHookResolversImpl(this as unknown as RuntimeHost, subagentRunner);
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
    const undo: Array<UndoEntry> = [];
    const redo: Array<UndoEntry> = [];
    for (const e of this.persisted) {
      if (e.type !== "undo_boundary") continue;
      const entry: UndoEntry = {
        baselineId: e.baselineId,
        afterId: e.afterId,
        label: e.label,
        ...(e.baseTree && e.afterTree ? { baseTree: e.baseTree, afterTree: e.afterTree } : {}),
      };
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
    return sessionLoadFromDiskImpl(this as unknown as PersistHost);
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
    return sessionPersistEventImpl(this as unknown as PersistHost, e);
  }

  /**
   * Stamp `<runtime>now:</runtime>` to the current second. Called at the start
   * of each user `prompt()` so restart/log correlation has a fresh wall clock,
   * without rebuilding the whole prompt (and without changing mid-tool-loop).
   */
  private refreshRuntimeClock(now: string = formatClockNow()): void {
    const cache = this.systemPromptCache;
    if (!cache?.volatileSuffix) return;
    if (!/(^|\n)now: /.test(cache.volatileSuffix)) return;
    const stamp = (text: string): string =>
      text.replace(/(^|\n)now: [^\n]*/g, `$1now: ${now}`);
    const volatileSuffix = stamp(cache.volatileSuffix);
    if (volatileSuffix === cache.volatileSuffix) return;
    this.systemPromptCache = {
      ...cache,
      volatileSuffix,
      full: stamp(cache.full),
    };
  }

  private async rebuildSystemPrompt(
    opts?: { scope?: "full" | "volatile" },
  ): Promise<void> {
    return sessionRebuildSystemPromptImpl(this as unknown as PersistHost, opts);
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
      const result = await recallRelevantMemoriesDetailed({
        provider: buildSmallProvider(this.config),
        smallModel: this.config.smallModel,
        cwd: this.cwd,
        query,
        recallMax: this.config.memory?.recallMax,
        alreadyRead,
        sessionBytesUsed: this.recallSessionChars,
        signal: this.cancelController?.signal,
      });
      if (!result) return null;
      this.recallSessionChars += result.attachedChars;
      return result.block;
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
    const effective = effectiveContextTokensImpl(
      this as unknown as CompactHost,
      this.lastProviderInputTokens,
    );
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
      // Do not auto-extract every turn (default off). Existing drafts can
      // still consolidate when the dual gate fires.
      if (this.config.memory?.autoExtract === true) {
        await extractSessionMemory(this.events, deps).catch(() => 0);
      }
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

  private async maybePruneToolResults(): Promise<boolean> {
    return sessionMaybePruneToolResultsImpl(this as unknown as CompactHost);
  }

  private async maybeCompact(opts: { force?: boolean; focus?: string } = {}): Promise<void> {
    return sessionMaybeCompactImpl(this as unknown as CompactHost, opts);
  }

  /** List (paths only) the last N files the dropped turns touched. Bodies are
   * not re-embedded — the model re-reads the history archive on demand.
   * `compactRestoreFiles: 0` disables the list. */
  private async restoreDroppedFiles(
    dropped: Event[],
    retained: Event[],
    _window: number,
  ): Promise<string> {
    const maxFiles = this.config.compactRestoreFiles ?? 5;
    if (maxFiles <= 0) return "";
    try {
      const paths = droppedFilePaths(dropped, retained, this.cwd);
      if (paths.length === 0) return "";
      const { text } = await renderRestoredFiles(paths, {
        cwd: this.cwd,
        maxFiles,
        canRead: async (p) => (await assertPathAllowedAsync(p, "read", this.sandbox, this.cwd)).ok,
      });
      return text;
    } catch {
      return "";
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

 /** Produce a short title for the session. Tries the small model first,
 * then falls back to a deterministic prefix of the first user text. */
  private async refreshTitle(firstUserText: string): Promise<void> {
    if (isWeakTitleSource(firstUserText)) return;
    const fallback = deriveTitleFromText(firstUserText);
    if (!fallback || fallback === "(untitled)") return;
    let candidate: string | null = null;
    try {
      const provider = buildSmallProvider(this.config);
      candidate = await callTitleModel(provider, firstUserText, this.config.smallModel);
    } catch {
 /* ignore */
    }
    const title = sanitizeTitle(candidate ?? "") ?? sanitizeTitle(fallback) ?? fallback;
    if (title && title !== "(untitled)" && !isWeakTitleSource(title)) {
      await this.setTitle(title);
    }
  }

  async compact(focus?: string): Promise<void> {
    return sessionCompact(this as unknown as CompactHost, focus);
  }

  async pinMessage(messageId: string, pinned = true): Promise<boolean> {
    return pinMessageImpl(this as unknown as CompactHost, messageId, pinned);
  }

  pinnedMessageIds(): string[] {
    return pinnedMessageIdsImpl(this as unknown as CompactHost);
  }

  async clearWorkingContext(reason?: string): Promise<boolean> {
    return clearWorkingContextImpl(this as unknown as CompactHost, reason);
  }
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
