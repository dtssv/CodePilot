// Main agent loop: stream from ChatProvider, tools, convergence, resume.

import { randomUUID } from "node:crypto";
import type {
  ProviderMessage,
  ProviderToolDef,
  StreamChatOptions,
} from "../../providers/types.js";
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
} from "../../types.js";
import { redactSecrets } from "../../permissions/redact.js";
import {
  DoomLoopDetector,
  type DedupCache,
  questionSimilarity,
  QUESTION_SIMILARITY_THRESHOLD,
} from "../doomLoop.js";
import { consistencyAssertEnabled, assertConsistency } from "../consistency.js";
import { applyContextTransform } from "../../compaction/contextTransform.js";
import { detectRunawayRepetition } from "../../compaction/textDegeneration.js";
import { getTracer, type Span } from "../../telemetry/telemetry.js";
import {
  buildProviderMessages,
  buildProviderToolDefs,
  decideLazyMcp,
  streamOnce,
} from "../agent-messages.js";
import {
  runOneTool,
  emitTokenEstimateIfNeeded,
  type ToolExecResult,
} from "../agent-tools.js";
import { estimateEventTokens, extractPlan, usageSignalsCompact, HARD_TRIM_RATIO, compactionGeometry } from "../../compaction/compaction.js";
import { classifyProviderFailure, isTransientError } from "../transientError.js";
import { estimateTokens, lookupContextWindow } from "../../compaction/tokens.js";
import {
  JOB_DISPLAY_TOOLS,
  attachJobCommandForDisplay,
} from "../../tools/bashJobs.js";
import {
  isAbortError,
  isAbortMessage,
  isParallelSafeTool,
  runToolsWithBarrier,
} from "../agent-barrier.js";
import {
  DEFAULT_CONVERGENCE_CAP,
  CONVERGENCE_HARD_SLACK,
  DEFAULT_REMAINING_NUDGE_AT,
  NO_PROGRESS_SOFT_TURNS,
  NO_PROGRESS_STRONG_TURNS,
  NO_PROGRESS_LOCK_TURNS,
  NO_EXPLORATION_SOFT_TURNS,
  NO_EXPLORATION_STRONG_TURNS,
  NO_EXPLORATION_LOCK_TURNS,
  CONSECUTIVE_FAILURE_NOTICE_TURNS,
  DURABLE_PROGRESS_TOOLS,
  subagentConclusionShape,
  isNewReadEvidence,
  buildLiveContext,
} from "../agent-convergence.js";
import {
  MAX_TRUNCATION_RESUMES,
  MAX_INTERRUPT_RESUMES,
  MAX_EMPTY_STOP_RESUMES,
  MAX_PLAN_SOFT_RESUMES,
  MAX_PSEUDO_TOOL_RESUMES,
  OVERFLOW_SHRINK_STEPS,
  PAYLOAD_SHRINK_STEPS,
  TRUNCATION_RESUME,
  INTERRUPT_RESUME,
  EMPTY_STOP_RESUME,
  PLAN_SOFT_RESUME,
  PSEUDO_TOOL_CALL_RESUME,
  TRUNCATED_CALL,
  PLAN_ONLY_TURN,
  MALFORMED_CALL,
  hasUnparsedInput,
  looksLikePseudoToolCall,
  sleepUnlessAborted,
} from "../agent-resume.js";
import {
  hasUnfinishedPlan,
  isWaitingForUser,
  looksLikeIncompleteTurn,
} from "../agent-plan.js";
import type { AgentDeps, AgentRunInput, AgentRunResult } from "../agent-types.js";

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
  // Soft mid-history fold is opt-in (`maxContextTokens`). Default is
  // append-only until hard-window / auto-compact — rewriting earlier
  // tool_results every turn breaks provider prompt cache (keep
  // the prefix byte-stable and only replace on real compaction).
  const softConfigured = deps.config.maxContextTokens;
  const contextBudget =
    softConfigured !== undefined && softConfigured > 0
      ? Math.max(8_000, Math.min(hardBudget, softConfigured))
      : undefined;
  // Rolling tool-output window is also opt-in (`maxToolResultsInContext`).
  const maxUnfoldedToolResults = deps.config.maxToolResultsInContext;
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
                `conclusion NOW (${subagentConclusionShape(deps.subagentProfile)}). ` +
                "Partial-but-synthesized beats stopping mid-exploration. Note " +
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
              `tools. Write your structured conclusion NOW (${subagentConclusionShape(deps.subagentProfile)}) ` +
              "from what you already have. Note anything left unverified instead of looping to verify it."
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
              `your structured conclusion NOW (${subagentConclusionShape(deps.subagentProfile)}) ` +
              "from what you already have, and note what is still unverified."
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
    // Set when the stream was cut by a mid-stream user steer. The partial
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
            case "tool_call": {
              toolCalls.push(ev.toolCall);
              callIds.add(ev.toolCall.id);
              // Transcript/UI: bash_output/kill/stdin only carry job_id — attach
              // the real command so the card is not opaque JSON. Execution still
              // uses `ev.toolCall.input` (job_id only) from `toolCalls`.
              let displayInput = ev.toolCall.input;
              if (JOB_DISPLAY_TOOLS.has(ev.toolCall.name)) {
                displayInput = await attachJobCommandForDisplay(
                  deps.cwd,
                  ev.toolCall.input,
                ).catch(() => ev.toolCall.input);
              }
              await emit({
                type: "tool_call",
                id: ev.toolCall.id,
                name: ev.toolCall.name,
                input: displayInput,
              });
              break;
            }
            case "usage": {
              // Providers often emit the same usage snapshot twice (chunk + final).
              // Treat each stream event as an absolute snapshot for THIS request,
              // credit only the increase, and pass that delta to onUsage (session
              // sums deltas — never pass the run-cumulative total).
              const snap = {
                input: ev.usage.input ?? 0,
                output: ev.usage.output ?? 0,
                cacheRead: ev.usage.cacheRead ?? 0,
                cacheWrite: ev.usage.cacheWrite ?? 0,
              };
              const dIn = Math.max(0, snap.input - (llmUsage.input || 0));
              const dOut = Math.max(0, snap.output - (llmUsage.output || 0));
              const dCr = Math.max(0, snap.cacheRead - (llmUsage.cacheRead || 0));
              const dCw = Math.max(0, snap.cacheWrite - (llmUsage.cacheWrite || 0));
              if (dIn === 0 && dOut === 0 && dCr === 0 && dCw === 0) break;
              llmUsage.input = snap.input;
              llmUsage.output = snap.output;
              llmUsage.cacheRead = snap.cacheRead;
              llmUsage.cacheWrite = snap.cacheWrite;
              totalUsage = {
                input: (totalUsage.input || 0) + dIn,
                output: (totalUsage.output || 0) + dOut,
                cacheRead: (totalUsage.cacheRead || 0) + dCr,
                cacheWrite: (totalUsage.cacheWrite || 0) + dCw,
              };
              // Prefer the latest request's input size.
              // Do not add cacheRead — providers already include cached tokens
              // in `input` (or report them separately without double-billing).
              if (snap.input > 0) lastInputTokens = snap.input;
              if (deps.onUsage) {
                deps.onUsage({
                  input: dIn,
                  output: dOut,
                  cacheRead: dCr,
                  cacheWrite: dCw,
                });
              }
              await emit({ type: "usage", usage: snap });
              break;
            }
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
          // Mid-stream steer: a user correction arrived mid-turn. If no
          // tool call has started, cut the stream to drain the correction and
          // re-sample keeping the partial text. Once a tool_call is streaming
          // we don't preempt (ambiguous); it lands after the current tool batch.
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

    // Mid-stream steer: the partial text is persisted as its own assistant
    // message; re-enter the turn loop so the turn loop's drain step turns the
    // queued steer into a user message and the model samples a fresh response.
    // Nothing was executed (peek guard), and the partial is NOT folded into
    // resumedText.
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
