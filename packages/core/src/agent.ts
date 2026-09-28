// Agent loop. Streams from the ChatProvider, parses tool calls, runs the
// permission check, executes tools in parallel, appends tool_results, and
// loops until the model emits no more tool calls (or is cancelled).
//
// Module layout (see ROADMAP §3.2):
//   agent.ts          — this file: types + runAgent() turn loop
//   agent-messages.ts — buildProviderMessages / compactTranscriptToProviderMessages
//                       / buildProviderToolDefs / streamOnce
//   agent-tools.ts    — runOneTool (permission + hooks + doom-loop + Zod)
//                       + emitTokenEstimateIfNeeded

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
import { DoomLoopDetector } from "./doomLoop.js";
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
} from "./agent-tools.js";

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
   *  tool's recursion guard. */
  subagentDepth?: number;
  /**
   * Steering hook: called at the start of every agent turn. Returned texts
   * are injected into the transcript as additional user messages, letting a
   * host queue mid-run guidance without cancelling the run.
   */
  drainSteering?: () => string[];
  /**
   * Cursor-style collaboration mode. Filters the tool table sent to the
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
}

export interface AgentRunResult {
  /** All events produced during this run (in order). */
  events: Event[];
  /** True if the model emitted at least one tool call this run. */
  hadToolCalls: boolean;
  /** Final assistant text, if any. */
  finalText: string;
}

export async function runAgent(
  input: AgentRunInput,
  deps: AgentDeps
): Promise<AgentRunResult> {
  const maxTurns = deps.maxTurns ?? deps.config.maxTurns ?? 50;
  const agentMode: AgentMode = deps.agentMode ?? "agent";
  const produced: Event[] = [];
  const doomLoop = new DoomLoopDetector();
  // Plan-progress tracking: if the model keeps calling tools but the plan
  // never advances (no step moves to completed/in_progress), it's spinning.
  // After PLAN_STALL_TURNS turns of no progress we inject a steering nudge.
  let planProgressSig = "";
  let turnsSincePlanProgress = 0;
  const PLAN_STALL_TURNS = 4;
  const emit = async (e: Event): Promise<void> => {
    produced.push(e);
    if (deps.onEvent) await deps.onEvent(e);
  };

  // Append the user message as a transcript event. Images are sent to the
  // provider separately and are NOT persisted as part of the event log (the
  // public Event model only has text / tool_use / tool_result blocks).
  const userMessageId = `msg_${randomUUID()}`;
  const userEvent: Event = {
    type: "message",
    id: userMessageId,
    role: "user",
    content: [{ type: "text", text: input.userText }],
  };
  await emit(userEvent);
  const userImages = input.images;

  let totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawToolCalls = false;

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

    // Plan-stall nudge: if a plan exists and we've gone several turns
    // calling tools without any plan step advancing, the model is spinning
    // on exploration without synthesizing. Inject one steering reminder
    // (then reset the counter so we don't nag every turn).
    if (planProgressSig !== "" && turnsSincePlanProgress >= PLAN_STALL_TURNS) {
      turnsSincePlanProgress = 0;
      await emit({
        type: "message",
        id: `msg_${randomUUID()}`,
        role: "user",
        content: [
          {
            type: "text",
            text:
              `[plan stall] You've called tools for several turns without advancing ` +
              `your plan. You have enough information — stop exploring and move on: ` +
              `mark the current plan step complete, start the next one, or produce ` +
              `the synthesis/output the task asks for. If you're stuck, summarize ` +
              `what you've learned so far.`,
          },
        ],
      });
    }

    await emit({ type: "status", status: "running" });

    const providerMessages = buildProviderMessages(input.history, produced, input.userText, userImages);
    const providerTools = buildProviderToolDefs(deps.tools, agentMode);

    // Debug/test consistency assertion (deepseek-harness parity): verify the
    // non-folded tail of the provider messages matches the persisted event
    // log. Only active when CODEPILOT_ASSERT_CONSISTENCY=1. Catches bugs
    // where what the model sees diverges from what was logged.
    if (consistencyAssertEnabled()) {
      assertConsistency(providerMessages, [...input.history, ...produced], 8);
    }

    const messageId = `msg_${randomUUID()}`;
    const assistantText: string[] = [];
    const toolCalls: ToolUseBlock[] = [];
    let sawError: string | null = null;

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

    try {
      for await (const ev of streamOnce(deps.provider, deps, providerMessages, providerTools, messageId)) {
        if (deps.signal?.aborted) break;
        switch (ev.kind) {
          case "text_delta":
            assistantText.push(ev.text);
            await emit({
              type: "message_delta",
              messageId,
              delta: { type: "text", text: ev.text },
            });
            break;
          case "tool_input_delta":
            await emit({
              type: "message_delta",
              messageId,
              delta: {
                type: "tool_input_json",
                toolCallId: ev.toolCallId,
                partialJson: ev.partialJson,
              },
            });
            break;
          case "tool_call":
            toolCalls.push(ev.toolCall);
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
            sawError = ev.message;
            break;
          case "done":
            break;
        }
      }
    } catch (err) {
      sawError = (err as Error).message;
      if (llmSpan) tracer.recordError(llmSpan, err as Error);
    }

    if (llmSpan) {
      if (sawError) tracer.recordError(llmSpan, new Error(sawError));
      // Record usage info gathered from the stream's usage events.
      llmSpan.attributes["codepilot.usage.input"] = llmUsage.input;
      llmSpan.attributes["codepilot.usage.output"] = llmUsage.output;
      llmSpan.attributes["codepilot.usage.cache_read"] = llmUsage.cacheRead;
      llmSpan.attributes["codepilot.usage.cache_write"] = llmUsage.cacheWrite;
      tracer.end(llmSpan);
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

    // Stop if the model didn't request any tools.
    if (toolCalls.length === 0) {
      await emit({ type: "status", status: "idle" });
      return {
        events: produced,
        hadToolCalls: sawToolCalls,
        finalText: assistantText.join(""),
      };
    }
    sawToolCalls = true;

    // Run tools in parallel.
    const toolResults = await Promise.all(
      toolCalls.map((tc) => runOneTool(tc, deps, emit, agentMode, doomLoop))
    );
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const r = toolResults[i]!;
      // Secret redaction: credentials must never reach the transcript or
      // the model context (see redact.ts). Artifacts keep full fidelity.
      const safeContent = redactSecrets(r.content);
      const tr: ContentBlock = {
        type: "tool_result",
        toolCallId: tc.id,
        content: safeContent,
        isError: r.isError,
        artifactRef: r.artifactRef,
      };
      // Also emit a top-level tool_result event for the session log.
      await emit({
        type: "tool_result",
        toolCallId: tc.id,
        name: tc.name,
        content: safeContent,
        isError: r.isError,
        artifactRef: r.artifactRef,
        images: r.images,
      });
      // Append the tool_result block to the most recent assistant message.
      const last = produced[produced.length - 2]; // assistant message
      if (last && last.type === "message" && last.role === "assistant") {
        // Mutating ContentBlock array is fine — this is our local transcript.
        last.content = [...last.content, tr];
      }
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
