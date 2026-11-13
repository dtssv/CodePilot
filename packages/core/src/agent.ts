// Agent loop: stream from the ChatProvider, parse tool calls, run permission
// checks, execute tools, append results, and loop until no more tool calls.
// Layout: agent.ts (types + loop); agent-messages.ts (messages + tool defs +
// streamOnce); agent-tools.ts (runOneTool + token estimates).

import { randomUUID } from "node:crypto";
import type {
  ChatProvider,
  ProviderMessage,
  ProviderToolDef,
  StreamChatOptions,
} from "./providers/types.js";
import { ToolRegistry, type PermissionLevel } from "./tools/types.js";
import type { ArtifactStore } from "./tools/artifacts.js";
import { PermissionEngine } from "./permissions.js";
import type {
  AgentMode,
  CodepilotConfig,
  ContentBlock,
  Event,
  ImageAttachment,
  PermissionResolution,
  PermissionRequest,
  QuestionAnswers,
  QuestionRequest,
  ToolUseBlock,
} from "./types.js";
import type { ResolvedSandbox } from "./sandbox.js";
import type { HookEngine } from "./hooks.js";
import { redactSecrets, type RedactionPattern } from "./redact.js";
import {
  DoomLoopDetector,
  type DedupCache,
  signature as toolSignature,
  questionSimilarity,
  QUESTION_SIMILARITY_THRESHOLD,
} from "./doomLoop.js";
import { consistencyAssertEnabled, assertConsistency } from "./consistency.js";
import { applyContextTransform } from "./contextTransform.js";
import { detectRunawayRepetition } from "./textDegeneration.js";
import { getTracer, type Span } from "./telemetry.js";
import {
  buildProviderMessages,
  buildProviderToolDefs,
  decideLazyMcp,
  streamOnce,
} from "./agent-messages.js";
import {
  runOneTool,
  emitTokenEstimateIfNeeded,
  type ToolExecResult,
} from "./agent-tools.js";
import { estimateEventTokens, extractPlan, usageSignalsCompact, HARD_TRIM_RATIO, compactionGeometry } from "./compaction.js";
// Message-based transient classifier (shared SoT). Re-exported below for
// existing `from "./agent.js"` callers.
import { classifyProviderFailure, isTransientError } from "./transientError.js";
export { isTransientError } from "./transientError.js";
import { renderPlanBlock } from "./systemPrompt.js";
import { estimateTokens, lookupContextWindow } from "./tokens.js";

export interface AgentDeps {
  provider: ChatProvider;
  tools: ToolRegistry;
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
  permissionClassifier?: import("./permissionClassifier.js").PermissionClassifier;
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
    run(command: string, opts: { timeout?: number; signal?: AbortSignal }): Promise<import("./persistentShell.js").PersistentShellResult>;
  };
 /** LSP diagnostics provider for the `diagnostics` tool. Host-supplied. */
  diagnosticsProvider?: import("./tools/diagnostics.js").DiagnosticsProvider;
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
  /**
   * Session-scoped file-observation store (read-before-write + staleness guard).
   * When supplied, read_file records observations and write/edit tools assert
   * freshness before mutating. Omitted in tests/sub-agents.
   */
  fileObservations?: import("./fsObservation.js").FileObservationStore;
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
  files?: import("./types.js").SavedUpload[];
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

/**
 * Convenience for a conversational close: when the turn ends with no pending
 * steps, close leftover in_progress steps from this run. Soft stops with
 * remaining pending work are left alone for the next user message.
 */
async function closeFinishedPlan(produced: Event[], emit: (e: Event) => Promise<void>): Promise<void> {
  const plan = [...produced].reverse().find((e): e is Extract<Event, { type: "plan" }> => e.type === "plan");
  if (!plan) return;
  if (plan.steps.some((s) => s.status === "pending")) return;
  if (!plan.steps.some((s) => s.status === "in_progress")) return;
  await emit({
    type: "plan",
    steps: plan.steps.map((s) => (s.status === "in_progress" ? { ...s, status: "completed" } : s)),
  });
}

export async function runAgent(
  rawInput: AgentRunInput,
  deps: AgentDeps
): Promise<AgentRunResult> {
 // Hosts often pass their live transcript array, which their `onEvent`
 // appends to. Without a snapshot every event of this run would be in both
 // `history` and `produced`, so the model would see the user's prompt again
 // after each tool result and re-run it (e.g. asking the same question twice).
  let input: AgentRunInput = { ...rawInput, history: rawInput.history.slice() };
  // Unset / 0 → unlimited. Abnormal loops are handled by DoomLoopDetector +
  // cancel, not by a small turn ceiling.
  const configuredMax = deps.maxTurns ?? deps.config.maxTurns;
  const maxTurns =
    configuredMax === undefined || configuredMax === 0 ? Number.POSITIVE_INFINITY : configuredMax;
  // Soft convergence ceiling applied even when maxTurns is unlimited: winds
  // down and disables tools on the final turn after this many turns without
  // user intervention (catches a model re-verifying with slightly different
  // commands). 0 disables; unset falls back to DEFAULT_CONVERGENCE_CAP.
  // Precedence: deps override, then convergence.cap, then convergenceCap.
  const cv = deps.config.convergence;
  const rawConvergenceCap = deps.convergenceCap ?? cv?.cap ?? deps.config.convergenceCap;
  const convergenceCap =
    rawConvergenceCap === 0
      ? Number.POSITIVE_INFINITY
      : rawConvergenceCap === undefined
        ? DEFAULT_CONVERGENCE_CAP
        : rawConvergenceCap;
  // The turn at which wind-down (synthesis urge + toolChoice:"none") begins.
  // Whichever ceiling is lower governs; both can be unlimited.
  const windDownAt = Math.min(maxTurns, convergenceCap);
  // Resolved convergence / no-progress thresholds (config overlaid on the
  // built-in constants).
  const hardSlack = cv?.hardSlack ?? CONVERGENCE_HARD_SLACK;
  const noProgressSoft = cv?.noProgressSoft ?? NO_PROGRESS_SOFT_TURNS;
  const noProgressStrong = cv?.noProgressStrong ?? NO_PROGRESS_STRONG_TURNS;
  const noProgressLock = cv?.noProgressLock ?? NO_PROGRESS_LOCK_TURNS;
  const remainingNudgeAt = cv?.remainingNudgeAt ?? DEFAULT_REMAINING_NUDGE_AT;
  const agentMode: AgentMode = deps.agentMode ?? "agent";
  const produced: Event[] = [];
  const doomLoop = new DoomLoopDetector(deps.dedupCache, deps.config.doomLoop);
 // Plan-progress tracking: if the model keeps calling tools but the plan
 // never advances (no step moves to completed/in_progress), it's spinning.
 // After PLAN_STALL_TURNS turns of no progress we surface a stall notice via
 // the live runtime_context (NOT as a fake user message — that pollutes the
 // persisted transcript and misleads anyone replaying the session).
  let planProgressSig = "";
  let turnsSincePlanProgress = 0;
 // Progress-gated stall counter: turns in a row with no DURABLE progress
 // (write/edit, a task conclusion, memory_write, or a plan advance). Unlike
 // turnsSincePlanProgress this works with no plan and in any mode — it is the
 // backstop for a model that keeps reading / re-running variant bash without
 // changing state. Reset on durable progress; drives the NO_PROGRESS_* ladder.
  let turnsSinceNoProgress = 0;
 // Exploration-progress stall counter: the read-only analogue of
 // turnsSinceNoProgress. A pure investigation (debugging, code reading) makes
 // no durable writes, so the write-centric ladder above would wind it down
 // even while it is genuinely closing in on a root cause. This track resets
 // when a turn surfaces NEW evidence (a first read of a file/window, a grep/
 // glob hitting a path not seen before, or a non-empty read command not run
 // before this turn) and extends when a read-only turn only re-reads the same
 // ground. It is deliberately more lenient than the write ladder (debugging
 // runs long) but still lands on the same lock backstop so a true spin stops.
 let turnsSinceNoExploration = 0;
 // Consecutive-failure counter: turns whose executed (non-aborted) tool calls
 // ALL errored, with none succeeding. Orthogonal to the progress ladders — a
 // run can be "failing" (every attempt errors) in ways those do not single
 // out — so it drives its own notice telling the model to change approach or
 // report a blocker rather than retry the same failing operation. A turn with
 // any successful tool call resets it; a turn with no tool calls is neutral.
 let consecutiveFailureTurns = 0;
 // Signatures of non-dedupable read commands (bash/lsp_navigate) already run —
 // a repeat with the same args is not new evidence even if its output differs
 // slightly. Dedupable reads (read_file/grep/glob/ls) are judged instead by the
 // dedup-cache replay prefix the tool layer already stamps on a repeat.
 const seenReadCommandSigs = new Set<string>();
 // The previous turn's assistant "intent" text, for the reworded-spin guard:
 // reading a new file but restating the same next-step plan verbatim is not
 // real progress, so a high-similarity intent vetoes an exploration reset.
 let priorIntentText = "";
 // Plan mode exists to produce a plan, not to execute — so nudge it toward
 // synthesis sooner (3 stalled turns) than a full agent run (4). Chat mode
 // has no plan to stall on.
  const PLAN_STALL_TURNS = agentMode === "plan" ? 3 : 4;
 // Whether this turn's live context should carry the stall notice. Set when
 // the stall threshold is crossed; cleared once the plan advances again.
  let planStalled = false;
  const emit = async (e: Event): Promise<void> => {
 // Stamp a wall-clock timestamp on content-bearing events (if not already
 // set) so UIs can show the real time of each message / tool call / result
 // — including after a replay, where the client-side receive time is wrong.
    if (
      (e.type === "message" || e.type === "tool_call" || e.type === "tool_result") &&
      e.ts === undefined
    ) {
      e.ts = Date.now();
    }
    produced.push(e);
    if (deps.onEvent) await deps.onEvent(e);
  };
 // Host-only notices (retries): shown to the user, never part of the run's
 // transcript.
  const emitAux = async (e: Event): Promise<void> => {
    if (deps.onEvent) await deps.onEvent(e);
  };
  const turnRetries = deps.config.turnRetries ?? 2;
  const modelWindow = lookupContextWindow(deps.config.model);
  const contextWindow = deps.config.contextWindow ?? modelWindow.contextWindow;
  const systemReserve = estimateTokens(deps.systemPrompt?.staticPrefix ?? "") +
    estimateTokens(deps.systemPrompt?.stableContext ?? deps.systemPrompt?.dynamicSuffix ?? "") +
    estimateTokens(deps.systemPrompt?.volatileSuffix ?? "");
  const outputReserve = Math.max(
    1_024,
    deps.config.maxTokens ?? modelWindow.maxOutputTokens ?? 8_192,
  );
  // Hard send ceiling: configured window minus system prompt + output headroom.
  // This bounds a SINGLE request's prompt (system + transcript + output room) —
  // a different concept from the history-size compaction trigger below, so it
  // keeps its own formula (it alone subtracts `systemReserve`).
  const hardBudget = Math.max(
    4_000,
    contextWindow - systemReserve - outputReserve - 1_024,
  );
  // Auto-compact trigger: ask the session to compact when the live transcript
  // reaches this token count. Must match the session's `maybeCompact` trigger
  // (both come from shared `compactionGeometry` so they can't drift). Capped
  // at `hardBudget` so history alone never exceeds one request's capacity.
  const autoTrigger = Math.min(
    hardBudget,
    compactionGeometry({
      window: contextWindow,
      thresholdFraction: deps.config.compactionThreshold,
      maxTokens: deps.config.maxTokens,
      maxOutputTokens: modelWindow.maxOutputTokens,
    }).hardTrigger,
  );
  // Soft fold target for speed (default 48K); still capped by hardBudget.
  const softBudget = deps.config.maxContextTokens ?? 48_000;
  const contextBudget = Math.max(8_000, Math.min(hardBudget, softBudget));
  // Rolling tool-output window: fold old tool_results down to this many
  // early, before budget pressure. Default 24.
  const maxUnfoldedToolResults = deps.config.maxToolResultsInContext ?? 24;
  /** Last provider-reported input size, used for next-turn pressure checks. */
  let lastInputTokens = Math.max(0, deps.lastProviderInputTokens ?? 0);

 // Skip emitting a `role:"user"` transcript event for a Stop-hook continue
 // (systemContinue) or a resume: the continue feedback flows via
 // systemContinue, a resume reuses the existing history, and a new user
 // bubble would fake human input in the UI / persisted JSONL.
  const suppressUserEvent =
    !!input.systemContinue || !!input.resume || !!input.userAlreadyEmitted;
  const userImages = suppressUserEvent ? undefined : input.images;
  let pendingProviderResume: string | null = input.systemContinue?.trim()
    ? input.systemContinue
    : null;
  if (!suppressUserEvent) {
    const userMessageId = `msg_${randomUUID()}`;
    const userEvent: Event = {
      type: "message",
      id: userMessageId,
      role: "user",
      content: [{ type: "text", text: input.userText }],
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.files?.length ? { files: input.files } : {}),
    };
    await emit(userEvent);
  }

  let totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawToolCalls = false;
 // Replies cut off by the output-token limit are resumed rather than taken
 // as the final answer (bounded, so a model that always overflows can't loop).
  let truncatedInARow = 0;
 /** Consecutive mid-stream connection interrupts resumed by continuation
  * (rather than full-turn regeneration). Bounded so a persistently flapping
  * connection can't loop forever; once exhausted we fall back to regenerate. */
  let interruptResumes = 0;
 /** Provider-only follow-up injected on the next iteration (truncation /
  * empty-stop / plan soft-continue). Never persisted as a user message.
  * Also seeded from `systemContinue` (Stop verify) above. */
 /** Text of the cut-off replies being resumed; prefixes the final answer. */
  let resumedText = "";
 /** Bounded auto-continues for empty successful stops after tool use
  * (soft-stop mitigation). */
  let emptyStopResumes = 0;
 /** At most one soft continue when the plan is still open and the model
  * yielded with incomplete-intent prose (not a question to the user). */
  let planSoftResumes = 0;
 /** Bounded nudges when the model wrote a tool call as text markup instead of
  * a real structured call (nothing executed). */
  let pseudoToolResumes = 0;

  let hitMaxTurns = false;
  /** Sub-agents get one extra synthesis turn after the configured cap so a
   * budget hit becomes "finish writing your conclusion" instead of an error. */
  let subagentSynthesisBonus = false;
  let reachedTurnBudget = false;
  for (let turn = 0; ; turn++) {
    if (deps.signal?.aborted) {
      break;
    }
    // Absolute ceiling. `maxTurns` is the configured hard cap; `windDownAt`
    // adds the convergence backstop a few turns of slack above the wind-down
    // point so that even a provider ignoring `toolChoice:"none"` cannot loop
    // forever. Whichever fires first stops the run.
    const hardCeiling = Math.min(
      maxTurns,
      Number.isFinite(windDownAt) ? windDownAt + hardSlack : Number.POSITIVE_INFINITY,
    );
    if (turn >= hardCeiling) {
      if (deps.isSubagent === true && !subagentSynthesisBonus && Number.isFinite(hardCeiling)) {
        // Soft landing: allow exactly one more turn dedicated to synthesizing.
        subagentSynthesisBonus = true;
        reachedTurnBudget = true;
      } else {
        hitMaxTurns = true;
        reachedTurnBudget = true;
        break;
      }
    }

 // Snapshot the plan-progress signature at the start of the turn so we
 // can tell whether this turn's tool calls advanced the plan.
    const planSigBefore = planProgressSig;
 // Whether this turn changed durable state (a successful write/edit/task/
 // memory_write, or a plan advance). Set while processing tool results below;
 // drives the progress-gated stall counter at the end of the turn.
    let madeDurableProgress = false;
 // Whether this turn surfaced NEW read-only evidence (a first read / fresh
 // grep / not-before-run command). Resets the exploration-stall track so a
 // debug session that never writes is not throttled while it is still learning.
    let madeExplorationProgress = false;
 // Per-turn tool outcome tally for the consecutive-failure track. A permission
 // abort (deny & stop) is the user's call, not a model-fixable failure, so it
 // counts as neither success nor failure here.
    let turnToolSuccesses = 0;
    let turnToolFailures = 0;

 // Drain queued steering. Genuine user input enters the transcript as a
 // user message (so the model acts on it immediately and it persists on
 // replay). Engine-generated notices do NOT: they ride in this turn's
 // runtime_context (see `systemSteerNotices`), so a system notice can never
 // impersonate user input.
    const systemSteerNotices: string[] = [];
    if (deps.drainSteering) {
      const steered = deps.drainSteering();
      for (const item of steered) {
        if (item.source === "system") {
          systemSteerNotices.push(item.text);
          continue;
        }
        await emit({
          type: "message",
          id: `msg_${randomUUID()}`,
          role: "user",
          content: [{ type: "text", text: item.text }],
        });
      }
    }

 // Plan-stall notice: flag in <runtime_context> when several tool turns pass
 // without a plan step advancing, then reset the counter. Never persisted as a
 // message so it can't be mistaken for user input.
    if (planProgressSig !== "" && turnsSincePlanProgress >= PLAN_STALL_TURNS) {
      turnsSincePlanProgress = 0;
      planStalled = true;
    }

    // Turn-budget wind-down: as the run approaches `windDownAt` (lower of
    // maxTurns and the convergence cap), urge synthesis on the last turns. On
    // the final turn hard-disable tool calls (toolChoice:"none") as a backstop
    // — fires even when maxTurns is unlimited.
    let lockToolsThisTurn = false;
    let budgetWarning = false;
    if (Number.isFinite(windDownAt) && turn > 0) {
      const remaining = windDownAt - turn;
      // Tiered fixed copy (no per-turn counters) keeps the trailing
      // runtime_context byte-stable across turns in the same wind-down tier;
      // only the tier transition rewrites the tail.
      if (subagentSynthesisBonus || remaining <= 1) {
        lockToolsThisTurn = true;
        budgetWarning = true;
        systemSteerNotices.push(
          deps.isSubagent
            ? "Turn budget reached. Do NOT call any more tools. Write your structured " +
                "conclusion NOW (### Findings / ### Key references / ### Recommendations, or " +
                "### Blocker). Partial-but-synthesized beats stopping mid-exploration. Note " +
                "anything left unverified."
            : "You have reached the turn budget for this task. Do NOT call any more tools. " +
                "Using only what you already have, write your final answer now. If some detail " +
                "is still unverified, say so explicitly rather than looping to verify it.",
        );
      } else if (remaining <= remainingNudgeAt) {
        budgetWarning = true;
        systemSteerNotices.push(
          "A few turns left in your budget. Wrap up tool use soon and prepare to synthesize " +
            "your final answer from what you already have.",
        );
      }
    }

    // Progress-gated stall ladder: nudges at NO_PROGRESS_SOFT/STRONG then reuses
    // the wind-down lock at NO_PROGRESS_LOCK when a run keeps calling tools
    // without changing durable state. Durable progress resets the streak, so a
    // genuine long task is never throttled. Notice text is tier-stable (no
    // embedding the exact stall count) so same-tier turns share a cacheable tail.
    if (!lockToolsThisTurn && turnsSinceNoProgress >= noProgressLock) {
      lockToolsThisTurn = true;
      systemSteerNotices.push(
        deps.isSubagent
          ? "You have gone many turns without changing any durable state (no writes, edits, " +
              "or sub-agent conclusions) — you are re-checking in circles. Do NOT call any more " +
              "tools. Write your structured conclusion NOW (### Findings / ### Key references / " +
              "### Recommendations, or ### Blocker) from what you already have. Note anything " +
              "left unverified instead of looping to verify it."
          : "You have gone many turns without changing any durable state (no writes or edits) " +
              "— you are verifying in circles. Do NOT call any more tools. Using only what you " +
              "already have, write your final answer now: what you found, what is still " +
              "unverified or unfinished, and the recommended next step. Mark unverified " +
              "details as such rather than looping to confirm them.",
      );
    } else if (!lockToolsThisTurn && turnsSinceNoProgress >= noProgressStrong) {
      systemSteerNotices.push(
        "You have made no durable progress (no writes, edits, or conclusions) for many turns. " +
          "Stop re-checking and move to synthesis: decide whether you already have enough to " +
          "answer, and if so answer now instead of running more tools.",
      );
    } else if (!lockToolsThisTurn && turnsSinceNoProgress >= noProgressSoft) {
      systemSteerNotices.push(
        "You have made no durable progress (no writes or edits) for several turns. If you keep " +
          "reading/re-running commands without acting, you are likely spinning — take a concrete " +
          "action (edit, write, or answer) rather than gathering more evidence.",
      );
    }

    // Exploration-stall ladder: the read-only path for investigations that keep
    // surfacing new evidence (so the write ladder above is held off) but have
    // gone very long. The nudges are about SYNTHESIS, not "go write something"
    // — a read-only debug task may have nothing to write — escalating to the
    // same tool lock. Only fires when the write ladder has not already locked.
    if (!lockToolsThisTurn && turnsSinceNoExploration >= NO_EXPLORATION_LOCK_TURNS) {
      lockToolsThisTurn = true;
      systemSteerNotices.push(
        deps.isSubagent
          ? "You have read and searched for many turns. Even if each turn turned up something, " +
              "you are past the point of diminishing returns. Do NOT call any more tools. Write " +
              "your structured conclusion NOW (### Findings / ### Key references / " +
              "### Recommendations, or ### Blocker) from what you already have, and note what is " +
              "still unverified."
          : "You have read and searched for many turns without reaching a conclusion. Do NOT call " +
              "any more tools. Using only what you already have, state your findings now: the most " +
              "likely explanation, the evidence for it, and what remains unverified or blocked — " +
              "rather than continuing to gather more.",
      );
    } else if (!lockToolsThisTurn && turnsSinceNoExploration >= NO_EXPLORATION_STRONG_TURNS) {
      systemSteerNotices.push(
        "You have spent many turns reading and searching. Step back and synthesize: state your " +
          "current best explanation and the evidence for it, and decide whether you already have " +
          "enough to answer or act, instead of gathering more.",
      );
    } else if (!lockToolsThisTurn && turnsSinceNoExploration >= NO_EXPLORATION_SOFT_TURNS) {
      systemSteerNotices.push(
        "You have been exploring for several turns. Make sure each read is still narrowing things " +
          "down; if you are circling, summarize what you have found and form a hypothesis rather " +
          "than reading more.",
      );
    }

    // Consecutive-failure notice: orthogonal to the progress ladders above.
    // When several turns in a row land only tool errors, retrying the same way
    // is unlikely to work — so steer toward a DIFFERENT approach or an honest
    // blocker report. Deliberately does NOT lock tools (a different operation
    // may well succeed) and is tier-stable (no count embedded) so same-tier
    // turns share a cacheable tail. Suppressed once the tools are being locked
    // anyway, to avoid piling a second directive on the same turn.
    if (!lockToolsThisTurn && consecutiveFailureTurns >= CONSECUTIVE_FAILURE_NOTICE_TURNS) {
      systemSteerNotices.push(
        deps.isSubagent
          ? "Several turns in a row produced only tool errors. Retrying the same way is unlikely " +
              "to work. Change approach — a different tool, path, or command — or, if you are " +
              "genuinely blocked, stop and report the blocker (### Blocker) with what you tried " +
              "and the exact errors, instead of repeating failing calls."
          : "Several turns in a row produced only tool errors. Retrying the same way is unlikely " +
              "to work. Step back and change approach — a different tool, path, or command — or, " +
              "if you are genuinely blocked, tell the user what is blocked, what you tried, and " +
              "the exact errors, rather than repeating failing calls.",
      );
    }

    // Per-turn budget snapshot for the client status line (non-persisted). A
    // UI can show turn/ceiling and the stall streak; `warning` is set on the
    // turns at/after the "turns left" threshold so a status line can highlight
    // an imminent wind-down.
    await emitAux({
      type: "turn_budget",
      turn,
      windDownAt: Number.isFinite(windDownAt) ? windDownAt : null,
      maxTurns: Number.isFinite(maxTurns) ? maxTurns : null,
      stalledTurns: turnsSinceNoProgress,
      ...(budgetWarning ? { warning: true } : {}),
    });

    await emit({ type: "status", status: "running" });

    // Mid-run compaction before each model step: when the live transcript (or
    // last API input) approaches the configured window, persist a summary
    // compaction and resync history so growth stays bounded.
    if (deps.compactNow && deps.config.autoCompact !== false) {
      // Estimate the transcript once here. `liveTokens` adds the fixed
      // system-prompt reserve, so it dominates a bare
      // shouldCompact(transcript, autoTrigger) check against the same trigger.
      const liveTokens =
        estimateEventTokens([...input.history, ...produced], estimateTokens) + systemReserve;
      const pressure =
        liveTokens >= autoTrigger ||
        (lastInputTokens > 0 &&
          usageSignalsCompact({ input: lastInputTokens, output: 0 }, autoTrigger));
      if (pressure) {
        try {
          const next = await deps.compactNow();
          if (next) {
            input.history = next;
            produced.length = 0;
            lastInputTokens = 0;
          }
        } catch {
          /* best-effort; hard trim below still guards the request */
        }
      }
    }

 // Soft-fold + hard-trim for the provider prompt. Fold is silent (no UI
 // notice); hard trim must account for estimator lag vs gateway tokenizers.
 // Re-estimate AFTER any compaction above so the trim calibration reflects the
 // (possibly compacted) history, not the pre-compaction size.
    const estLive = estimateEventTokens([...input.history, ...produced], estimateTokens);
    let sendHardBudget = hardBudget;
    if (lastInputTokens > 0 && estLive > 0) {
      const ratio = lastInputTokens / estLive;
      if (ratio > 1.05) {
        sendHardBudget = Math.max(4_000, Math.floor(hardBudget / ratio));
      }
    } else {
      // No calibration yet — keep headroom; heuristic under-counts CJK/tools.
      sendHardBudget = Math.max(4_000, Math.floor(hardBudget * HARD_TRIM_RATIO));
    }
    let providerMessages = buildProviderMessages(input.history, produced, input.userText, userImages, {
      contextBudget,
      hardBudget: sendHardBudget,
      maxUnfoldedToolResults,
    });
    // The view actually sent to the provider this request: `providerMessages`
    // after an optional plugin context transform (see below). Hoisted here so
    // the cache-warm replay can capture the SAME messages that were streamed.
    let sendMessages: ProviderMessage[] = providerMessages;
    // Count of trailing provider-only messages appended below that are
    // intentionally NOT in the event log (resume nudges). The consistency
    // check must skip these — otherwise it reports a false "Role mismatch"
    // because the logged tail ends at the real assistant message while the
    // provider tail ends with this extra `user` nudge.
    let providerOnlyTrailing = 0;
    if (pendingProviderResume) {
      // Provider-only: transcript keeps the real assistant text; this nudge
      // is not a user message and must not look like one on replay.
      providerMessages.push({ role: "user", content: [{ type: "text", text: pendingProviderResume }] });
      pendingProviderResume = null;
      providerOnlyTrailing++;
    }
    // Decide whether to lazily surface MCP / plugin tools (hide their schemas,
    // expose the `mcp` / `tool_catalog` meta-tool) based on config + how many
    // tools of that source exist this turn.
    const mcpToolCount = deps.tools.all().filter((t) => t.source === "mcp").length;
    const lazyMcp = decideLazyMcp(
      mcpToolCount,
      deps.config.mcpToolDiscovery,
      deps.config.mcpLazyThreshold,
    );
    const pluginToolCount = deps.tools.all().filter((t) => t.source === "plugin").length;
    const lazyPlugin = decideLazyMcp(
      pluginToolCount,
      deps.config.pluginToolDiscovery ?? "eager",
      deps.config.pluginLazyThreshold,
    );
    const providerTools = buildProviderToolDefs(deps.tools, agentMode, {
      lazyMcp,
      lazyPlugin,
      model: deps.config.model,
      toolExposure: deps.config.toolExposure,
    });
    const liveContext = buildLiveContext([...input.history, ...produced], produced, { planStalled, systemNotices: systemSteerNotices, relevantMemories: deps.relevantMemories });

 // Consistency assertion: verify the non-folded provider message tail matches
 // the persisted event log. Triggers: `consistencyCheck` config (warn/throw)
 // and `CODEPILOT_ASSERT_CONSISTENCY=1` (forces throw). The trailing
 // provider-only resume nudge is excluded — it's deliberately not in the log.
    const consistencyView = providerOnlyTrailing > 0
      ? providerMessages.slice(0, providerMessages.length - providerOnlyTrailing)
      : providerMessages;
    if (consistencyAssertEnabled() || (deps.config.consistencyCheck ?? "warn") === "throw") {
      assertConsistency(consistencyView, [...input.history, ...produced], 8);
    } else if ((deps.config.consistencyCheck ?? "warn") === "warn") {
      try {
        assertConsistency(consistencyView, [...input.history, ...produced], 8);
      } catch (err) {
        await emitAux({
          type: "error",
          message: `consistency check: provider messages diverge from the event log — ${(err as Error).message}`,
          recoverable: true,
        });
      }
    }

    let messageId = `msg_${randomUUID()}`;
    let assistantText: string[] = [];
    let assistantReasoning: string[] = [];
    let toolCalls: ToolUseBlock[] = [];
    let sawError: string | null = null;
    let finishReason = "stop";
    // Set when a mid-stream interrupt was salvaged by continuation (partial
    // text kept): tells the post-stream logic to re-enter the outer turn loop
    // with INTERRUPT_RESUME instead of treating the partial stop as final.
    let interruptedForResume = false;
    // Set when the stream was cut by a mid-stream user steer (B1). The partial
    // text is kept; after persisting it we re-enter the outer turn loop so the
    // steer is drained (as a user message) and the model re-samples with the
    // correction in view.
    let steeredMidStream = false;
    // Whether we've already force-compacted this turn due to a context-overflow
    // error, and how many proportional shrink steps we've applied (prevents an
    // infinite compact→overflow→compact loop).
    let overflowCompacted = false;
    let overflowAttempt = 0;
    // Byte/size payload rejections use their own aggressive body-shrink ladder
    // (fold every tool result, drop inline images, tighten the send budget)
    // rather than the token-overflow compaction ladder. Bounded separately.
    let payloadAttempt = 0;

    for (let attempt = 0; ; attempt++) {
      messageId = `msg_${randomUUID()}`;
      assistantText = [];
      assistantReasoning = [];
      toolCalls = [];
      sawError = null;
      finishReason = "stop";
      steeredMidStream = false;
      const streamed = await streamTurn(messageId);
      sawError = streamed.error;
      steeredMidStream = streamed.steeredMidStream;
      if (!sawError || deps.signal?.aborted) break;
      const failureKind = classifyProviderFailure(sawError);
      // Helper: drop THIS turn's discarded partial output before rebuilding the
      // send view smaller (shared by both recovery ladders).
      const dropDiscardedPartial = (): void => {
        for (let i = produced.length - 1; i >= 0; i--) {
          const e = produced[i]!;
          if ((e.type === "message_delta" && e.messageId === messageId) ||
              (e.type === "tool_call" && streamed.callIds.has(e.id))) {
            produced.splice(i, 1);
          }
        }
      };

      // Payload-too-large (byte/size rejection): shrink the REQUEST BODY, not
      // the transcript's token count. Fold every tool result, drop inline
      // images, and tighten the send budget hard — compaction would not help a
      // size rejection. Kept on its own bounded ladder so it cannot loop.
      if (
        failureKind === "payload_too_large" &&
        payloadAttempt < PAYLOAD_SHRINK_STEPS.length
      ) {
        const step = PAYLOAD_SHRINK_STEPS[payloadAttempt]!;
        payloadAttempt += 1;
        try {
          dropDiscardedPartial();
          providerMessages = buildProviderMessages(
            input.history,
            produced,
            input.userText,
            userImages,
            {
              contextBudget,
              hardBudget: Math.max(3_000, Math.floor(sendHardBudget * step)),
              // Fold ALL tool results (keep none unfolded) so the largest
              // bodies are replaced by artifact pointers, and drop inline images
              // from the send view — both are the usual cause of a size
              // rejection and neither is fixed by token compaction.
              maxUnfoldedToolResults: 0,
              dropImages: true,
            },
          );
          await emitAux({
            type: "retry",
            attempt: attempt + 1,
            maxAttempts: turnRetries,
            delayMs: 0,
            reason: `request too large — shrinking the request body to ${Math.round(step * 100)}% and retrying`,
          });
          continue;
        } catch {
          /* body shrink failed — fall through to normal error handling */
        }
      }

 // Context-overflow is recoverable by shrinking, not by regenerating.
 // On the first overflow force a compaction; on each subsequent overflow
 // shrink the send budget by the next proportional step.
 // `OVERFLOW_SHRINK_STEPS` bounds how far we go so a model that overflows
 // no matter what can't loop forever.
      if (
        failureKind === "context_overflow" &&
        deps.config.autoCompact !== false &&
        overflowAttempt < OVERFLOW_SHRINK_STEPS.length
      ) {
        const step = OVERFLOW_SHRINK_STEPS[overflowAttempt]!;
        overflowAttempt += 1;
        try {
          // First overflow: compact the history once. Later overflows just
          // shrink the budget (the history is already summarised).
          if (!overflowCompacted && deps.compactNow) {
            overflowCompacted = true;
            const next = await deps.compactNow();
            if (next) input = { ...input, history: next };
          }
          // Drop this turn's discarded partial output, then rebuild smaller.
          dropDiscardedPartial();
          providerMessages = buildProviderMessages(input.history, produced, input.userText, userImages, {
            contextBudget,
            hardBudget: Math.max(3_000, Math.floor(sendHardBudget * step)),
            maxUnfoldedToolResults,
          });
          await emitAux({
            type: "retry",
            attempt: attempt + 1,
            maxAttempts: turnRetries,
            delayMs: 0,
            reason: `context overflow — shrinking to ${Math.round(step * 100)}% and retrying`,
          });
          continue;
        } catch {
          /* compaction failed — fall through to normal error handling */
        }
      }
 // A transient failure (dropped connection, overloaded gateway).
      if (attempt >= turnRetries || failureKind !== "transient") break;
      const delayMs = Math.min(8000, 1500 * 2 ** attempt);

      // Continuation path: the stream dropped after visible text was produced
      // with no tool_call started. Keep the partial text and ask the model to
      // continue where it stopped (reuses the output-token-limit machinery).
      // Guards: no tool_call streamed (ambiguous → regenerate instead), text
      // actually produced, bounded by MAX_INTERRUPT_RESUMES.
      const partialText = assistantText.join("");
      if (
        streamed.callIds.size === 0 &&
        partialText.trim() !== "" &&
        interruptResumes < MAX_INTERRUPT_RESUMES
      ) {
        interruptResumes++;
        await emitAux({
          type: "retry",
          attempt: attempt + 1,
          maxAttempts: turnRetries,
          delayMs,
          reason: `${sawError} — continuing from the interrupted point`,
        });
        if (!(await sleepUnlessAborted(delayMs, deps.signal))) break;
        // Keep the partial output: it stays in `produced` and the persisted
        // assistant message carries it into the next request. Clearing
        // sawError makes the post-loop flow re-enter the turn loop with
        // INTERRUPT_RESUME, like a truncation resume.
        sawError = null;
        pendingProviderResume = INTERRUPT_RESUME;
        interruptedForResume = true;
        break;
      }

      // Regeneration path (no salvageable text, a tool_call was mid-stream, or
      // the interrupt budget is spent): discard the partial output and
      // regenerate the turn — nothing was executed, so this is safe.
      await emitAux({
        type: "retry",
        attempt: attempt + 1,
        maxAttempts: turnRetries,
        delayMs,
        reason: sawError,
        discardMessageId: messageId,
        ...(streamed.callIds.size > 0 ? { discardToolCallIds: [...streamed.callIds] } : {}),
      });
 // Drop the discarded attempt's streamed events so the transcript
 // only keeps the turn that succeeded.
      for (let i = produced.length - 1; i >= 0; i--) {
        const e = produced[i]!;
        if ((e.type === "message_delta" && e.messageId === messageId) ||
            (e.type === "tool_call" && streamed.callIds.has(e.id))) {
          produced.splice(i, 1);
        }
      }
      if (!(await sleepUnlessAborted(delayMs, deps.signal))) break;
    }

    async function streamTurn(id: string): Promise<{ error: string | null; callIds: Set<string>; steeredMidStream: boolean }> {
      const callIds = new Set<string>();
      let error: string | null = null;
      let steeredMidStream = false;
      // Snapshot the steer signal for THIS request. The host may rotate the
      // underlying controller after a steer is consumed, so each request reads
      // the current one.
      const steerSignal = deps.getSteerSignal?.();
 // Live degeneration guard: abort the stream when accumulating text goes
 // periodic (a weak model looping one clause), re-checked every few KB to stay
 // cheap. Thresholds configurable via `degeneration.*`; can be disabled.
      const degenCfg = deps.config.degeneration;
      const degenEnabled = degenCfg?.enabled !== false;
      let repetitionCheckedAt = 0;
      const REPETITION_CHECK_EVERY = degenCfg?.checkEveryChars ?? 2_000;
      // Bias toward not interrupting: require near-total periodicity before
      // stopping, since true degeneration is almost perfectly periodic while
      // legitimate repetitive output (tables, code) is only approximately so.
      // This floor applies only without an explicit `degeneration.threshold`.
      const LIVE_DEGEN_THRESHOLD = 0.98;
 // Per-request timing (persisted as a `request` event for diagnostics).
      const startedAt = Date.now();
      let ttftMs: number | undefined;
      const markFirstToken = (): void => {
        if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
      };
 // Telemetry: one child span per provider stream (no-op when disabled).
      const tracer = getTracer();
      const llmSpan = tracer.enabled
        ? tracer.startSpan("codepilot.llm_call", {
            parentSpanId: deps.parentSpan?.spanId,
            attributes: {
              "codepilot.model": deps.config.model ?? deps.provider.defaultModel,
              "codepilot.message_count": providerMessages.length,
              "codepilot.tool_count": providerTools.length,
            },
            kind: 3, // client
          })
        : undefined;
      const llmUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const onRetry = (info: { attempt: number; delayMs: number; reason: string }): void => {
        void emitAux({ type: "retry", attempt: info.attempt, maxAttempts: 8, delayMs: info.delayMs, reason: info.reason });
      };

      await emitAux({ type: "activity", phase: "model", since: startedAt });
      // Plugin context transform (source-safe): a plugin may prune / window /
      // inject-memory into what the model sees for THIS request only. Runs on a
      // copy, after the consistency check (which validates CodePilot's own
      // view), validated + fail-soft so a bad transform never sends a malformed
      // request. The persisted transcript is untouched.
      sendMessages = applyContextTransform(
        providerMessages,
        deps.contextTransform,
        (reason) =>
          void emitAux({
            type: "error",
            message: `context transform ignored — ${reason}`,
            recoverable: true,
          }),
      );
      let degenerated = false;
      try {
        for await (const ev of streamOnce(deps.provider, deps, sendMessages, providerTools, id, { liveContext, onRetry, onRateLimit: deps.onRateLimit, toolChoice: lockToolsThisTurn ? "none" : undefined, steerSignal })) {
          if (deps.signal?.aborted) break;
          if (steerSignal?.aborted) { steeredMidStream = true; break; }
          switch (ev.kind) {
            case "text_delta": {
              markFirstToken();
              assistantText.push(ev.text);
              await emit({
                type: "message_delta",
                messageId: id,
                delta: { type: "text", text: ev.text },
              });
              // Abort a runaway phrase-repetition loop before it exhausts the
              // output budget. Checked only every few KB of new text, and only
              // when the guard is enabled.
              const soFarLen = assistantText.reduce((n, s) => n + s.length, 0);
              if (degenEnabled && soFarLen - repetitionCheckedAt >= REPETITION_CHECK_EVERY) {
                repetitionCheckedAt = soFarLen;
                const rep = detectRunawayRepetition(assistantText.join(""), {
                  windowChars: degenCfg?.windowChars,
                  maxPeriod: degenCfg?.maxPeriod,
                  minRepeats: degenCfg?.minRepeats,
                  threshold: degenCfg?.threshold ?? LIVE_DEGEN_THRESHOLD,
                });
                if (rep) {
                  // Say "stopped", not "aborted": this is a deliberate
                  // non-transient stop, and the transient-error classifier keys
                  // off words like "aborted" to decide whether to retry.
                  error =
                    `output degenerated into a repeating loop ` +
                    `(${JSON.stringify(rep.unit.slice(0, 40))}×${rep.repeats}) — stopped`;
                  degenerated = true;
                  // Telemetry for tuning thresholds / spotting false positives.
                  await emitAux({
                    type: "degeneration",
                    action: "stopped",
                    unit: rep.unit.slice(0, 40),
                    repeats: rep.repeats,
                    soFarLen,
                  });
                }
              }
              break;
            }
            case "thinking_delta":
              markFirstToken();
              // Reasoning streams live for the UI and is also accumulated so
              // the final assistant `message` can persist a `reasoning` block
              // (transcript / export). It is NOT folded into assistantText —
              // the visible answer / tool calls are what the loop acts on.
              assistantReasoning.push(ev.text);
              await emit({
                type: "message_delta",
                messageId: id,
                delta: { type: "reasoning", text: ev.text },
              });
              break;
            case "tool_input_delta":
              markFirstToken();
              await emit({
                type: "message_delta",
                messageId: id,
                delta: {
                  type: "tool_input_json",
                  toolCallId: ev.toolCallId,
                  partialJson: ev.partialJson,
                },
              });
              break;
            case "tool_call":
              toolCalls.push(ev.toolCall);
              callIds.add(ev.toolCall.id);
              await emit({
                type: "tool_call",
                id: ev.toolCall.id,
                name: ev.toolCall.name,
                input: ev.toolCall.input,
              });
              break;
            case "usage":
              totalUsage = {
                input: (totalUsage.input || 0) + (ev.usage.input ?? 0),
                output: (totalUsage.output || 0) + (ev.usage.output ?? 0),
                cacheRead: (totalUsage.cacheRead || 0) + (ev.usage.cacheRead ?? 0),
                cacheWrite: (totalUsage.cacheWrite || 0) + (ev.usage.cacheWrite ?? 0),
              };
              llmUsage.input += ev.usage.input ?? 0;
              llmUsage.output += ev.usage.output ?? 0;
              llmUsage.cacheRead += ev.usage.cacheRead ?? 0;
              llmUsage.cacheWrite += ev.usage.cacheWrite ?? 0;
              // Prefer the latest request's input size.
              // Do not add cacheRead — providers already include cached tokens
              // in `input` (or report them separately without double-billing).
              if (typeof ev.usage.input === "number" && ev.usage.input > 0) {
                lastInputTokens = ev.usage.input;
              }
              if (deps.onUsage) deps.onUsage({ ...totalUsage });
              await emit({ type: "usage", usage: ev.usage });
              break;
            case "error":
              error = ev.message;
              break;
            case "provider_failover":
              // The fallback chain switched to a backup before any content was
              // produced. Surface it to the host (observational, non-persisted)
              // so a UI can show which provider served the turn and why.
              await emitAux({
                type: "provider_failover",
                from: ev.from,
                to: ev.to,
                reason: ev.reason,
                failureKind: ev.failureKind,
              });
              break;
            case "done":
              finishReason = ev.finishReason;
              break;
          }
          // Mid-stream steer (B1): a user correction arrived mid-turn. If no
          // tool call has started, cut the stream to drain the correction and
          // re-sample keeping the partial text. Once a tool_call is streaming
          // we don't preempt (ambiguous); it lands at post-tool-batch (B2).
          if (
            !steeredMidStream &&
            callIds.size === 0 &&
            toolCalls.length === 0 &&
            deps.peekSteering?.() === true
          ) {
            steeredMidStream = true;
            break;
          }
          // A detected repetition loop ends the stream immediately; the error
          // is surfaced below like any other turn failure.
          if (degenerated) break;
        }
      } catch (err) {
        // User cancel / send-now / mid-stream steer aborts the fetch/SSE —
        // none of these is a turn failure. A steer abort additionally keeps the
        // partial text (handled by the steeredMidStream path below).
        if (deps.signal?.aborted || steerSignal?.aborted || isAbortError(err)) {
          error = null;
          if (steerSignal?.aborted) steeredMidStream = true;
        } else {
          error = (err as Error).message;
          if (llmSpan) tracer.recordError(llmSpan, err as Error);
        }
      }

      // The provider may also have returned cleanly in response to the steer
      // abort (a well-behaved stream stops yielding instead of throwing). Catch
      // that here so the partial text is still salvaged and re-sampled.
      if (!steeredMidStream && steerSignal?.aborted && !deps.signal?.aborted) {
        steeredMidStream = true;
        error = null;
      }

      if (llmSpan) {
        if (error) tracer.recordError(llmSpan, new Error(error));
 // Record usage info gathered from the stream's usage events.
        llmSpan.attributes["codepilot.usage.input"] = llmUsage.input;
        llmSpan.attributes["codepilot.usage.output"] = llmUsage.output;
        llmSpan.attributes["codepilot.usage.cache_read"] = llmUsage.cacheRead;
        llmSpan.attributes["codepilot.usage.cache_write"] = llmUsage.cacheWrite;
        tracer.end(llmSpan);
      }

 // Persist per-request timing so slow turns are diagnosable from the
 // session log (start / end / duration / time-to-first-token / tokens).
      const finishedAt = Date.now();
      await emit({
        type: "request",
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        ...(ttftMs !== undefined ? { ttftMs } : {}),
        model: deps.config.model ?? deps.provider.defaultModel,
        inputTokens: llmUsage.input || undefined,
        outputTokens: llmUsage.output || undefined,
        ok: !error && !deps.signal?.aborted,
      });
      return { error, callIds, steeredMidStream };
    }

    const assistantContent: ContentBlock[] = [];
    if (assistantReasoning.length > 0) {
      assistantContent.push({ type: "reasoning", text: assistantReasoning.join("") });
    }
    if (assistantText.length > 0) {
      assistantContent.push({ type: "text", text: assistantText.join("") });
    }
    for (const tc of toolCalls) {
      assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    const assistantMessage: Event = {
      type: "message",
      id: messageId,
      role: "assistant",
      content: assistantContent,
      model: deps.config.model,
    };
    await emit(assistantMessage);

    if (sawError && !deps.signal?.aborted && !isAbortMessage(sawError)) {
      await emit({ type: "error", message: sawError, recoverable: true });
 // The stream failed mid-turn: any tool calls we did receive may have
 // been parsed from truncated input. Do NOT execute them — end the run
 // and let the caller (or the next user message) retry cleanly.
      if (toolCalls.length > 0) {
        await emit({ type: "status", status: "idle" });
        return {
          events: produced,
          hadToolCalls: sawToolCalls,
          finalText: assistantText.join(""),
          reachedTurnBudget,
        };
      }
    }
    if (deps.signal?.aborted || (sawError && isAbortMessage(sawError))) {
      await emit({ type: "status", status: "idle" });
      return {
        events: produced,
        hadToolCalls: sawToolCalls,
        finalText: assistantText.join(""),
        reachedTurnBudget,
      };
    }

 // Fire the token-estimate hook so the session layer can decide
 // whether to compact or write a checkpoint. We do this in addition
 // to the per-prompt postlude so very long single-prompt runs (many
 // tool calls within one user message) can still react.
    emitTokenEstimateIfNeeded(deps, input, produced, turn);

    // A mid-stream interrupt was salvaged for continuation: the partial text is
    // now persisted (assistant message above) and `pendingProviderResume` is
    // set to INTERRUPT_RESUME. Carry the partial into `resumedText` (so it
    // prefixes the final answer) and re-enter the outer turn loop to continue —
    // same shape as a truncation resume, but triggered by a dropped connection.
    if (interruptedForResume) {
      interruptedForResume = false;
      resumedText += assistantText.join("");
      continue;
    }

    // Mid-stream steer (B1): the partial text is persisted as its own assistant
    // message; re-enter the turn loop so B0 drain turns the queued steer into a
    // user message and the model samples a fresh response. Nothing was executed
    // (peek guard), and the partial is NOT folded into resumedText.
    if (steeredMidStream) {
      continue;
    }

    const truncated = !sawError && (finishReason === "length" || finishReason === "max_tokens");
    truncatedInARow = truncated ? truncatedInARow + 1 : 0;
    if (truncated && toolCalls.length === 0 && truncatedInARow <= MAX_TRUNCATION_RESUMES) {
      resumedText += assistantText.join("");
      pendingProviderResume = TRUNCATION_RESUME;
      continue;
    }

    if (toolCalls.length === 0) {
      const finalText = resumedText + assistantText.join("");
      const trimmed = finalText.trim();
      const allEvents = [...input.history, ...produced];

      // Empty successful stop: clean finish (stop, no error, no tool calls) but
      // no visible text — either a missing closing summary after tools or a
      // zero-content completion. Retry (bounded) asking the model to respond
      // rather than yield a silent blank reply.
      if (
        !sawError &&
        trimmed === "" &&
        emptyStopResumes < MAX_EMPTY_STOP_RESUMES
      ) {
        emptyStopResumes++;
        pendingProviderResume = EMPTY_STOP_RESUME;
        continue;
      }

      // The model wrote a tool call as text markup instead of making a real
      // one (nothing executed). Nudge it back to the structured channel,
      // bounded so a model that cannot emit structured calls can't loop.
      if (
        !sawError &&
        pseudoToolResumes < MAX_PSEUDO_TOOL_RESUMES &&
        looksLikePseudoToolCall(trimmed)
      ) {
        pseudoToolResumes++;
        pendingProviderResume = PSEUDO_TOOL_CALL_RESUME;
        continue;
      }

      // Unfinished plan + incomplete-intent prose (not asking the user): one nudge.
      if (
        sawToolCalls &&
        !sawError &&
        planSoftResumes < MAX_PLAN_SOFT_RESUMES &&
        hasUnfinishedPlan(allEvents) &&
        !isWaitingForUser(trimmed) &&
        looksLikeIncompleteTurn(trimmed)
      ) {
        planSoftResumes++;
        pendingProviderResume = PLAN_SOFT_RESUME;
        continue;
      }

      // Normal conversational end: yield the turn to the user.
      if (!sawError) await closeFinishedPlan(produced, emit);
      // Offer this turn's exact request as a prompt-cache warm candidate. The
      // session decides (cost-gated) whether to keep the cached prefix alive
      // during the idle gap by replaying it with a 1-token output cap. We
      // capture the SAME messages/tools/system just streamed — a faithful,
      // drift-free replay — and never fire it ourselves.
      if (deps.onWarmableRequest && !sawError && lastInputTokens > 0) {
        const warmMessages = sendMessages;
        const warmTools = providerTools;
        const warmContext = liveContext;
        deps.onWarmableRequest({
          prefixTokens: lastInputTokens,
          replay: async (signal: AbortSignal): Promise<void> => {
            const warmDeps: AgentDeps = {
              ...deps,
              signal,
              config: { ...deps.config, maxTokens: 1 },
            };
            // Drain the stream; a 1-token reply is enough to refresh the cache.
            for await (const _ of streamOnce(
              deps.provider,
              warmDeps,
              warmMessages,
              warmTools,
              `warm_${randomUUID()}`,
              { liveContext: warmContext },
            )) {
              if (signal.aborted) break;
            }
          },
        });
      }
      await emit({ type: "status", status: "idle" });
      return {
        events: produced,
        hadToolCalls: sawToolCalls,
        finalText,
        reachedTurnBudget,
      };
    }
    resumedText = "";
    sawToolCalls = true;

 // Run tools with a read/write concurrency barrier: read-only and network
 // tools run concurrently; mutating tools are serialized (the mtime/size CAS
 // only covers staleness across turns, not two in-flight writes in one turn).
 // Results are collected in the model's original call order.
    await emitAux({ type: "activity", phase: "tools", since: Date.now(), tools: toolCalls.map((tc) => tc.name) });
    const runCall = (tc: ToolUseBlock): Promise<ToolExecResult> =>
      hasUnparsedInput(tc)
        ? Promise.resolve<ToolExecResult>({ content: truncated ? TRUNCATED_CALL : MALFORMED_CALL, isError: true })
        : runOneTool(tc, deps, emit, agentMode, doomLoop);
    const toolResults = await runToolsWithBarrier(
      toolCalls,
      (tc) => isParallelSafeTool(deps.tools.get(tc.name)?.permission),
      runCall,
    );
    const planOnlyTurn = toolCalls.every((tc) => tc.name === "plan_update");
    // "Deny & stop": a permission handler aborted the turn. The denied results
    // are still recorded below so the transcript shows what was refused, then
    // the loop ends cleanly (no further model turns, no fake user message).
    const abortedByPermission = toolResults.some((r) => r.aborted);
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const r = toolResults[i]!;
 // Durable-progress signal for the no-progress stall ladder: a SUCCESSFUL
 // write-permission tool (write_file/edit_file/apply_patch/…), or a task
 // conclusion / memory_write (both read-permission but state-changing).
 // Failed calls do not count — a rejected edit is not progress. Plan advances
 // are handled separately where the plan event is parsed.
      if (!r.isError) {
        const perm = deps.tools.get(tc.name)?.permission;
        if (perm === "write" || DURABLE_PROGRESS_TOOLS.has(tc.name)) {
          madeDurableProgress = true;
        }
      }
 // Exploration-progress signal (read-only analogue). A durable write already
 // counts as progress above; this only matters for turns with no write, where
 // "did we learn something new" is the honest progress question.
      if (isNewReadEvidence(tc.name, r, seenReadCommandSigs, tc.input)) {
        madeExplorationProgress = true;
      }
 // Consecutive-failure tally. A permission abort is the user's decision, not a
 // model-fixable tool failure, so it is excluded from both counts.
      if (!r.aborted) {
        if (r.isError) turnToolFailures++;
        else turnToolSuccesses++;
      }
 // Secret redaction: credentials must never reach the transcript, the
 // model context or artifacts (see redact.ts).
      let safeContent = redactSecrets(r.content, deps.redactPatterns);
      if (planOnlyTurn && !r.isError) safeContent += PLAN_ONLY_TURN;
 // Fold-safety net: any result big enough to be folded later but without an
 // artifactRef gets one now, so a fold stub always carries a way back to the
 // full text (otherwise the model re-reads the target). Skip results already
 // carrying a dedup prefix — persisting the banner would poison read_artifact.
      let artifactRef = r.artifactRef;
      if (
        !artifactRef &&
        !r.isError &&
        safeContent.length > 400 &&
        !safeContent.startsWith("[dedup:")
      ) {
        try {
          artifactRef = await deps.artifacts.write(safeContent, `tool_result:${tc.name}`);
        } catch {
 /* artifact write is best-effort; the transcript keeps full text */
        }
      }
      await emit({
        type: "tool_result",
        toolCallId: tc.id,
        name: tc.name,
        content: safeContent,
        isError: r.isError,
        artifactRef,
        images: r.images,
      });
    }

 // Plan updates are picked up here: if any tool returned a plan block
 // (currently only plan_update), surface it as a `plan` event. The
 // exit_plan_mode signal from plan_done becomes a `mode_request` event
 // that the session turns into a mode switch.
    for (let i = 0; i < toolCalls.length; i++) {
      const r = toolResults[i]!;
      if (r.blocks) {
        for (const b of r.blocks) {
          if (b.type === "text") {
            try {
              const parsed = JSON.parse(b.text) as {
                type: string;
                steps?: unknown;
                approved?: boolean;
                mode?: AgentMode;
                reason?: string;
                rememberAuto?: boolean;
                objective?: string;
                maxRounds?: number;
                status?: string;
              };
              if (parsed.type === "plan" && Array.isArray(parsed.steps)) {
                const steps = parsed.steps as { id: string; status?: string }[];
                await emit({
                  type: "plan",
                  steps: parsed.steps as never,
                });
 // Update progress tracking. The signature counts completed
 // and in_progress steps; if it changed, the plan advanced.
                const done = steps.filter((s) => s.status === "completed" || s.status === "in_progress").length;
                const sig = `${steps.length}:${done}`;
                if (sig !== planProgressSig) {
                  planProgressSig = sig;
                  turnsSincePlanProgress = 0;
 // The plan moved — clear any pending stall notice so the
 // next turn's context doesn't keep nagging.
                  planStalled = false;
 // A plan advance is durable progress for the no-progress ladder.
                  madeDurableProgress = true;
                }
              } else if (parsed.type === "exit_plan_mode" && parsed.approved === true) {
                await emit({
                  type: "mode_request",
                  mode: "agent",
                  reason: "plan approved via plan_done",
                });
              } else if (
                parsed.type === "mode_request" &&
                (parsed.mode === "chat" || parsed.mode === "plan" || parsed.mode === "agent")
              ) {
                // suggest_mode accepted (by the user or auto-accept) → switch,
                // via the same mode_request channel plan_done uses.
                await emit({
                  type: "mode_request",
                  mode: parsed.mode,
                  reason: parsed.reason ?? "suggested by the model",
                  ...(parsed.rememberAuto ? { rememberAuto: true } : {}),
                });
              } else if (
                parsed.type === "goal_request" &&
                typeof parsed.objective === "string" &&
                parsed.objective.length > 0
              ) {
                // start_goal: the model escalated the task to a long-horizon
                // goal loop. Surface the request; the host drives rounds.
                await emit({
                  type: "goal_request",
                  objective: parsed.objective,
                  ...(typeof parsed.maxRounds === "number" ? { maxRounds: parsed.maxRounds } : {}),
                  ...(parsed.reason ? { reason: parsed.reason } : {}),
                });
              } else if (
                parsed.type === "goal_status" &&
                (parsed.status === "completed" || parsed.status === "blocked")
              ) {
                // goal_status: the model reported the goal's terminal state via
                // the structured tool. Surface it as a goal_status event the
                // goal loop reads ahead of the text markers.
                await emit({
                  type: "goal_status",
                  status: parsed.status,
                  ...(parsed.reason ? { reason: parsed.reason } : {}),
                });
              }
            } catch {
 /* not JSON; ignore */
            }
          }
        }
      }
    }

 // Plan-stall accounting: if this turn ran tools but the plan signature
 // didn't change, the work didn't move the plan forward.
    if (toolCalls.length > 0 && planProgressSig === planSigBefore && planProgressSig !== "") {
      turnsSincePlanProgress++;
    }
 // Reworded-spin guard shared by both ladders: reading a fresh file while
 // restating the previous turn's plan near-verbatim ("next I'll check X") is
 // not real progress, so a high-similarity intent cancels the exploration
 // reset. Computed once per turn.
    const turnIntent = assistantText.join("").trim();
    const rewordedSpin =
      turnIntent !== "" &&
      priorIntentText !== "" &&
      questionSimilarity(turnIntent, priorIntentText) >= QUESTION_SIMILARITY_THRESHOLD;
 // Genuine exploration progress = new read-only evidence that is not reworded
 // spinning. Treated as progress by BOTH ladders: a pure investigation makes
 // no writes, so without this the write ladder (8/12/16) would wind down a
 // debug session that is still turning up facts. The wider exploration ladder
 // (12/18/24) is the real backstop that still stops a read-only run eventually.
    const exploringForward = madeExplorationProgress && !rewordedSpin;
 // Progress-gated stall accounting: a turn that made durable progress (or is
 // exploring forward) resets the streak; a turn that ran tools without either
 // extends it. A turn with no tool calls at all is not counted (the model is
 // answering).
    if (madeDurableProgress || exploringForward) {
      turnsSinceNoProgress = 0;
    } else if (toolCalls.length > 0) {
      turnsSinceNoProgress++;
    }
 // Exploration-stall accounting: only a durable write fully resets this wider
 // track. Exploring forward does NOT reset it — it only avoids the write
 // ladder above — so a session that keeps finding "new" reads forever still
 // climbs to the exploration lock and is made to synthesize.
    if (madeDurableProgress) {
      turnsSinceNoExploration = 0;
    } else if (toolCalls.length > 0) {
      turnsSinceNoExploration++;
    }
    if (turnIntent !== "") priorIntentText = turnIntent;
 // Consecutive-failure accounting. A turn that ran tools and had at least one
 // succeed resets the streak; a turn whose every executed (non-aborted) call
 // errored extends it. A turn that ran no tools is neutral (the model is
 // thinking/answering, not failing). This is independent of the progress
 // ladders: those ask "did state change / did we learn something"; this asks
 // "are the attempts even landing".
    if (turnToolSuccesses > 0) {
      consecutiveFailureTurns = 0;
    } else if (turnToolFailures > 0) {
      consecutiveFailureTurns++;
    }
    // "Deny & stop" ends the prompt cleanly after this turn's results are
    // recorded — like a user Stop, but the session is not cleared.
    if (abortedByPermission) break;
  }

  // Turn-cap stops: main-session runs surface a recoverable error so the UI
  // isn't a silent idle. Sub-agents do NOT — they already got wind-down + a
  // synthesis bonus turn; assessSubagentOutcome uses whatever conclusion text
  // was produced. Emitting an error here made parents treat soft landings as
  // failures ("Reached the sub-agent step budget").
  if (hitMaxTurns && deps.isSubagent !== true) {
    // Distinguish which ceiling actually stopped the run so the guidance is
    // accurate: a user-set maxTurns is raised in config, whereas the
    // convergence backstop fired because the model kept calling tools even
    // after tools were disabled for wind-down.
    const stoppedByMaxTurns = Number.isFinite(maxTurns) && maxTurns <= convergenceCap;
    const cap = stoppedByMaxTurns
      ? Number.isFinite(maxTurns)
        ? String(maxTurns)
        : String(configuredMax)
      : String(convergenceCap);
    await emit({
      type: "error",
      message: stoppedByMaxTurns
        ? `Reached maxTurns (${cap}): the model was still calling tools, so the run ` +
          `stopped before finishing. Send another message to continue the conversation, ` +
          `or raise/remove maxTurns in config for long tasks.`
        : `Reached the convergence limit (${cap} turns): the model kept calling tools ` +
          `instead of answering, so the run stopped. Send another message to continue, ` +
          `or raise/disable convergenceCap in config for genuinely long tasks.`,
      recoverable: true,
    });
  }
  // Intentional cancel (Stop): go idle quietly — do not emit an error row
  // ("Something went wrong" / AbortError). Follow-ups inject via steer;
  // the queue still drains from session.prompt's finally when a run ends.

  await emit({ type: "status", status: "idle" });
  return {
    events: produced,
    hadToolCalls: sawToolCalls,
    finalText: "",
    reachedTurnBudget,
  };
}

/** True when a thrown value is a user/system abort (DOMException or Node). */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string; code?: string };
  if (e.name === "AbortError") return true;
  if (e.code === "ABORT_ERR") return true;
  return isAbortMessage(e.message ?? "");
}

/** Match AbortError messages across runtimes (Node undici / browsers). */
export function isAbortMessage(message: string): boolean {
  return (
    /this operation was aborted/i.test(message) ||
    /^aborted$/i.test(message.trim()) ||
    /the operation was aborted/i.test(message)
  );
}

/**
 * Whether a tool can run concurrently with others in the same turn. Read-only
 * and network tools parallelize; write/execute tools serialize. Fail-closed:
 * unknown permission is NOT parallel-safe.
 */
export function isParallelSafeTool(permission: PermissionLevel | undefined): boolean {
  return permission === "read" || permission === "network";
}

/**
 * Execute a turn's tool calls with a read/write concurrency barrier, returning
 * results in original call order. Adjacent parallel-safe calls run concurrently;
 * mutating calls run exclusively. Reads parallelize, writes serialize.
 */
export async function runToolsWithBarrier<T>(
  calls: readonly T[],
  isParallelSafe: (call: T) => boolean,
  run: (call: T) => Promise<ToolExecResult>,
): Promise<ToolExecResult[]> {
  const results = new Array<ToolExecResult>(calls.length);
  let i = 0;
  while (i < calls.length) {
    if (isParallelSafe(calls[i]!)) {
      // Gather the maximal run of adjacent parallel-safe calls and run them
      // together; a mutating call (or the end) closes the batch.
      const start = i;
      while (i < calls.length && isParallelSafe(calls[i]!)) i++;
      const batch = await Promise.all(calls.slice(start, i).map((c) => run(c)));
      for (let j = 0; j < batch.length; j++) results[start + j] = batch[j]!;
    } else {
      // Exclusive: nothing else runs while this mutating call is in flight.
      results[i] = await run(calls[i]!);
      i++;
    }
  }
  return results;
}

/** Soft convergence ceiling: when neither maxTurns nor config.convergenceCap is
 * set, the loop winds down after this many turns and disables tool calls for
 * the final turn. Backstop against semantic looping the exact-signature
 * DoomLoopDetector can't catch. */
const DEFAULT_CONVERGENCE_CAP = 60;
/** Turns of slack between where wind-down starts (tools disabled + synthesis
 * urge) and the absolute hard break. Gives the model room to actually write its
 * answer after tools are locked, while still guaranteeing termination if a
 * provider ignores `toolChoice:"none"`. */
const CONVERGENCE_HARD_SLACK = 3;
/** Turns before the governing ceiling at which the "turns left" nudge fires
 * (and a `turn_budget` warning is surfaced to the host). */
const DEFAULT_REMAINING_NUDGE_AT = 2;

/** Progress-gated stall ladder. Catches models calling read-only/variant tools
 * turn after turn without changing durable state (textually different, so the
 * doom loop / plan-stall don't fire). Escalate: soft nudge → stronger nudge →
 * wind-down path. A later turn with real progress resets the streak. */
const NO_PROGRESS_SOFT_TURNS = 8;
const NO_PROGRESS_STRONG_TURNS = 12;
const NO_PROGRESS_LOCK_TURNS = 16;

/** Exploration-stall ladder — the read-only analogue of the no-progress ladder,
 * for investigations (debugging, code reading) that legitimately never write.
 * Deliberately wider than the write ladder because reading toward a root cause
 * takes more turns than editing, but still terminates: a turn that surfaces no
 * NEW evidence (only re-reads the same ground) extends the streak, and the lock
 * tier reuses the same wind-down backstop as the write ladder. */
const NO_EXPLORATION_SOFT_TURNS = 12;
const NO_EXPLORATION_STRONG_TURNS = 18;
const NO_EXPLORATION_LOCK_TURNS = 24;

/** Consecutive all-error turns before the failure notice fires. Orthogonal to
 * the progress ladders: it catches a run whose attempts keep erroring (not a
 * slow-progress spin), and steers toward a different approach or an honest
 * blocker report. Mirrors the common "3 consecutive execution failures is a
 * blocker" heuristic; it nudges rather than locks, since a different operation
 * may still succeed. */
const CONSECUTIVE_FAILURE_NOTICE_TURNS = 3;

/** Read-only tools whose repeated calls are evaluated for "new evidence". A
 * fresh read / first-seen grep hit / not-before-run command resets the
 * exploration streak; a cached-replay read or a re-hit of known paths does not.
 * `bash`/`lsp_navigate` are read-ish here only for the evidence signal — they
 * are NOT treated as durable progress. */
const EXPLORATION_READ_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "ls",
  "bash",
  "lsp_navigate",
]);

/** Tools (by name) whose successful call counts as durable progress even though
 * their permission is "read": `task` delivers a sub-agent conclusion and
 * `memory_write` commits durable knowledge. Write-permission tools (write_file,
 * edit_file, apply_patch, notebook_edit, …) are detected by permission, not
 * name, so this list stays small. */
const DURABLE_PROGRESS_TOOLS = new Set(["task", "memory_write"]);

/**
 * Whether a successful read-only tool result is NEW evidence (fresh ground) vs
 * a repeat of what the investigation already saw. Drives the exploration-stall
 * track so a genuine debug session (which never writes) is not wound down while
 * it keeps turning up new facts, yet a model re-reading the same files/windows
 * in circles still converges.
 *
 * - read_file / grep / glob / ls (dedupable): the tool layer serves a repeated
 *   identical call from the dedup cache and stamps a `[dedup:` prefix, so a
 *   result WITHOUT that prefix is a first-time read → new evidence. A varied
 *   call (new pattern / new window past the overlap threshold) also misses the
 *   cache and so counts, which is correct — it is a new probe.
 * - bash / lsp_navigate (not dedupable): judged by command signature — a repeat
 *   with identical args is not new evidence; a non-empty first run is. Mutating
 *   the set is the caller's job (so a repeat within the SAME turn still counts
 *   once), hence `seen` is passed in.
 * - Empty output is never new evidence.
 */
function isNewReadEvidence(
  toolName: string,
  result: ToolExecResult,
  seenReadCommandSigs: Set<string>,
  input: unknown,
): boolean {
  if (result.isError) return false;
  if (!EXPLORATION_READ_TOOLS.has(toolName)) return false;
  const body = result.content ?? "";
  if (body.trim() === "") return false;
  // Dedupable reads: a cache replay prefix means we have seen this exact ground.
  if (toolName === "read_file" || toolName === "grep" || toolName === "glob" || toolName === "ls") {
    return !body.startsWith("[dedup:");
  }
  // bash / lsp_navigate: signature-based first-run check.
  const sig = toolSignature(toolName, input);
  if (seenReadCommandSigs.has(sig)) return false;
  seenReadCommandSigs.add(sig);
  return true;
}

const MAX_TRUNCATION_RESUMES = 3;
/** Max consecutive mid-stream interrupts resumed by continuation before we
 * give up on continuing and fall back to regenerating the turn. */
const MAX_INTERRUPT_RESUMES = 3;
const MAX_EMPTY_STOP_RESUMES = 2;
const MAX_PLAN_SOFT_RESUMES = 1;
/** The model wrote a tool call as text markup instead of a real call. Nudge it
 * back to the structured channel a bounded number of times, then stop so a
 * model that simply cannot emit structured calls can't loop forever. */
const MAX_PSEUDO_TOOL_RESUMES = 2;
/** Proportional send-budget shrink steps applied on successive context-overflow
 * errors: first compact, then shrink to these fractions of the computed hard
 * budget. Bounded so overflow can't loop. */
const OVERFLOW_SHRINK_STEPS = [0.6, 0.4, 0.25];

/** Payload-too-large (byte/size) recovery shrink the SEND budget harder and
 * drop inline images / fold every tool result. Distinct from the token-overflow
 * ladder: a size rejection is not fixed by compacting the transcript's tokens,
 * only by shrinking the request body. Bounded so it can't loop. */
const PAYLOAD_SHRINK_STEPS = [0.5, 0.3, 0.2];

const TRUNCATION_RESUME =
  "[system] Your previous reply was cut off by the output-token limit. Continue exactly where it " +
  "stopped — don't repeat what you already wrote. If you were about to call a tool with a large " +
  "argument, split the work into smaller calls.";

const INTERRUPT_RESUME =
  "[system] The connection dropped mid-response, so your previous reply was cut off partway. The " +
  "text you had already produced is preserved above. Continue exactly where it stopped — do NOT " +
  "repeat what you already wrote, and do NOT restart the task from the beginning.";

const EMPTY_STOP_RESUME =
  "[system] Your previous response ended successfully but contained no visible text. Respond to " +
  "the user now: continue the task from its current state without repeating completed work — call " +
  "tools if you still have autonomous work, otherwise write a short status or answer for the user.";

const PLAN_SOFT_RESUME =
  "[system] Your plan still has unfinished steps, and your last reply looked incomplete. " +
  "Resume at the first unfinished step — do not repeat completed work. Keep calling tools until " +
  "the step's deliverable is done, or ask the user a clear question if you are blocked.";

const PSEUDO_TOOL_CALL_RESUME =
  "[system] Your last reply wrote a tool call as text markup (e.g. <tool_call> / <invoke> / " +
  "<arg_key> / <parameter>) instead of making a real tool call. Text like that is NOT executed — " +
  "it was shown to the user verbatim and nothing ran. Use the structured tool-calling channel: " +
  "issue the tool call through the function/tool interface, never by writing XML/markup in your " +
  "reply. Re-issue the call now.";

const TRUNCATED_CALL =
  "This tool call was cut off by the output-token limit before its arguments were complete, so it " +
  "was NOT executed. Re-issue it with smaller arguments — e.g. write a large file in several parts " +
  "(write_file for the first part, then edit_file / apply_patch to append the rest).";

const PLAN_ONLY_TURN =
  "\n\nNote: this response contained only plan_update, which cost a full extra request. Next " +
  "time, send plan_update in the same response as the tool calls for the step you're starting.";

const MALFORMED_CALL =
  "This tool call's arguments were not valid JSON, so it was NOT executed. Re-issue it with " +
  "well-formed JSON arguments.";

/** Latest plan still has pending or in_progress steps. */
export function hasUnfinishedPlan(events: Event[]): boolean {
  const plan = extractPlan(events);
  if (!plan || plan.length === 0) return false;
  return plan.some((s) => s.status === "pending" || s.status === "in_progress");
}

/** Assistant text that clearly hands the floor to the user. */
export function isWaitingForUser(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[?？]\s*$/.test(t)) return true;
  return (
    /请确认|请选择|请告诉我|请回复|等你|等您|waiting (for|on) (your|you)|let me know|should I\b|do you want|would you like|your (choice|preference|call)/i.test(
      t
    )
  );
}

/** Soft-stop prose: model announced more work but emitted no tool calls. */
export function looksLikeIncompleteTurn(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (
    /\b(next[,:]?\s+I(?:'ll| will)|I(?:'ll| will)\s+(now|next|continue|proceed)|moving on to|now I(?:'ll| will)|let me (now |next )?)/i.test(
      t
    )
  ) {
    return true;
  }
  return /接下来|下一步我|然后我(?:将|会)|我接着|继续(?:完成|处理|实现)/.test(t);
}

/** Providers hand back `{ __raw }` when a tool call's JSON didn't parse. */
function hasUnparsedInput(tc: ToolUseBlock): boolean {
  const input = tc.input as Record<string, unknown> | null;
  return !!input && typeof input === "object" && "__raw" in input && Object.keys(input).length === 1;
}

/**
 * Detect when the model wrote a tool call as markup into its reply text instead
 * of a real structured call. We (bounded) nudge it back to the tool channel; we
 * do NOT parse and run the markup. Targets invocation markup specifically.
 */
export function looksLikePseudoToolCall(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    /<\s*tool_call\b/i.test(t) ||
    /<\s*function_calls\b/i.test(t) ||
    /<\s*invoke\b[^>]*\bname\s*=/i.test(t) ||
    /<\s*arg_key\s*>/i.test(t) ||
    /<\s*parameter\b[^>]*\bname\s*=/i.test(t) ||
    /<\s*antml:/i.test(t)
  );
}



/** Whether a provider error means "the prompt is too long for the context
 * window" — recoverable by compacting and retrying, unlike a transient
 * network error. Matches the common phrasings
 * across OpenAI / Anthropic / gateways. */
export function isContextOverflowError(message: string): boolean {
  return /context[_ ]length|maximum context|too (?:long|many tokens)|exceeds? the (?:model'?s )?(?:maximum )?context|prompt is too long|reduce the length|input length|context window (?:exceeded|too)/i.test(
    message,
  );
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Per-turn context the model needs fresh every turn: the CURRENT plan and a
 * ledger of calls already made (old tool output gets folded away during long
 * runs). `systemNotices` are engine-generated, out-of-band, never spoofable.
 */
export function buildLiveContext(
  all: Event[],
  produced: Event[],
  opts: { planStalled?: boolean; systemNotices?: string[]; relevantMemories?: string } = {},
): string {
  const parts: string[] = [];
  const planBlock = renderPlanBlock(extractPlan(all));
  if (planBlock) parts.push(planBlock);
  const ledger = buildProgressLedger(produced);
  if (ledger) parts.push(ledger);
  if (opts.planStalled) parts.push(PLAN_STALL_NOTICE);
  if (opts.relevantMemories && opts.relevantMemories.trim().length > 0) {
    parts.push(opts.relevantMemories.trim());
  }
  for (const notice of opts.systemNotices ?? []) {
    parts.push(`<system_notice>\n${notice}\n</system_notice>`);
  }
  return parts.join("\n\n");
}

/** Reminder surfaced (via runtime_context, not the transcript) when the plan
 * hasn't advanced for several tool-calling turns. */
const PLAN_STALL_NOTICE = `<plan_stall>
You've called tools for several turns without advancing your plan. You likely have enough information — stop exploring and move on: mark the current plan step complete, start the next one, or produce the synthesis/output the task asks for. If you're stuck, summarize what you've learned so far and say what's blocking you.
</plan_stall>`;

const LEDGER_MAX_LINES = 40;

export function buildProgressLedger(events: Event[]): string {
  const results = new Map<string, { isError: boolean }>();
  for (const e of events) {
    if (e.type === "tool_result") results.set(e.toolCallId, { isError: e.isError === true });
  }
  const rows = new Map<string, { count: number; ok: number; failed: number }>();
  for (const e of events) {
    if (e.type !== "tool_call" || e.name === "plan_update") continue;
    const r = results.get(e.id);
    if (!r) continue;
    const key = describeCall(e.name, e.input);
    const row = rows.get(key) ?? { count: 0, ok: 0, failed: 0 };
    row.count++;
    if (r.isError) row.failed++;
    else row.ok++;
    rows.delete(key); // re-insert so the most recent calls sort last
    rows.set(key, row);
  }
  if (rows.size === 0) return "";
  const lines = [...rows.entries()].slice(-LEDGER_MAX_LINES).map(([key, row]) => {
    const status = row.failed === 0 ? "ok" : row.ok === 0 ? "failed" : `${row.ok} ok / ${row.failed} failed`;
    return `- ${key} — ${status}${row.count > 1 ? ` (×${row.count})` : ""}`;
  });
  const omitted = rows.size > LEDGER_MAX_LINES ? `\n(${rows.size - LEDGER_MAX_LINES} earlier calls omitted)` : "";
  return `<progress>
Tool calls you already made for the current request; their results are in the conversation above (possibly folded). Do not repeat one unless its inputs or the files it depends on changed since — build on the results instead.${omitted}
${lines.join("\n")}
</progress>`;
}

function describeCall(name: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const k of ["command", "path", "file_path", "pattern", "url", "query", "objective", "description", "ref"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") {
      const one = v.replace(/\s+/g, " ").trim();
      return `${name} ${one.length > 90 ? `${one.slice(0, 90)}…` : one}`;
    }
  }
  return name;
}
