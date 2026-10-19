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
import { extractPlan } from "./compaction.js";
import { renderPlanBlock } from "./systemPrompt.js";
import { lookupContextWindow } from "./tokens.js";

export interface AgentDeps {
  provider: ChatProvider;
  tools: ToolRegistry;
  artifacts: ArtifactStore;
  permissions: PermissionEngine;
  config: CodepilotConfig;
  cwd: string;
 /** Optional: prebuilt system prompt (static prefix + dynamic suffix). */
  systemPrompt?: { staticPrefix: string; dynamicSuffix: string; full: string };
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
 /** Permission request handler. */
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
 /** Maximum number of assistant turns per prompt. */
  maxTurns?: number;
 /** Active sandbox policy handed to every tool via ToolContext. */
  sandbox?: ResolvedSandbox;
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
 * Steering hook: called at the start of every agent turn. Returned texts
 * are injected into the transcript as additional user messages, letting a
 * host queue mid-run guidance without cancelling the run.
 */
  drainSteering?: () => string[];
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
}

export interface AgentRunInput {
 /** Existing transcript (from session resume) — newest first OR oldest first? Oldest. */
  history: Event[];
  userText: string;
  images?: ImageAttachment[];
 /** Files already written under the workspace for this prompt. */
  files?: import("./types.js").SavedUpload[];
}

export interface AgentRunResult {
 /** All events produced during this run (in order). */
  events: Event[];
 /** True if the model emitted at least one tool call this run. */
  hadToolCalls: boolean;
 /** Final assistant text, if any. */
  finalText: string;
}

/**
 * Models usually deliver the plan's last step ("write the report") as their
 * final answer, so that step is left in_progress with no turn left to mark
 * it. When the run ends normally and nothing is still pending, close the
 * in-progress steps of the plan this run produced.
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
  const input: AgentRunInput = { ...rawInput, history: rawInput.history.slice() };
  const maxTurns = deps.maxTurns ?? deps.config.maxTurns ?? 50;
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
  const contextWindow =
    deps.config.contextWindow ?? lookupContextWindow(deps.config.model).contextWindow;
 // Mid-run fold budget. Two caps, whichever is tighter:
 // • the model's window × compaction threshold (don't overflow the window)
 // • a soft working budget (default 48K) so we don't ship ~100K tokens/turn
 // just because the window technically allows it — that is the main cause
 // of slow turns on large-window / unknown models.
  const windowBudget = Math.floor(contextWindow * (deps.config.compactionThreshold ?? 0.92));
  const softBudget = deps.config.maxContextTokens ?? 48_000;
  const contextBudget = Math.max(8_000, Math.min(windowBudget, softBudget));

 // Append the user message as a transcript event. Images and uploaded-file
 // metadata ride on the event so resume / the UI keep them.
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
  const userImages = input.images;

  let totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawToolCalls = false;
 // Replies cut off by the output-token limit are resumed rather than taken
 // as the final answer (bounded, so a model that always overflows can't loop).
  let truncatedInARow = 0;
  let resumeAfterTruncation = false;
 /** Text of the cut-off replies being resumed; prefixes the final answer. */
  let resumedText = "";

  for (let turn = 0; turn < maxTurns; turn++) {
    if (deps.signal?.aborted) break;

 // Snapshot the plan-progress signature at the start of the turn so we
 // can tell whether this turn's tool calls advanced the plan.
    const planSigBefore = planProgressSig;

 // Drain queued steering messages into the transcript before building
 // the provider request, so mid-run guidance reaches the model on the
 // very next turn.
    if (deps.drainSteering) {
      const steered = deps.drainSteering();
      for (const text of steered) {
        await emit({
          type: "message",
          id: `msg_${randomUUID()}`,
          role: "user",
          content: [{ type: "text", text }],
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

    await emit({ type: "status", status: "running" });

 // Micro-fold old tool_results for the provider prompt (keeps big runs
 // inside the token budget). This is a routine, lossless prune: each folded
 // stub already carries its own "don't re-read; use read_artifact" steering,
 // and the fold never reaches the provider as a separate event. We used to
 // emit a visible `compaction` notice here, but it fired on almost every
 // turn of a long session ("micro-fold: stubbed N prior tool_result(s)…")
 // and was pure noise to the user — so we prune silently now.
    const providerMessages = buildProviderMessages(input.history, produced, input.userText, userImages, {
      contextBudget,
    });
    if (resumeAfterTruncation) {
 // Provider-only turn: the transcript keeps just the partial reply.
      providerMessages.push({ role: "user", content: [{ type: "text", text: TRUNCATION_RESUME }] });
      resumeAfterTruncation = false;
    }
    const providerTools = buildProviderToolDefs(deps.tools, agentMode);
    const liveContext = buildLiveContext([...input.history, ...produced], produced, { planStalled });

 // Debug/test consistency assertion: verify the
 // non-folded tail of the provider messages matches the persisted event
 // log. Only active when CODEPILOT_ASSERT_CONSISTENCY=1. Catches bugs
 // where what the model sees diverges from what was logged.
    if (consistencyAssertEnabled()) {
      assertConsistency(providerMessages, [...input.history, ...produced], 8);
    }

    let messageId = `msg_${randomUUID()}`;
    let assistantText: string[] = [];
    let toolCalls: ToolUseBlock[] = [];
    let sawError: string | null = null;
    let finishReason = "stop";

    for (let attempt = 0; ; attempt++) {
      messageId = `msg_${randomUUID()}`;
      assistantText = [];
      toolCalls = [];
      sawError = null;
      finishReason = "stop";
      const streamed = await streamTurn(messageId);
      sawError = streamed.error;
      if (!sawError || deps.signal?.aborted) break;
 // A transient failure (dropped connection, overloaded gateway) is
 // retried in place: the partial output is discarded, nothing was
 // executed, so the model simply regenerates this turn.
      if (attempt >= turnRetries || !isTransientError(sawError)) break;
      const delayMs = Math.min(8000, 1500 * 2 ** attempt);
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
      try {
        for await (const ev of streamOnce(deps.provider, deps, providerMessages, providerTools, id, { liveContext, onRetry })) {
          if (deps.signal?.aborted) break;
          switch (ev.kind) {
            case "text_delta":
              markFirstToken();
              assistantText.push(ev.text);
              await emit({
                type: "message_delta",
                messageId: id,
                delta: { type: "text", text: ev.text },
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
        }
      } catch (err) {
        error = (err as Error).message;
        if (llmSpan) tracer.recordError(llmSpan, err as Error);
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

    if (sawError) {
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
        };
      }
    }

 // Fire the token-estimate hook so the session layer can decide
 // whether to compact or write a checkpoint. We do this in addition
 // to the per-prompt postlude so very long single-prompt runs (many
 // tool calls within one user message) can still react.
    emitTokenEstimateIfNeeded(deps, input, produced, turn);

    const truncated = !sawError && (finishReason === "length" || finishReason === "max_tokens");
    truncatedInARow = truncated ? truncatedInARow + 1 : 0;
    if (truncated && toolCalls.length === 0 && truncatedInARow <= MAX_TRUNCATION_RESUMES) {
      resumedText += assistantText.join("");
      resumeAfterTruncation = true;
      continue;
    }

 // Stop if the model didn't request any tools.
    if (toolCalls.length === 0) {
      if (!sawError) await closeFinishedPlan(produced, emit);
      await emit({ type: "status", status: "idle" });
      return {
        events: produced,
        hadToolCalls: sawToolCalls,
        finalText: resumedText + assistantText.join(""),
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

  await emit({ type: "status", status: "idle" });
  return {
    events: produced,
    hadToolCalls: sawToolCalls,
    finalText: "",
  };
}

const TRANSIENT_PATTERNS = [
  /network|fetch failed|socket|terminated|aborted by peer|other side closed/i,
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|UND_ERR/,
  /timed? ?out|timeout/i,
  /overloaded|temporarily unavailable|try again|server error|bad gateway/i,
  /rate.?limit|\b429\b|\b5\d\d\b/i,
  /stream (ended|closed)|unexpected end/i,
];

const MAX_TRUNCATION_RESUMES = 3;

const TRUNCATION_RESUME =
  "[system] Your previous reply was cut off by the output-token limit. Continue exactly where it " +
  "stopped — don't repeat what you already wrote. If you were about to call a tool with a large " +
  "argument, split the work into smaller calls.";

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

/** Providers hand back `{ __raw }` when a tool call's JSON didn't parse. */
function hasUnparsedInput(tc: ToolUseBlock): boolean {
  const input = tc.input as Record<string, unknown> | null;
  return !!input && typeof input === "object" && "__raw" in input && Object.keys(input).length === 1;
}

/** Whether a stream failure is worth regenerating the turn for. */
export function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((re) => re.test(message));
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
 * When `planStalled` is set, a stall notice is appended. It lives here (in
 * the per-turn runtime_context) rather than in the persisted transcript so
 * it steers the model without ever looking like a user message on replay.
 */
export function buildLiveContext(
  all: Event[],
  produced: Event[],
  opts: { planStalled?: boolean } = {},
): string {
  const parts = [renderPlanBlock(extractPlan(all))];
  const ledger = buildProgressLedger(produced);
  if (ledger) parts.push(ledger);
  if (opts.planStalled) parts.push(PLAN_STALL_NOTICE);
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
