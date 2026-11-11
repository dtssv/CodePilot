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
import { estimateEventTokens } from "./compaction.js";
import { getTracer } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Token estimate helper
// ---------------------------------------------------------------------------

/** Compute a running session-level token estimate and notify the host.
 * Called after every assistant turn so the session layer can decide
 * whether to compact or write a checkpoint. */
export function emitTokenEstimateIfNeeded(
  deps: AgentDeps,
  input: AgentRunInput,
  produced: Event[],
  turn: number,
): void {
  if (!deps.onTokenEstimate) return;
  const all = [...input.history, ...produced];
  // Use the ONE canonical estimator (compaction.ts) so the session-level
  // estimate matches the compaction gate and checkpoint gate — previously this
  // was a separate per-block loop that ignored image tokens, so a session with
  // images under-counted here while the compaction gate counted them.
  const tokens = estimateEventTokens(all, estimateTokens);
  let turns = 0;
  for (const e of all) {
    if (e.type === "message" && e.role === "user") turns++;
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
 * validation → execution → PostToolUse hooks → doom-loop warning.
 *
 * Returns the result content (already secret-redacted by the caller) plus
 * metadata (artifactRef, blocks, images) the caller merges into the
 * transcript. */
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
  let doomLoopPreWarn = "";
  if (doomLoop) {
    const dl = doomLoop.check(tc.name, tc.input);
    if (dl.refuse) {
      endToolSpan(new Error(dl.message));
      return {
        content: dl.message,
        isError: true,
      };
    }
    if (dl.warn && dl.message) doomLoopPreWarn = dl.message;
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
      const kind = doomLoop.cachedResultKind(tc.name, tc.input);
 // State facts, not commands. The window slice (when path-keyed) is already
 // applied by cachedResult.
      const prefix =
        kind === "path"
          ? `[dedup: served from cache — read_file(${tc.name === "read_file" ? "" : ""}same path) ran earlier in this run ` +
            `and the file has not changed since. The body below is the requested window. ` +
            `Full text: read_artifact${cached.artifactRef ? ` ${cached.artifactRef}` : ""}.]\n\n`
          : `[dedup: served from cache — an identical ${tc.name} call ran earlier in this ` +
            `run and nothing has changed since. The result below is current.]\n\n`;
      return {
        content: prefix + cached.content,
        isError: false,
 // Deliberately no artifactRef: the replay text is derived, and letting
 // it flow into artifact stores would persist the dedup banner into
 // supposedly-pristine file bodies (observed as read_artifact poison).
        artifactRef: undefined,
      };
    }
  }

 // Permission check.
  const check = deps.permissions.preflight(tool, effectiveInput);
  let decision: import("./types.js").PermissionDecision = "allow";
 // Set when the host declines WITH a correction message — surfaced to the
 // model as the tool result so a denial becomes steering, not a dead end.
  let denyFeedback: string | undefined;
 // True when `denyFeedback` is a complete system-authored message (dont-ask /
 // auto classifier) rather than a human's correction, so it is surfaced to the
 // model verbatim instead of wrapped in "the user declined …".
  let denyFeedbackIsSystem = false;
 // Set by a non-interactive mode (dont-ask / auto classifier) that resolves a
 // would-be prompt without the UI, so the interactive block below is skipped.
  let resolvedWithoutPrompt = false;
  if (check === "ask") {
 // Non-interactive permission modes resolve a would-be prompt without the UI.
 // `dont-ask` denies every ask (there is no matching rule, and it is configured
 // not to block on a prompt). `auto` routes SOFT asks (nothing matched, no hard
 // floor) to a background classifier; HARD-floor asks (dangerous commands,
 // sensitive/.git writes, sandbox escalation, out-of-sandbox writes, explicit
 // ask rules) still prompt — the classifier must never silently allow those.
    const permMode = deps.permissions.getMode();
    if (permMode === "dont-ask") {
      decision = "deny";
      if (deps.config.dontAskFeedback !== false) {
        denyFeedback =
          `This session is configured to run without permission prompts (dont-ask mode). ` +
          `\`${tc.name}\` has no matching allow rule, so it was refused. ` +
          `Work with what is already permitted, or report that an allow rule is needed.`;
        denyFeedbackIsSystem = true;
      }
      resolvedWithoutPrompt = true;
    } else if (
      permMode === "auto" &&
      deps.permissionClassifier &&
      deps.permissions.askSeverity(tool, effectiveInput) === "soft" &&
      !deps.permissions.classifierShouldDefer()
    ) {
      const classifySpan = tracer.enabled
        ? tracer.startSpan("codepilot.permission_classify", {
            parentSpanId: toolSpan?.spanId ?? deps.parentSpan?.spanId,
            attributes: { "codepilot.tool_name": tc.name },
          })
        : undefined;
      const req = deps.permissions.buildRequest(
        `perm_${randomUUID()}`,
        tool,
        effectiveInput,
      );
      const { buildClassificationInput } = await import("./permissionClassifier.js");
      const { primaryArgOf } = await import("./permissions.js");
      const verdict = await deps.permissionClassifier
        .classify(
          buildClassificationInput(
            tool,
            primaryArgOf(tc.name, effectiveInput),
            deps.cwd,
            req.reason,
          ),
          deps.signal,
        )
        .catch(() => ({ decision: "uncertain" as const }));
      if (classifySpan) {
        classifySpan.attributes["codepilot.decision"] = verdict.decision;
        tracer.end(classifySpan);
      }
      if (verdict.decision === "allow") {
        deps.permissions.recordClassifierVerdict(false);
        decision = "allow";
        resolvedWithoutPrompt = true;
      } else if (verdict.decision === "deny") {
        deps.permissions.recordClassifierVerdict(true);
        decision = "deny";
        denyFeedback =
          `Auto-permission classifier refused \`${tc.name}\`: ${verdict.reason} ` +
          `Adjust the approach instead of re-issuing the same call.`;
        denyFeedbackIsSystem = true;
        resolvedWithoutPrompt = true;
      } else {
        // uncertain → reset the streak (not a denial) and fall through to a prompt.
        deps.permissions.recordClassifierVerdict(false);
      }
    }
  }
  if (check === "ask" && !resolvedWithoutPrompt) {
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
      // bash_kill / write_stdin only pass job_id — attach the real command
      // so the approval UI is not opaque JSON.
      await deps.permissions.enrichForDisplay(req, deps.cwd).catch(() => undefined);
      try {
        // Stop must unblock this wait; otherwise the prompt never finishes
        // and the follow-up queue cannot drain.
        const resolution = await racePermissionWithAbort(
          deps.onPermissionRequest(req),
          deps.signal,
        );
        if (typeof resolution === "string") {
          decision = resolution;
        } else {
          // Decline-with-feedback: a deny carrying a correction message.
          decision = "deny";
          denyFeedback = resolution.feedback;
        }
      } catch (err) {
        decision = "deny";
        void err;
      }
      if (decision !== "deny" && req.sandboxExpand && deps.expandSandboxWritable) {
 // Allow once → session-only root; Always (either scope) → also persist
 // writablePaths so the folder grant survives beyond this session.
        try {
          await deps.expandSandboxWritable(req.sandboxExpand.path, {
            persist: decision === "always" || decision === "always-project",
          });
        } catch (err) {
          endToolSpan(
            new Error(
              `failed to expand sandbox writable path: ${(err as Error).message}`,
            ),
          );
          return {
            content:
              `failed to expand sandbox writable path ` +
              `${req.sandboxExpand.path}: ${(err as Error).message}`,
            isError: true,
          };
        }
      }
      if (decision === "always" || decision === "always-project") {
 // Narrow the grant to a rule covering THIS invocation (e.g.
 // "bash(npm test *)", or the exact command for banned programs like
 // rm/sudo) rather than flipping the whole session to allow every call
 // to this tool. The rule is session-scoped: it lives in memory on the
 // PermissionEngine and is never persisted, so it dies with this
 // Session. deny rules still override — they are checked first in
 // preflight and are absolute, even under yolo. For sandbox-expand asks
 // the folder grant above is the durable part; the tool rule is still
 // useful for same-tool retries.
        const rule = PermissionEngine.suggestRule(tool, effectiveInput);
        deps.permissions.addSessionRule(rule, "allow");
 // "always-project" also persists the SAME narrowed rule to the project
 // config so it auto-applies in future sessions. Best-effort: a write
 // failure must not fail the tool call — the session grant above already
 // covers the rest of this session.
        if (decision === "always-project") {
          try {
            const { persistRule } = await import("./permissions.js");
            await persistRule(deps.cwd, rule, "allow", "repo");
          } catch {
 /* persistence is opt-in sugar; never block the tool on it */
          }
        }
        decision = "allow";
      }
      await emit({ type: "status", status: "running" });
    }
    if (permSpan) {
      permSpan.attributes["codepilot.decision"] = decision;
      tracer.end(permSpan);
    }
  } else if (check !== "ask") {
    // preflight returned a concrete allow/deny — carry it through. (A resolved
    // ask keeps the decision set by the non-interactive path above.)
    decision = check.decision;
  }

  if (decision === "deny") {
    endToolSpan(new Error(`permission denied for tool ${tc.name}`));
    // Decline-with-feedback: hand the correction to the model so it can adapt
    // (e.g. edit a different file) instead of just seeing "denied". A
    // system-authored message (dont-ask / auto classifier) is already a complete
    // instruction and is surfaced verbatim; a human's correction is wrapped.
    if (denyFeedback && denyFeedback.trim().length > 0) {
      return {
        content: denyFeedbackIsSystem
          ? denyFeedback.trim()
          : `The user declined \`${tc.name}\` and left this instruction: ${denyFeedback.trim()}\n` +
            `Follow it instead of re-issuing the same call.`,
        isError: true,
      };
    }
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
 // arguments before execution. The replacement must be a
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
    sessionId: deps.sessionId,
    signal: deps.signal,
    artifact: async (blob, hint) =>
      // Redact secrets before anything reaches disk. Text blobs spilled by
      // tools (spillHeadTail and friends) would otherwise persist raw
      // credentials into `.codepilot/artifacts`, replayable via read_artifact.
      // Binary blobs (Uint8Array) are passed through unchanged.
      deps.artifacts.write(
        typeof blob === "string" ? redactSecrets(blob, deps.redactPatterns) : blob,
        hint,
      ),
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
    toolCallId: tc.id,
    deliveryRoots: deps.deliveryRoots,
    scratchDir: deps.scratchDir,
    projectStateDir: deps.projectStateDir,
    addDeliveryRoot: deps.addDeliveryRoot,
    expandSandboxWritable: deps.expandSandboxWritable,
    observeFile: deps.fileObservations
      ? (p, s) => deps.fileObservations!.observe(p, s)
      : undefined,
    checkFileFresh: deps.fileObservations
      ? (p, s) => deps.fileObservations!.checkFresh(p, s)
      : undefined,
    reobserveFile: deps.fileObservations
      ? (p, s) => deps.fileObservations!.reobserveAfterWrite(p, s)
      : undefined,
  };

  try {
    const result = await tool.execute(parsed as never, ctx);
    let content = result.content;
 // Doom-loop warning (post-execution). NOTE: we do NOT call
 // doomLoop.check again here — the pre-execution check already
 // recorded this call. A second check would double-count every
 // invocation, making the REFUSE_THRESHOLD (5) effectively fire at
 // the 3rd real call (6 counts). Instead we ask for the CURRENT
 // count without incrementing, purely to decide whether to warn.
    if (doomLoop) {
      const count = doomLoop.peekCount(tc.name, tc.input);
      if (count >= DoomLoopDetector.WARN_THRESHOLD) {
        content = `[doom_loop warning: you've called ${tc.name} with this exact input ${count} times. If previous calls didn't help, STOP and try a different approach.]\n\n${content}`;
      } else if (doomLoopPreWarn) {
        content = `[${doomLoopPreWarn}]\n\n${content}`;
      }
    }
 // PostToolUse hooks: a hook may REPLACE the result text (redact/sanitize),
 // and/or append feedback for the model. Replacement happens first so
 // feedback is appended to the rewritten text.
    if (deps.hooks?.hasHooks("PostToolUse")) {
      const post = await deps.hooks.runPostToolUse(
        tc.name,
        effectiveInput,
        content,
        result.isError === true,
      );
      if (post.updatedResult !== undefined) content = post.updatedResult;
      if (post.feedback) content += `\n\n[hook feedback]\n${post.feedback}`;
    }
    if (result.isError === true)
      endToolSpan(new Error(`tool ${tc.name} returned an error`));
    else endToolSpan();
    if (doomLoop && !doomLoop.isDedupable(tc.name) && tool.permission !== "read") {
      doomLoop.noteMutation();
    }
 // Cache successful idempotent reads so a later identical call can replay.
    if (doomLoop && result.isError !== true) {
      doomLoop.recordResult(tc.name, tc.input, {
        content,
        artifactRef: result.artifactRef,
        isError: false,
      });
 // Remember which questions were answered, so re-asking the same question
 // (even reworded) is refused next time — the info is already in hand.
      if (tc.name === "ask_user_question") {
        doomLoop.markQuestionsAnswered(tc.input);
      }
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

/** Resolve with the permission decision, or `"deny"` as soon as `signal` aborts. */
function racePermissionWithAbort(
  pending: Promise<import("./types.js").PermissionResolution>,
  signal: AbortSignal | undefined,
): Promise<import("./types.js").PermissionResolution> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve("deny");
  return new Promise((resolve) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve("deny");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(
      (d) => {
        signal.removeEventListener("abort", onAbort);
        resolve(d);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve("deny");
      },
    );
  });
}

// Note: `redactSecrets`, `HookEngine`, and `DoomLoopDetector` are imported
// above for type-completeness; the actual redaction of result content is
// performed by the caller (`runAgent`) before emitting the tool_result event,
// so this module returns the raw content and lets the caller decide.
export { redactSecrets };
export type { HookEngine };
