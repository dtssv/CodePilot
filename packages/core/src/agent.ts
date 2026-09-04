// Agent loop. Streams from the ChatProvider, parses tool calls, runs the
// permission check, executes tools in parallel, appends tool_results, and
// loops until the model emits no more tool calls (or is cancelled).

import { randomUUID } from "node:crypto";
import type {
  ChatProvider,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolDef,
  StreamEvent,
} from "./providers/types.js";
import { ToolRegistry, type ToolContext, type ToolDef } from "./tools/types.js";
import { zodToJsonSchema } from "./tools/types.js";
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
  ToolUseBlock,
} from "./types.js";
import { filterToolsByMode } from "./tools/modes.js";
import { estimateTokens, lookupContextWindow } from "./tokens.js";
import { foldToolResults } from "./compaction.js";
import type { ResolvedSandbox } from "./sandbox.js";

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

    await emit({ type: "status", status: "running" });

    const providerMessages = buildProviderMessages(input.history, produced, input.userText, userImages);
    const providerTools = buildProviderToolDefs(deps.tools, agentMode);

    const messageId = `msg_${randomUUID()}`;
    const assistantText: string[] = [];
    const toolCalls: ToolUseBlock[] = [];
    let sawError: string | null = null;

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
      toolCalls.map((tc) => runOneTool(tc, deps, emit, agentMode))
    );
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const r = toolResults[i]!;
      const tr: ContentBlock = {
        type: "tool_result",
        toolCallId: tc.id,
        content: r.content,
        isError: r.isError,
        artifactRef: r.artifactRef,
      };
      // Also emit a top-level tool_result event for the session log.
      await emit({
        type: "tool_result",
        toolCallId: tc.id,
        name: tc.name,
        content: r.content,
        isError: r.isError,
        artifactRef: r.artifactRef,
      });
      // Append the tool_result block to the most recent assistant message.
      const last = produced[produced.length - 2]; // assistant message
      if (last && last.type === "message" && last.role === "assistant") {
        // Mutating ContentBlock array is fine — this is our local transcript.
        last.content = [...last.content, tr];
      }
    }

    // Plan updates are picked up here: if any tool returned a plan block
    // (currently only plan_update), surface it as a `plan` event.
    for (let i = 0; i < toolCalls.length; i++) {
      const r = toolResults[i]!;
      if (r.blocks) {
        for (const b of r.blocks) {
          if (b.type === "text") {
            try {
              const parsed = JSON.parse(b.text) as { type: string; steps?: unknown };
              if (parsed.type === "plan" && Array.isArray(parsed.steps)) {
                await emit({
                  type: "plan",
                  steps: parsed.steps as never,
                });
              }
            } catch {
              /* not JSON; ignore */
            }
          }
        }
      }
    }
  }

  await emit({ type: "status", status: "idle" });
  return {
    events: produced,
    hadToolCalls: sawToolCalls,
    finalText: "",
  };
}

/** Compute a running session-level token estimate and notify the host. */
function emitTokenEstimateIfNeeded(
  deps: AgentDeps,
  input: AgentRunInput,
  produced: Event[],
  turn: number
): void {
  if (!deps.onTokenEstimate) return;
  const all = [...input.history, ...produced];
  let tokens = 0;
  let turns = 0;
  for (const e of all) {
    if (e.type === "message") {
      if (e.role === "user") turns++;
      for (const b of e.content) {
        if (b.type === "text") tokens += estimateTokens(b.text);
        else tokens += estimateTokens(JSON.stringify(b));
      }
    } else if (e.type === "compaction") {
      tokens += estimateTokens(e.summary);
    } else if (e.type === "tool_call") {
      tokens += estimateTokens(JSON.stringify(e.input ?? {}));
    } else if (e.type === "tool_result") {
      tokens += estimateTokens(e.content);
    } else if (e.type === "plan") {
      tokens += estimateTokens(JSON.stringify(e.steps));
    }
  }
  const window = deps.config.contextWindow ??
    lookupContextWindow(deps.config.model).contextWindow;
  try {
    deps.onTokenEstimate({ tokens, turns, window });
  } catch {
    /* never let a listener throw */
  }
  // Touch `turn` to keep the parameter used when we add per-turn thresholds.
  void turn;
}

async function* streamOnce(
  provider: ChatProvider,
  deps: AgentDeps,
  messages: ProviderMessage[],
  tools: ProviderToolDef[],
  messageId: string
): AsyncIterable<StreamEvent> {
  const sys = deps.systemPrompt;
  const staticPrefix = sys?.staticPrefix;
  const dynamicSuffix = sys?.dynamicSuffix;
  // Static prefix goes to the system prompt (cache-friendly). The dynamic
  // suffix (env, git, memory, plan) is appended to the final user message as
  // a <runtime_context> note so it stays fresh per turn without busting the
  // cached prefix. Messages here are provider-bound copies, safe to derive.
  let effectiveMessages = messages;
  if (dynamicSuffix && dynamicSuffix.trim().length > 0) {
    effectiveMessages = [...messages];
    const note = `<runtime_context>\n${dynamicSuffix}\n</runtime_context>`;
    const last = effectiveMessages[effectiveMessages.length - 1];
    if (last && last.role === "user") {
      effectiveMessages[effectiveMessages.length - 1] = {
        ...last,
        content: [...last.content, { type: "text", text: "\n\n" + note }],
      };
    } else {
      effectiveMessages.push({ role: "user", content: [{ type: "text", text: note }] });
    }
  }
  void messageId;
  yield* provider.stream({
    model: deps.config.model ?? provider.defaultModel,
    messages: effectiveMessages,
    tools,
    systemPrompt: staticPrefix,
    signal: deps.signal,
    maxTokens: deps.config.maxTokens,
  });
}

function buildProviderToolDefs(tools: ToolRegistry, mode: AgentMode): ProviderToolDef[] {
  const visible = filterToolsByMode(tools.all(), mode);
  return visible.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  }));
}

function buildProviderMessages(
  history: Event[],
  newEvents: Event[],
  userText: string,
  images?: ImageAttachment[]
): ProviderMessage[] {
  // History is the persisted transcript; newEvents is the events produced
  // so far in the current run (we already appended the user message, so
  // we omit `userText` here). The agent loop is responsible for sending
  // the user message once at the start of the run.
  //
  // Micro-compaction (opencode-style prune): before sending, fold old
  // tool_result events (everything before the last 8 messages) into short
  // stubs that keep the artifactRef. This operates on a COPY of the event
  // list — the persisted JSONL transcript is untouched.
  const folded = foldToolResults([...history, ...newEvents], { keepRecentMessages: 8 });
  return compactTranscriptToProviderMessages(folded.events, userText, images);
}

function compactTranscriptToProviderMessages(
  transcript: Event[],
  fallbackUserText: string,
  images?: ImageAttachment[]
): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  let buffer: { role: "user" | "assistant"; blocks: ProviderMessageContent[] } | null = null;

  const flush = () => {
    if (!buffer) return;
    if (buffer.blocks.length > 0) {
      out.push({ role: buffer.role, content: buffer.blocks });
    }
    buffer = null;
  };

  for (const e of transcript) {
    if (e.type === "message") {
      flush();
      const blocks: ProviderMessageContent[] = [];
      for (const b of e.content) {
        if (b.type === "text") blocks.push({ type: "text", text: b.text });
        else if (b.type === "tool_use")
          blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        else if (b.type === "tool_result")
          blocks.push({
            type: "tool_result",
            toolCallId: b.toolCallId,
            content: b.content,
            isError: b.isError,
          });
      }
      buffer = { role: e.role, blocks };
      continue;
    }
    if (e.type === "tool_call") {
      if (!buffer || buffer.role !== "assistant") {
        flush();
        buffer = { role: "assistant", blocks: [] };
      }
      buffer.blocks.push({
        type: "tool_use",
        id: e.id,
        name: e.name,
        input: e.input,
      });
      continue;
    }
    if (e.type === "tool_result") {
      // tool_results come AFTER the assistant message that contained the
      // tool_use; we synthesise a user-role turn carrying them, since most
      // providers expect tool_result as a user-side message.
      flush();
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: e.toolCallId,
            content: e.content,
            isError: e.isError,
          },
        ],
      });
      continue;
    }
    if (e.type === "compaction") {
      flush();
      out.push({
        role: "user",
        content: [{ type: "text", text: `[Earlier conversation summary]\n${e.summary}` }],
      });
      continue;
    }
    // message_delta / plan / usage / status / error are ignored here.
  }
  flush();
  if (out.length === 0 && fallbackUserText) {
    const blocks: ProviderMessageContent[] = [{ type: "text", text: fallbackUserText }];
    for (const img of images ?? []) {
      blocks.push({ type: "image", mediaType: img.mediaType, base64: img.base64 });
    }
    out.push({ role: "user", content: blocks });
  }
  return out;
}

async function runOneTool(
  tc: ToolUseBlock,
  deps: AgentDeps,
  emit: (e: Event) => Promise<void>,
  mode: AgentMode = "agent"
): Promise<{
  content: string;
  isError: boolean;
  artifactRef?: string;
  blocks?: ContentBlock[];
}> {
  const tool = deps.tools.get(tc.name);
  if (!tool) {
    return {
      content: `unknown tool: ${tc.name}`,
      isError: true,
    };
  }

  // Mode gating: refuse tools that the current collaboration mode forbids.
  // This is a defence-in-depth check — the provider also shouldn't see them
  // — but if a previous turn's mode was changed, an in-flight call could
  // otherwise reach a forbidden tool.
  const visible = filterToolsByMode([tool], mode);
  if (visible.length === 0) {
    return {
      content: `tool ${tc.name} is not allowed in ${mode} mode`,
      isError: true,
    };
  }

  // Permission check.
  const check = deps.permissions.preflight(tool, tc.input);
  let decision: PermissionDecision = "allow";
  if (check === "ask") {
    if (!deps.onPermissionRequest) {
      // No handler in headless mode — default to deny for safety unless
      // mode is yolo. (Preflight wouldn't return "ask" in yolo anyway.)
      decision = "deny";
    } else {
      await emit({ type: "status", status: "waiting_permission" });
      const reqId = `perm_${randomUUID()}`;
      const req = deps.permissions.buildRequest(reqId, tool, tc.input);
      try {
        decision = await deps.onPermissionRequest(req);
      } catch (err) {
        decision = "deny";
        void err;
      }
      if (decision === "always") {
        // Narrow the grant to a rule covering this invocation (e.g.
        // "bash(npm test *)") instead of flipping the whole session to yolo.
        const rule = PermissionEngine.suggestRule(tool, tc.input);
        deps.permissions.addSessionRule(rule, "allow");
        decision = "allow";
      }
      await emit({ type: "status", status: "running" });
    }
  } else {
    decision = check.decision;
  }

  if (decision === "deny") {
    return {
      content: `permission denied for tool ${tc.name}`,
      isError: true,
    };
  }

  // Validate input via Zod. A validation failure is returned as a tool
  // error so the model can self-correct (this is the behaviour all mature
  // agents rely on); silently passing malformed input through is how
  // corrupt edits happen.
  let parsed: unknown = tc.input;
  const safe = tool.inputSchema.safeParse(tc.input);
  if (!safe.success) {
    const issues = safe.error.issues
      .slice(0, 5)
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    return {
      content:
        `invalid arguments for tool ${tc.name}:\n${issues}\n` +
        `Fix the arguments and call the tool again.`,
      isError: true,
    };
  }
  parsed = safe.data;

  const ctx: ToolContext = {
    cwd: deps.cwd,
    signal: deps.signal,
    artifact: async (blob, hint) => deps.artifacts.write(blob, hint),
    readArtifact: async (ref) => deps.artifacts.read(ref),
    sandbox: deps.sandbox,
  };

  try {
    const result = await tool.execute(parsed as never, ctx);
    return {
      content: result.content,
      isError: result.isError === true,
      artifactRef: result.artifactRef,
      blocks: result.blocks,
    };
  } catch (err) {
    return {
      content: `tool ${tc.name} threw: ${(err as Error).message}`,
      isError: true,
    };
  }
}
