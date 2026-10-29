// Agent loop. Streams from the ChatProvider, parses tool calls, runs the
// permission check, executes tools in parallel, appends tool_results, and
// loops until the model emits no more tool calls (or is cancelled).
//
// Module layout:
// agent.ts — this file: types + runAgent turn loop
// agent-messages.ts — buildProviderMessages / compactTranscriptToProviderMessages
// / buildProviderToolDefs / streamOnce
// agent-tools.ts — runOneTool (permission + hooks + doom-loop + Zod)
// + emitTokenEstimateIfNeeded

import { randomUUID } from "node:crypto";
import type {
  ChatProvider,
  ProviderMessage,
  ProviderToolDef,
  StreamChatOptions,
} from "./providers/types.js";
import { ToolRegistry } from "./tools/types.js";
import type { ArtifactStore } from "./tools/artifacts.js";
import { PermissionEngine } from "./permissions.js";
import type {
  AgentMode,
  CodepilotConfig,
  ContentBlock,
  Event,
  ImageAttachment,
  PermissionDecision,
  PermissionRequest,
  QuestionAnswers,
  QuestionRequest,
  ToolUseBlock,
} from "./types.js";
import type { ResolvedSandbox } from "./sandbox.js";
import type { HookEngine } from "./hooks.js";
import { redactSecrets } from "./redact.js";
import { DoomLoopDetector, type DedupCache } from "./doomLoop.js";
import { consistencyAssertEnabled, assertConsistency } from "./consistency.js";
import { detectRunawayRepetition } from "./textDegeneration.js";
import { getTracer, type Span } from "./telemetry.js";
import {
  buildProviderMessages,
  buildProviderToolDefs,
  streamOnce,
} from "./agent-messages.js";
import {
  runOneTool,
  emitTokenEstimateIfNeeded,
  type ToolExecResult,
} from "./agent-tools.js";
import { estimateEventTokens, extractPlan, usageSignalsCompact, HARD_TRIM_RATIO } from "./compaction.js";
// Message-based transient classifier (shared SoT). Re-exported below for
// existing `from "./agent.js"` callers.
import { isTransientError } from "./transientError.js";
export { isTransientError } from "./transientError.js";
import { checkCitations, buildCitationNotice } from "./citationGuard.js";
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
 /**
 * Called after every assistant turn with the running session-level token
 * estimate. The estimate is produced by the segmented estimator in
 * `./tokens.js` and is meant to drive decisions like "should we
 * checkpoint now?" rather than match a specific provider's BPE table.
 * Optional — when omitted the agent runs unchanged.
 */
  onTokenEstimate?: (estimate: { tokens: number; turns: number; window: number }) => void;
  /**
   * Mid-run context compaction: called before a provider turn when the live
   * transcript approaches the model window. Should compact the session's
   * authoritative event list and return the new live transcript so the agent
   * can resync `history` / `produced`. Return `null` when nothing changed.
   */
  compactNow?: () => Promise<Event[] | null>;
 /** Stable per-session cache-affinity key (→ OpenAI `prompt_cache_key`). */
  promptCacheKey?: string;
 /** Provider-enforced structured output for this run (OpenAI/Azure
  * `json_schema`). Threaded into every provider stream call. Callers set it
  * only when the provider supports it AND the run is a single structured
  * completion — some models reject it combined with tool-calling. */
  responseFormat?: StreamChatOptions["responseFormat"];
 /** Permission request handler. */
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
 /** Maximum number of assistant turns per prompt. */
  maxTurns?: number;
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
 * genuine human input and are injected into the transcript as user messages;
 * `system` items are engine-generated notices (background-job completion,
 * etc.) and are surfaced via the per-turn runtime_context instead, so they
 * can never be mistaken for — or spoof — user input. Lets a host queue
 * mid-run guidance without cancelling the run.
 */
  drainSteering?: () => Array<{ source: "user" | "system"; text: string }>;
 /**
 * Collaboration mode. Filters the tool table sent to the
 * provider. Defaults to "agent" (no filtering).
 */
  agentMode?: AgentMode;
 /**
 * Optional parent telemetry span (the `codepilot.prompt` span created by
 * session.prompt). Child spans (`codepilot.llm_call`, `codepilot.tool_call`,
 * `codepilot.permission_request`) link to it. Unused when telemetry is
 * disabled — all span creation is gated on `tracer.enabled`.
 */
  parentSpan?: Span;
  /**
   * Last single-request provider input size from a prior turn/prompt.
   * Seeds mid-run pressure detection so the first request of a new prompt
   * does not re-send an already-oversize transcript.
   */
  lastProviderInputTokens?: number;
  /**
   * Session-scoped file-observation store (read-before-write + staleness
   * guard). When supplied, read_file records observations and write/edit
   * tools assert freshness before mutating. Omitted in tests/sub-agents,
   * where tools fall back to their prior (unguarded) behaviour.
   */
  fileObservations?: import("./fsObservation.js").FileObservationStore;
}

export interface AgentRunInput {
 /** Existing transcript (from session resume) — newest first OR oldest first? Oldest. */
  history: Event[];
  userText: string;
  images?: ImageAttachment[];
 /** Files already written under the workspace for this prompt. */
  files?: import("./types.js").SavedUpload[];
  /**
   * Stop-hook / stopVerify continue feedback. Sent to the model as a
   * provider-only resume (same channel as truncation resume) and never
   * persisted as a `role: user` transcript event — so the UI does not show
   * a fake user bubble for `<stop_hook_continue>…`.
   */
  systemContinue?: string;
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
 * Convenience for a normal conversational close: models often deliver the
 * plan's last step as their final text reply (no tool call left to mark it
 * completed). When the turn ends with no pending steps, close leftover
 * in_progress steps from this run. Soft stops with remaining pending work
 * are left alone so the next user message can continue the conversation.
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
  const agentMode: AgentMode = deps.agentMode ?? "agent";
  const produced: Event[] = [];
  const doomLoop = new DoomLoopDetector(deps.dedupCache);
 // Plan-progress tracking: if the model keeps calling tools but the plan
 // never advances (no step moves to completed/in_progress), it's spinning.
 // After PLAN_STALL_TURNS turns of no progress we surface a stall notice via
 // the live runtime_context (NOT as a fake user message — that pollutes the
 // persisted transcript and misleads anyone replaying the session).
  let planProgressSig = "";
  let turnsSincePlanProgress = 0;
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
  const hardBudget = Math.max(
    4_000,
    contextWindow - systemReserve - outputReserve - 1_024,
  );
  // Auto-compact trigger (~92% of window by default), never above hardBudget.
  const autoTrigger = Math.min(
    hardBudget,
    Math.floor(contextWindow * (deps.config.compactionThreshold ?? 0.92)),
  );
  // Soft fold target for speed (default 48K); still capped by hardBudget.
  const softBudget = deps.config.maxContextTokens ?? 48_000;
  const contextBudget = Math.max(8_000, Math.min(hardBudget, softBudget));
  // Rolling tool-output window: fold old tool_results down to this many
  // early, before budget pressure. Default 24.
  const maxUnfoldedToolResults = deps.config.maxToolResultsInContext ?? 24;
  /** Last provider-reported input size, used for next-turn pressure checks. */
  let lastInputTokens = Math.max(0, deps.lastProviderInputTokens ?? 0);

 // Append the user message as a transcript event — unless this run is a
 // Stop-hook continue (systemContinue): that feedback must reach the model
 // without impersonating the user in the UI / persisted JSONL.
  const userImages = input.systemContinue ? undefined : input.images;
  let pendingProviderResume: string | null = input.systemContinue?.trim()
    ? input.systemContinue
    : null;
  if (!input.systemContinue) {
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

  // Bounded nudges when the final answer cites file:line paths never observed
  // by a tool this session (possible fabrication).
  let citationResumes = 0;
  let hitMaxTurns = false;
  /** Sub-agents get one extra synthesis turn after the configured cap so a
   * budget hit becomes "finish writing your conclusion" instead of an error. */
  let subagentSynthesisBonus = false;
  let reachedTurnBudget = false;
  for (let turn = 0; ; turn++) {
    if (deps.signal?.aborted) {
      break;
    }
    if (turn >= maxTurns) {
      if (deps.isSubagent === true && !subagentSynthesisBonus && Number.isFinite(maxTurns)) {
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

 // Plan-stall notice: if a plan exists and we've gone several turns
 // calling tools without any plan step advancing, the model is spinning
 // on exploration without synthesizing. Flag it so this turn's live
 // context carries a reminder (then reset the counter so it clears once
 // the plan advances). The notice rides in <runtime_context>, never as a
 // persisted message, so it can't be mistaken for user input.
    if (planProgressSig !== "" && turnsSincePlanProgress >= PLAN_STALL_TURNS) {
      turnsSincePlanProgress = 0;
      planStalled = true;
    }

    // Turn-budget wind-down: when a finite cap is set, urge synthesis before
    // (and on) the last turns — never rely on a hard error to end the run.
    // Sub-agents also get a dedicated bonus turn (see subagentSynthesisBonus).
    if (Number.isFinite(maxTurns) && turn > 0) {
      const remaining = maxTurns - turn;
      if (subagentSynthesisBonus || remaining <= 1) {
        systemSteerNotices.push(
          deps.isSubagent
            ? `Turn budget reached (${turn}/${Number.isFinite(maxTurns) ? maxTurns : "∞"}). ` +
                `Do NOT call any more tools. Write your structured conclusion NOW ` +
                `(### Findings / ### Key references / ### Recommendations, or ### Blocker). ` +
                `Partial-but-synthesized beats stopping mid-exploration. Note anything left unverified.`
            : `You are about to reach your turn budget (${turn + 1}/${maxTurns}). Do NOT call any more ` +
                `tools. Using only what you already have, write your final answer now.`,
        );
      } else if (remaining === 2) {
        systemSteerNotices.push(
          `Two turns left in your budget (${turn + 1}/${maxTurns}). Wrap up tool use soon and ` +
            `prepare to synthesize your final answer from what you already have.`,
        );
      }
    }

    await emit({ type: "status", status: "running" });

    // Mid-run compaction before each model step: when the live transcript (or
    // last API input) approaches the configured window, persist a summary
    // compaction and resync history so growth stays bounded.
    if (deps.compactNow && deps.config.autoCompact !== false) {
      // Estimate the transcript ONCE here. Formerly this estimate ran up to
      // three times over the identical event array in a single iteration — for
      // `liveTokens`, inside a dead `shouldCompact(...)` OR operand, and again
      // for `estLive` below. `liveTokens` adds the fixed system-prompt reserve,
      // so it dominates a bare `shouldCompact(transcript, autoTrigger)` against
      // the same autoTrigger; that third operand could only fire when
      // `liveTokens` already had (unless systemReserve were negative, which it
      // never is), so it was dead and is dropped.
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
    // Decide whether to lazily surface MCP tools (hide their schemas, expose the
    // `mcp` meta-tool) based on config + how many MCP tools exist this turn.
    const mcpToolCount = deps.tools.all().filter((t) => t.source === "mcp").length;
    const discovery = deps.config.mcpToolDiscovery ?? "auto";
    const lazyThreshold = deps.config.mcpLazyThreshold ?? 8;
    const lazyMcp =
      mcpToolCount > 0 &&
      (discovery === "lazy" || (discovery === "auto" && mcpToolCount > lazyThreshold));
    const providerTools = buildProviderToolDefs(deps.tools, agentMode, { lazyMcp });
    const liveContext = buildLiveContext([...input.history, ...produced], produced, { planStalled, systemNotices: systemSteerNotices });

 // Debug/test consistency assertion: verify the
 // non-folded tail of the provider messages matches the persisted event
 // log. Only active when CODEPILOT_ASSERT_CONSISTENCY=1. Catches bugs
 // where what the model sees diverges from what was logged. The trailing
 // provider-only resume nudge (if any) is excluded — it is deliberately not
 // in the log, so comparing it would always report a spurious mismatch.
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
    // Whether we've already force-compacted this turn due to a context-overflow
    // error, and how many proportional shrink steps we've applied (prevents an
    // infinite compact→overflow→compact loop).
    let overflowCompacted = false;
    let overflowAttempt = 0;

    for (let attempt = 0; ; attempt++) {
      messageId = `msg_${randomUUID()}`;
      assistantText = [];
      assistantReasoning = [];
      toolCalls = [];
      sawError = null;
      finishReason = "stop";
      const streamed = await streamTurn(messageId);
      sawError = streamed.error;
      if (!sawError || deps.signal?.aborted) break;
 // Context-overflow is recoverable by shrinking, not by regenerating.
 // On the first overflow force a compaction; on each subsequent overflow
 // shrink the send budget by the next proportional step.
 // `OVERFLOW_SHRINK_STEPS` bounds how far we go so a model that overflows
 // no matter what can't loop forever.
      if (
        isContextOverflowError(sawError) &&
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
          for (let i = produced.length - 1; i >= 0; i--) {
            const e = produced[i]!;
            if ((e.type === "message_delta" && e.messageId === messageId) ||
                (e.type === "tool_call" && streamed.callIds.has(e.id))) {
              produced.splice(i, 1);
            }
          }
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
      if (attempt >= turnRetries || !isTransientError(sawError)) break;
      const delayMs = Math.min(8000, 1500 * 2 ** attempt);

      // Continuation path: the stream dropped AFTER the model had already
      // produced visible text, and no tool_call had started streaming. Rather
      // than discard that text and regenerate the whole turn — which re-runs
      // the task from scratch and wastes the work and tokens already spent — we
      // KEEP the partial text and ask the model to continue exactly where it
      // stopped, reusing the same machinery as an output-token-limit cut-off.
      //
      // Guards:
      //  - no tool_call streamed: a half-streamed call is ambiguous (did the
      //    args finish? was it executed?), so we fall back to regeneration;
      //  - some text was actually produced: nothing to continue otherwise;
      //  - bounded by MAX_INTERRUPT_RESUMES so a flapping connection can't loop.
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
        // Keep the partial output: its `message_delta` events stay in
        // `produced`, and the assistant `message` persisted below carries the
        // text so the next provider request includes it. Clearing `sawError`
        // makes the post-loop flow treat this like a clean partial stop; the
        // interrupt-resume check after the stream then re-enters the outer turn
        // loop with INTERRUPT_RESUME, exactly like a truncation resume.
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

    async function streamTurn(id: string): Promise<{ error: string | null; callIds: Set<string> }> {
      const callIds = new Set<string>();
      let error: string | null = null;
 // Live degeneration guard: a weak model can lock into looping one clause
 // ("I call X, I execute X, …") and fill the whole output ceiling. Waiting
 // for the turn to finish wastes the entire output budget, so we watch the
 // accumulating text and abort the stream the moment it goes periodic. We
 // only re-check every few KB of NEW text to keep it cheap.
      let repetitionCheckedAt = 0;
      const REPETITION_CHECK_EVERY = 2_000;
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
      let degenerated = false;
      try {
        for await (const ev of streamOnce(deps.provider, deps, providerMessages, providerTools, id, { liveContext, onRetry })) {
          if (deps.signal?.aborted) break;
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
              // output budget. Checked only every few KB of new text.
              const soFarLen = assistantText.reduce((n, s) => n + s.length, 0);
              if (soFarLen - repetitionCheckedAt >= REPETITION_CHECK_EVERY) {
                repetitionCheckedAt = soFarLen;
                const rep = detectRunawayRepetition(assistantText.join(""));
                if (rep) {
                  // Say "stopped", not "aborted": this is a deliberate
                  // non-transient stop, and the transient-error classifier keys
                  // off words like "aborted" to decide whether to retry.
                  error =
                    `output degenerated into a repeating loop ` +
                    `(${JSON.stringify(rep.unit.slice(0, 40))}×${rep.repeats}) — stopped`;
                  degenerated = true;
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
            case "done":
              finishReason = ev.finishReason;
              break;
          }
          // A detected repetition loop ends the stream immediately; the error
          // is surfaced below like any other turn failure.
          if (degenerated) break;
        }
      } catch (err) {
        // User cancel / send-now aborts the fetch/SSE — that is not a failure.
        if (deps.signal?.aborted || isAbortError(err)) {
          error = null;
        } else {
          error = (err as Error).message;
          if (llmSpan) tracer.recordError(llmSpan, err as Error);
        }
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
      return { error, callIds };
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

      // Empty successful stop after tools: keep going.
      if (
        sawToolCalls &&
        !sawError &&
        trimmed === "" &&
        emptyStopResumes < MAX_EMPTY_STOP_RESUMES
      ) {
        emptyStopResumes++;
        pendingProviderResume = EMPTY_STOP_RESUME;
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

      // Citation guard: flag file:line references in the final answer that
      // were never backed by a read/grep/glob/edit this session. One bounded
      // nudge so the model can verify or retract. Off when disabled or when
      // the user is being asked a question (not a factual claim).
      if (
        (deps.config.citationGuard ?? "notice") !== "off" &&
        !sawError &&
        trimmed !== "" &&
        citationResumes < MAX_CITATION_RESUMES &&
        !isWaitingForUser(trimmed)
      ) {
        const check = checkCitations(finalText, allEvents);
        const notice = buildCitationNotice(check);
        if (notice) {
          citationResumes++;
          pendingProviderResume = `[system] ${notice}`;
          continue;
        }
      }

      // Normal conversational end: yield the turn to the user.
      if (!sawError) await closeFinishedPlan(produced, emit);
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

 // Run tools in parallel.
    await emitAux({ type: "activity", phase: "tools", since: Date.now(), tools: toolCalls.map((tc) => tc.name) });
    const toolResults = await Promise.all(
      toolCalls.map((tc) =>
        hasUnparsedInput(tc)
          ? Promise.resolve<ToolExecResult>({ content: truncated ? TRUNCATED_CALL : MALFORMED_CALL, isError: true })
          : runOneTool(tc, deps, emit, agentMode, doomLoop)
      )
    );
    const planOnlyTurn = toolCalls.every((tc) => tc.name === "plan_update");
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const r = toolResults[i]!;
 // Secret redaction: credentials must never reach the transcript, the
 // model context or artifacts (see redact.ts).
      let safeContent = redactSecrets(r.content);
      if (planOnlyTurn && !r.isError) safeContent += PLAN_ONLY_TURN;
 // Fold-safety net: any result big enough to be folded later (minChars
 // 400 in compaction.ts) but without its own artifactRef gets one now,
 // so a future fold stub always carries a way back to the full text.
 // Without this the stub's "do NOT re-call" guidance is a dead end and
 // the model re-reads the target — the fold/dedup doom loop.
 // Skip results that already carry a dedup prefix: persisting the banner
 // into an artifact would poison future read_artifact calls.
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
  }

  // Turn-cap stops: main-session runs surface a recoverable error so the UI
  // isn't a silent idle. Sub-agents do NOT — they already got wind-down + a
  // synthesis bonus turn; assessSubagentOutcome uses whatever conclusion text
  // was produced. Emitting an error here made parents treat soft landings as
  // failures ("Reached the sub-agent step budget").
  if (hitMaxTurns && deps.isSubagent !== true) {
    const cap = Number.isFinite(maxTurns) ? String(maxTurns) : String(configuredMax);
    await emit({
      type: "error",
      message:
        `Reached maxTurns (${cap}): the model was still calling tools, so the run ` +
        `stopped before finishing. Send another message to continue the conversation, ` +
        `or raise/remove maxTurns in config for long tasks.`,
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

const MAX_TRUNCATION_RESUMES = 3;
/** Max consecutive mid-stream interrupts resumed by continuation before we
 * give up on continuing and fall back to regenerating the turn. */
const MAX_INTERRUPT_RESUMES = 3;
const MAX_EMPTY_STOP_RESUMES = 2;
const MAX_PLAN_SOFT_RESUMES = 1;
const MAX_CITATION_RESUMES = 1;
/** Proportional send-budget shrink steps applied on successive context-overflow
 * errors: first compact, then shrink to these fractions of the computed hard
 * budget. Bounded so overflow can't loop. */
const OVERFLOW_SHRINK_STEPS = [0.6, 0.4, 0.25];

const TRUNCATION_RESUME =
  "[system] Your previous reply was cut off by the output-token limit. Continue exactly where it " +
  "stopped — don't repeat what you already wrote. If you were about to call a tool with a large " +
  "argument, split the work into smaller calls.";

const INTERRUPT_RESUME =
  "[system] The connection dropped mid-response, so your previous reply was cut off partway. The " +
  "text you had already produced is preserved above. Continue exactly where it stopped — do NOT " +
  "repeat what you already wrote, and do NOT restart the task from the beginning.";

const EMPTY_STOP_RESUME =
  "[system] Your previous response ended successfully but contained no visible final text after " +
  "tool use. Continue the existing task from its current state without repeating completed work. " +
  "Call tools if you still have autonomous work; otherwise write a short status for the user.";

const PLAN_SOFT_RESUME =
  "[system] Your plan still has unfinished steps, and your last reply looked incomplete. " +
  "Resume at the first unfinished step — do not repeat completed work. Keep calling tools until " +
  "the step's deliverable is done, or ask the user a clear question if you are blocked.";

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
 * Per-turn context the model needs fresh every turn: the CURRENT plan (the
 * system prompt's copy is frozen at prompt start) and a ledger of the calls
 * already made for this request. Old tool output gets folded away during
 * long runs; without the ledger the model forgets it already did a step and
 * does it again.
 *
 * When `planStalled` is set, a stall notice is appended. `systemNotices` are
 * engine-generated, out-of-band messages (e.g. background-job completion):
 * they live here, in the per-turn runtime_context, rather than in the
 * persisted transcript, so they steer the model without ever looking like —
 * or being spoofable as — a user message on replay.
 */
export function buildLiveContext(
  all: Event[],
  produced: Event[],
  opts: { planStalled?: boolean; systemNotices?: string[] } = {},
): string {
  const parts = [renderPlanBlock(extractPlan(all))];
  const ledger = buildProgressLedger(produced);
  if (ledger) parts.push(ledger);
  if (opts.planStalled) parts.push(PLAN_STALL_NOTICE);
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
