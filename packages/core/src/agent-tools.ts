// Single-tool execution for the agent loop.
//
// Extracted from `agent.ts`: `runOneTool` is ~200 lines covering permission
// checks, PreToolUse/PostToolUse hooks, doom-loop detection, Zod validation,
// and telemetry spans. Keeping it in its own module lets the agent loop read
// as a clean turn-orchestration loop, and makes the tool-execution path
// independently testable.

import { randomUUID } from "node:crypto";
import type { ToolContext } from "./tools/types.js";
import type {
  AgentDeps,
  AgentRunInput,
} from "./agent.js";
import type {
  AgentMode,
  Event,
  ToolUseBlock,
} from "./types.js";
import { filterToolsByMode } from "./tools/modes.js";
import { PermissionEngine } from "./permissions.js";
import type { HookEngine } from "./hooks.js";
import { DoomLoopDetector } from "./doomLoop.js";
import { redactSecrets } from "./redact.js";
import { estimateTokens, lookupContextWindow } from "./tokens.js";
import { getTracer } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Token estimate helper
// ---------------------------------------------------------------------------

/** Compute a running session-level token estimate and notify the host.
 *  Called after every assistant turn so the session layer can decide
 *  whether to compact or write a checkpoint. */
export function emitTokenEstimateIfNeeded(
  deps: AgentDeps,
  input: AgentRunInput,
  produced: Event[],
  turn: number,
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
  const window =
    deps.config.contextWindow ??
    lookupContextWindow(deps.config.model).contextWindow;
  try {
    deps.onTokenEstimate({ tokens, turns, window });
  } catch {
    /* never let a listener throw */
  }
  // Touch `turn` to keep the parameter used when we add per-turn thresholds.
  void turn;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/** Best-effort size of a tool input for telemetry attributes. */
function safeInputSize(input: unknown): number {
  try {
    return JSON.stringify(input ?? null)?.length ?? 0;
  } catch {
    return 0;
  }
}

export interface ToolExecResult {
  content: string;
  isError: boolean;
  artifactRef?: string;
  blocks?: import("./types.js").ContentBlock[];
  images?: { mediaType: string; base64: string }[];
}

/** Execute a single tool call: permission check → PreToolUse hooks → Zod
 *  validation → execution → PostToolUse hooks → doom-loop warning.
 *
 *  Returns the result content (already secret-redacted by the caller) plus
 *  metadata (artifactRef, blocks, images) the caller merges into the
 *  transcript. */
export async function runOneTool(
  tc: ToolUseBlock,
  deps: AgentDeps,
  emit: (e: Event) => Promise<void>,
  mode: AgentMode = "agent",
  doomLoop?: DoomLoopDetector,
): Promise<ToolExecResult> {
  // Telemetry: one child span per tool call (no-op when disabled).
  const tracer = getTracer();
  const toolSpan = tracer.enabled
    ? tracer.startSpan("codepilot.tool_call", {
        parentSpanId: deps.parentSpan?.spanId,
        attributes: {
          "codepilot.tool_name": tc.name,
          "codepilot.tool_input_size": safeInputSize(tc.input),
        },
      })
    : undefined;
  const endToolSpan = (err?: Error): void => {
    if (!toolSpan) return;
    if (err) tracer.recordError(toolSpan, err);
    tracer.end(toolSpan);
  };

  const tool = deps.tools.get(tc.name);
  if (!tool) {
    endToolSpan(new Error(`unknown tool: ${tc.name}`));
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
    endToolSpan(new Error(`tool ${tc.name} is not allowed in ${mode} mode`));
    return {
      content: `tool ${tc.name} is not allowed in ${mode} mode`,
      isError: true,
    };
  }

  // Doom-loop detection: refuse after repeated identical calls.
  let effectiveInput: unknown = tc.input;
  if (doomLoop) {
    const dl = doomLoop.check(tc.name, tc.input);
    if (dl.refuse) {
      endToolSpan(new Error(dl.message));
      return {
        content: dl.message,
        isError: true,
      };
    }
    // Idempotent-call de-duplication: if this exact (tool, input) already
    // succeeded earlier in the run, replay the cached result instead of
    // re-executing. This collapses the "rate-limit makes the model re-explore
    // the same directories" loop: the model still gets the data it asked for,
    // but we don't burn another tool round-trip or stack a duplicate
    // tool_result into the context. A short prefix tells the model this is a
    // replay so it doesn't keep asking for the same thing.
    const cached = doomLoop.cachedResult(tc.name, tc.input);
    if (cached) {
      endToolSpan();
      return {
        content:
          `[dedup: replaying the result of an identical ${tc.name} call from ` +
          `earlier in this run — nothing has changed since. Use this result; ` +
          `do not call ${tc.name} again with the same arguments.]\n\n` +
          cached.content,
        isError: false,
        artifactRef: cached.artifactRef,
      };
    }
  }

  // Permission check.
  const check = deps.permissions.preflight(tool, effectiveInput);
  let decision: import("./types.js").PermissionDecision = "allow";
  if (check === "ask") {
    // Telemetry: one child span per interactive permission request.
    const permSpan = tracer.enabled
      ? tracer.startSpan("codepilot.permission_request", {
          parentSpanId: toolSpan?.spanId ?? deps.parentSpan?.spanId,
          attributes: { "codepilot.tool_name": tc.name },
        })
      : undefined;
    if (!deps.onPermissionRequest) {
      // No handler in headless mode — default to deny for safety unless
      // mode is yolo. (Preflight wouldn't return "ask" in yolo anyway.)
      decision = "deny";
    } else {
      await emit({ type: "status", status: "waiting_permission" });
      const reqId = `perm_${randomUUID()}`;
      const req = deps.permissions.buildRequest(reqId, tool, effectiveInput);
      try {
        decision = await deps.onPermissionRequest(req);
      } catch (err) {
        decision = "deny";
        void err;
      }
      if (decision === "always") {
        // Narrow the grant to a rule covering THIS invocation (e.g.
        // "bash(npm test *)") rather than flipping the whole session to
        // allow every call to this tool. The rule is session-scoped: it
        // lives in memory on the PermissionEngine and is never persisted,
        // so it dies with this Session. deny rules still override — they
        // are checked first in preflight and are absolute, even under yolo.
        const rule = PermissionEngine.suggestRule(tool, effectiveInput);
        deps.permissions.addSessionRule(rule, "allow");
        decision = "allow";
      }
      await emit({ type: "status", status: "running" });
    }
    if (permSpan) {
      permSpan.attributes["codepilot.decision"] = decision;
      tracer.end(permSpan);
    }
  } else {
    decision = check.decision;
  }

  if (decision === "deny") {
    endToolSpan(new Error(`permission denied for tool ${tc.name}`));
    return {
      content: `permission denied for tool ${tc.name}`,
      isError: true,
    };
  }

  // PreToolUse hooks: user-configured blockers (exit 2 = block) + input
  // rewriting (JSON `{"updatedInput": {...}}` replaces the tool input).
  if (deps.hooks?.hasHooks("PreToolUse")) {
    const pre = await deps.hooks.runPreToolUse(tc.name, effectiveInput);
    if (pre.action === "block") {
      endToolSpan(new Error(`blocked by PreToolUse hook: ${pre.reason}`));
      return {
        content: `blocked by PreToolUse hook: ${pre.reason}`,
        isError: true,
      };
    }
    // Input rewriting: a hook may return updatedInput to modify the
    // arguments before execution (codex-style). The replacement must be a
    // valid object; we re-validate below.
    if (pre.updatedInput !== undefined) {
      effectiveInput = pre.updatedInput;
    }
  }

  // Validate input via Zod. A validation failure is returned as a tool
  // error so the model can self-correct (this is the behaviour all mature
  // agents rely on); silently passing malformed input through is how
  // corrupt edits happen.
  let parsed: unknown = effectiveInput;
  const safe = tool.inputSchema.safeParse(effectiveInput);
  if (!safe.success) {
    const issues = safe.error.issues
      .slice(0, 5)
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    endToolSpan(new Error(`invalid arguments for tool ${tc.name}`));
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
    askUser: deps.onAskUser,
    persistentShell: deps.persistentShell,
    diagnosticsProvider: deps.diagnosticsProvider,
    config: deps.config,
    subagentDepth: deps.subagentDepth ?? 0,
    // Auxiliary events go to the host directly rather than through the
    // loop's `emit`: they must not land in the run's `produced` array,
    // which the loop indexes positionally when attaching tool_result
    // blocks to the assistant message.
    emitEvent: deps.onEvent ? (e) => deps.onEvent!(e) : undefined,
  };

  try {
    const result = await tool.execute(parsed as never, ctx);
    let content = result.content;
    // Doom-loop warning (post-execution). NOTE: we do NOT call
    // doomLoop.check() again here — the pre-execution check already
    // recorded this call. A second check would double-count every
    // invocation, making the REFUSE_THRESHOLD (5) effectively fire at
    // the 3rd real call (6 counts). Instead we ask for the CURRENT
    // count without incrementing, purely to decide whether to warn.
    if (doomLoop) {
      const count = doomLoop.peekCount(tc.name, tc.input);
      if (count >= DoomLoopDetector.WARN_THRESHOLD) {
        content = `[doom_loop warning: you've called ${tc.name} with this exact input ${count} times. If previous calls didn't help, STOP and try a different approach.]\n\n${content}`;
      }
    }
    // PostToolUse hooks: stdout is appended as feedback for the model.
    if (deps.hooks?.hasHooks("PostToolUse")) {
      const post = await deps.hooks.runPostToolUse(
        tc.name,
        effectiveInput,
        content,
        result.isError === true,
      );
      if (post.feedback) content += `\n\n[hook feedback]\n${post.feedback}`;
    }
    if (result.isError === true)
      endToolSpan(new Error(`tool ${tc.name} returned an error`));
    else endToolSpan();
    // Cache successful idempotent reads so a later identical call can replay.
    if (doomLoop && result.isError !== true) {
      doomLoop.recordResult(tc.name, tc.input, {
        content,
        artifactRef: result.artifactRef,
        isError: false,
      });
    }
    return {
      content,
      isError: result.isError === true,
      artifactRef: result.artifactRef,
      blocks: result.blocks,
      images: result.images,
    };
  } catch (err) {
    endToolSpan(err as Error);
    return {
      content: `tool ${tc.name} threw: ${(err as Error).message}`,
      isError: true,
    };
  }
}

// Note: `redactSecrets`, `HookEngine`, and `DoomLoopDetector` are imported
// above for type-completeness; the actual redaction of result content is
// performed by the caller (`runAgent`) before emitting the tool_result event,
// so this module returns the raw content and lets the caller decide.
export { redactSecrets };
export type { HookEngine };
