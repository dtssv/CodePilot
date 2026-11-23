// Agent loop: stream from the ChatProvider, parse tool calls, run permission
// checks, execute tools, append results, and loop until no more tool calls.
// Layout: agent-types.ts (types); agent-run/ (main loop); agent-messages.ts (messages + tool defs +
// streamOnce); agent-tools.ts (runOneTool + token estimates); agent-barrier.ts
// (abort + parallel barrier); agent-convergence.ts (caps / stall / live
// context); agent-resume.ts (truncation / overflow resume); agent-plan.ts
// (plan / soft-stop heuristics).


import type {
  ChatProvider,
  ProviderMessage,
  StreamChatOptions,
} from "../providers/types.js";
import type { ToolRegistry } from "../tools/types.js";
import type { ArtifactStore } from "../tools/artifacts.js";
import type { PermissionEngine } from "../permissions/permissions.js";
import type {
  AgentMode,
  CodepilotConfig,
  Event,
  ImageAttachment,
  PermissionResolution,
  PermissionRequest,
  QuestionAnswers,
  QuestionRequest,
} from "../types.js";
import type { ResolvedSandbox } from "../sandbox/sandbox.js";
import type { HookEngine } from "../hooks/hooks.js";
import type { RedactionPattern } from "../permissions/redact.js";
import type { DedupCache } from "./doomLoop.js";
import type { Span } from "../telemetry/telemetry.js";

export interface AgentDeps {
  provider: ChatProvider;
  tools: ToolRegistry;
  /** Tool names already sent on the wire; kept sticky across mode/lazy flips. */
  advertisedToolNames?: Set<string>;
  artifacts: ArtifactStore;
  permissions: PermissionEngine;
  config: CodepilotConfig;
  cwd: string;
 /** Identity of the running session (or sub-agent). Stamped onto background
  * jobs so `write_stdin` can refuse to write to a job owned by a DIFFERENT
  * session — the `bashJobs` registry is keyed only by cwd, which collides when
  * parallel sub-agents fall back to a shared parent cwd (worktree isolation
  * unavailable). Omitted in minimal contexts → no ownership stamping. */
  sessionId?: string;
 /** Optional: prebuilt system prompt. `staticPrefix` + `stableContext` form the
 * cached system block; `volatileSuffix` is the per-turn tail. `dynamicSuffix`
 * kept for back-compat. */
  systemPrompt?: {
    staticPrefix: string;
    dynamicSuffix: string;
    full: string;
    stableContext?: string;
    volatileSuffix?: string;
  };
 /** Optional: signal cancellation from the Session. */
  signal?: AbortSignal;
 /** Called with each produced event (for persistence / streaming). */
  onEvent?: (e: Event) => void | Promise<void>;
 /** Called with each usage update. */
  onUsage?: (usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; costUSD?: number }) => void;
 /** Called with a provider rate-limit snapshot when a response carried
  * rate-limit headers. Observational — the session keeps the latest snapshot to
  * surface in the status-line payload. Optional. */
  onRateLimit?: (info: { requestsRemaining?: number; tokensRemaining?: number; resetsInSeconds?: number }) => void;
/**
 * Called after every assistant turn with the running session-level token
 * estimate (segmented estimator in `./tokens.js`; for decisions, not exact BPE).
 * Optional — when omitted the agent runs unchanged.
 */
  onTokenEstimate?: (estimate: { tokens: number; turns: number; window: number }) => void;
  /**
   * Mid-run context compaction: called before a provider turn when the live
   * transcript approaches the model window. Compact the session's authoritative
   * event list and return the new live transcript (or `null` if unchanged).
   */
  compactNow?: () => Promise<Event[] | null>;
  /**
   * Mid-run durable prune of old tool_result bodies. Returns the updated live
   * transcript when stubs were persisted, otherwise null.
   */
  pruneNow?: () => Promise<Event[] | null>;
/**
  * Register a prompt-cache warm candidate at a normal turn end: `replay`
  * re-sends the exact request with a 1-token output cap. The session decides
  * (cost-gated) whether/when to call it; omit to disable warming.
  */
  onWarmableRequest?: (candidate: {
    prefixTokens: number;
    replay: (signal: AbortSignal) => Promise<void>;
  }) => void;
 /** Stable per-session cache-affinity key (→ OpenAI `prompt_cache_key`). */
  promptCacheKey?: string;
 /** Provider-enforced structured output for this run (OpenAI/Azure
  * `json_schema`). Threaded into every provider stream call. Callers set it
  * only when the provider supports it AND the run is a single structured
  * completion — some models reject it combined with tool-calling. */
  responseFormat?: StreamChatOptions["responseFormat"];
 /** Permission request handler. May return a plain decision or a
  * decline-with-feedback object (see PermissionResolution). */
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionResolution>;
 /** Background classifier for the `auto` permission mode. When set and the
  * mode is `auto`, a soft (non-floor) ask is adjudicated by this classifier
  * before any prompt: allow → run; deny → refuse with the reason; uncertain →
  * fall back to the interactive prompt. Omitted → `auto` behaves like `ask`. */
  permissionClassifier?: import("../permissions/permissionClassifier.js").PermissionClassifier;
 /** Maximum number of assistant turns per prompt. */
  maxTurns?: number;
 /** Soft convergence ceiling applied even when maxTurns is unlimited. After
  * this many turns the loop winds down and hard-disables tool calls for the
  * final turn so the model must answer from what it has rather than looping
  * forever. Unset → config.convergenceCap → DEFAULT_CONVERGENCE_CAP; 0 =
  * disabled. */
  convergenceCap?: number;
 /** True when this run is a sub-agent (driven by the `task` tool). Turn caps
 * soft-land with a synthesis urge instead of a hard error (the user can't
 * "send another message" to continue a sub-agent). */
  isSubagent?: boolean;
 /** Sub-agent prompt profile — selects wind-down conclusion shape (Findings vs
  * Plan). Only meaningful when `isSubagent` is true. */
  subagentProfile?: "explore" | "plan" | "worker";
 /** Active sandbox policy handed to every tool via ToolContext. */
  sandbox?: ResolvedSandbox;
 /**
 * Grant an extra writable directory after the user approves an out-of-root
 * write. When `persist` is set the grant is remembered across sessions.
 */
  expandSandboxWritable?: (
    dir: string,
    opts: { persist: boolean },
  ) => Promise<void> | void;
  /**
   * Task delivery roots (where intentional project deliverables should land).
   * Defaults to `[cwd]`; Session extends from path tokens in user prompts.
   * Live array — mid-turn `addDeliveryRoot` mutates it in place.
   */
  deliveryRoots?: string[];
  /** Session scratch / project-state paths (exempt from delivery-root guard). */
  scratchDir?: string;
  projectStateDir?: string;
  /** Add a delivery root after the user approves an out-of-root write. */
  addDeliveryRoot?: (dir: string) => void | Promise<void>;
 /** Lifecycle hook engine (PreToolUse / PostToolUse). Optional. */
  hooks?: HookEngine;
 /** Structured user-question channel for ask_user_question / plan_done. */
  onAskUser?: (req: QuestionRequest) => Promise<QuestionAnswers>;
 /**
 * Persistent shell for foreground `bash` calls. When present, the bash
 * tool routes foreground commands through it so `cd`, `export`, and
 * background jobs persist across calls. Optional — absent in tests.
 */
  persistentShell?: {
    run(command: string, opts: { timeout?: number; signal?: AbortSignal }): Promise<import("../sandbox/persistentShell.js").PersistentShellResult>;
  };
 /** LSP diagnostics provider for the `diagnostics` tool. Host-supplied. */
  diagnosticsProvider?: import("../tools/diagnostics.js").DiagnosticsProvider;
 /** Current sub-agent nesting depth (0 at top level). Drives the `task`
 * tool's recursion guard. */
  subagentDepth?: number;
 /** Shared idempotent-result cache. When supplied (by the session) the
 * dedup cache survives across prompts, so a file read in one turn is
 * replayed in the next instead of re-read. Omitted in tests/subagents,
 * where a fresh run-local cache is created automatically. */
  dedupCache?: DedupCache;
/**
 * Steering hook: called at the start of every agent turn. `user` items are
 * injected into the transcript as user messages; `system` items are surfaced
 * via the per-turn runtime_context (never spoofable as user input).
 */
  drainSteering?: (opts?: { scope?: "steer" | "all" }) => Array<{
    source: "user" | "system";
    text: string;
  }>;
 /** True when a `user` steer-delivery item is pending. Lets the stream loop
  * cut the current provider request at a safe boundary (before any tool call)
  * so a mid-run correction lands in the same turn. */
  peekSteering?: () => boolean;
 /** Returns the signal that aborts only the in-flight provider SSE for a
  * mid-stream steer. Distinct from `signal` (user Stop): a steer abort keeps
  * partial text and does NOT mark the run cancelled. */
  getSteerSignal?: () => AbortSignal | undefined;
 /**
 * Collaboration mode. Filters the tool table sent to the
 * provider. Defaults to "agent" (no filtering).
 */
  agentMode?: AgentMode;
/**
 * Optional parent telemetry span (the `codepilot.prompt` span created by
 * session.prompt); child spans link to it. Unused when telemetry is disabled.
 */
  parentSpan?: Span;
  /**
   * Last single-request provider input size from a prior turn/prompt.
   * Seeds mid-run pressure detection so the first request of a new prompt
   * does not re-send an already-oversize transcript.
   */
  lastProviderInputTokens?: number;
  /** Freeze map for folded tool_result stubs (toolCallId → stub text) so the
   * wording — and the prompt-cache prefix — stays stable across turns. */
  foldedToolResultStubs?: Map<string, string>;
  /**
   * Session-scoped file-observation store (staleness guard after reads).
   * When supplied, read_file records observations and write/edit tools assert
   * freshness before mutating. Omitted in tests/sub-agents.
   */
  fileObservations?: import("../workspace/fsObservation.js").FileObservationStore;
  /** Post-write formatting + diagnostics for the file-writing tools. */
  postWrite?: import("../workspace/postWrite.js").PostWrite;
  /**
   * Deployment-configured extra redaction patterns (`redact.patterns` in
   * config), already compiled. Applied to tool output AFTER the built-in
   * secret floor — never instead of it. Omitted in tests/sub-agents.
   */
  redactPatterns?: readonly RedactionPattern[];
  /** Plugin context transform applied to the provider message view before each
   * request (after fold/compaction). Fail-soft; omitted → no-op. */
  contextTransform?: (view: ProviderMessage[]) => ProviderMessage[];
  /**
   * Query-relevant memory notes selected at turn start, injected into the
   * volatile per-turn context without persisting to the transcript or busting
   * the cached system prefix. Omitted → no recall block.
   */
  relevantMemories?: string;
}

export interface AgentRunInput {
 /** Existing transcript (from session resume) — newest first OR oldest first? Oldest. */
  history: Event[];
  userText: string;
  images?: ImageAttachment[];
 /** Files already written under the workspace for this prompt. */
  files?: import("../types.js").SavedUpload[];
  /**
   * Stop-hook / stopVerify continue feedback. Sent as a provider-only resume
   * (not persisted as a `role: user` event, so no fake user bubble).
   */
  systemContinue?: string;
  /**
   * Resume the LAST turn from `history` instead of starting a new one (set
   * after an error so a user "retry" picks up where it stopped). No new
   * `role:"user"` event is emitted; `userText` is only the compaction fallback.
   */
  resume?: boolean;
  /**
   * The caller has already appended/surfaced the `role:"user"` message into
   * `history`, so the loop must not emit a second one. The provider view is
   * still rebuilt from `history`.
   */
  userAlreadyEmitted?: boolean;
}

export interface AgentRunResult {
 /** All events produced during this run (in order). */
  events: Event[];
 /** True if the model emitted at least one tool call this run. */
  hadToolCalls: boolean;
 /** Final assistant text, if any. */
  finalText: string;
 /**
  * True when a finite turn cap was hit (or the sub-agent synthesis bonus
  * turn was used). Callers may ask the user whether to extend the run.
  */
  reachedTurnBudget?: boolean;
}
