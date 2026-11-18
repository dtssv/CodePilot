import { resolve } from "node:path";
import {
  buildCompletionPrompt,
  buildSingleProvider,
  cleanCompletion,
  COMPLETION_MAX_TOKENS,
  COMPLETION_SYSTEM_PROMPT,
  decideCompletionModel,
  userMessage,
} from "@codepilot/core";
import { assertInitialized, gitCwd, type ServerContext } from "../context.js";
import { loadConfigSafe } from "../loadConfigSafe.js";
import { liveSessions } from "../liveSessions.js";
import type {
  CompletionCancelParams,
  InlineCompletionParams,
  InlineCompletionResult,
} from "../wireTypes.js";

// Inline (Tab) code completion. Mirrors the commit-message template but:
//   1. never runs on the main chat model (design §2.5); and
//   2. FAST-FAIL retry (one attempt, short timeout) — a late completion is
//      worse than none.
// Stateless: the editor plugins own debounce / cancel / cache (§5.1).
export async function handleInlineCompletion(
  ctx: ServerContext,
  params: InlineCompletionParams,
): Promise<InlineCompletionResult> {
  assertInitialized(ctx);
  const requestId = params.requestId;
  const empty = (disabledReason?: string): InlineCompletionResult =>
    disabledReason ? { completion: "", requestId, disabledReason } : { completion: "", requestId };

  if (!params.prefix && !params.suffix) return empty();

  const root = gitCwd(ctx, params.cwd);
  let live = params.sessionId ? liveSessions.get(params.sessionId) : undefined;
  if (!live) {
    for (const s of liveSessions.values()) {
      if (resolve(s.session.cwd) === root) {
        live = s;
        break;
      }
    }
  }

  // Fast-fail retry: a single attempt with a short abort budget. A completion
  // that arrives after the next keystroke is useless.
  const fastFail = { maxRetries: 0, retryAbortOnDelayMs: 2000 };
  let provider: ReturnType<typeof buildSingleProvider>;
  let mainModel: string;
  let completionModel: string | undefined;
  let useFim = false;
  try {
    if (live) {
      const cfg = { ...live.session.getConfig(), ...fastFail };
      provider = buildSingleProvider(cfg);
      mainModel = live.session.getModel() || provider.defaultModel;
      completionModel = cfg.completion?.model;
      useFim = cfg.completion?.fim === true;
    } else {
      const cfg = { ...((await loadConfigSafe(root)) ?? {}), ...fastFail };
      provider = buildSingleProvider(cfg);
      mainModel = provider.defaultModel;
      completionModel = cfg.completion?.model;
      useFim = cfg.completion?.fim === true;
    }
  } catch {
    // No model configured — nothing to complete with.
    return empty();
  }

  const decision = decideCompletionModel({
    mainModel,
    smallModel: provider.smallModel,
    completionModel,
  });
  if (!decision.run) return empty(decision.disabledReason);

  const maxTokens = params.maxTokens && params.maxTokens > 0 ? params.maxTokens : COMPLETION_MAX_TOKENS;

  // Abort the upstream model call when the client cancels (completion/cancel)
  // so a superseded completion stops burning tokens instead of running to
  // completion. The controller is registered under the client's requestId; an
  // already-registered id from a stale duplicate is aborted first.
  ctx.completionAborts.get(requestId)?.abort();
  const controller = new AbortController();
  ctx.completionAborts.set(requestId, controller);
  const clearAbort = (): void => {
    if (ctx.completionAborts.get(requestId) === controller) ctx.completionAborts.delete(requestId);
  };

  // Native FIM path (opt-in + provider supports it): one non-streaming call
  // with prefix+suffix, strictly lower latency than the chat wrapper. Falls
  // back to the chat path on any FIM error (fast-fail).
  if (useFim && typeof provider.fim === "function") {
    try {
      const r = await provider.fim({
        model: decision.model,
        prefix: params.prefix,
        suffix: params.suffix,
        maxTokens,
        signal: controller.signal,
      });
      return { completion: cleanCompletion(r.text, params.prefix), requestId };
    } catch {
      return empty();
    } finally {
      clearAbort();
    }
  }

  const prompt = buildCompletionPrompt({ prefix: params.prefix, suffix: params.suffix, path: params.path });
  let raw = "";
  try {
    for await (const ev of provider.stream({
      model: decision.model,
      systemPrompt: COMPLETION_SYSTEM_PROMPT,
      messages: [userMessage(prompt)],
      maxTokens,
      signal: controller.signal,
    })) {
      if (ev.kind === "text_delta") raw += ev.text;
      else if (ev.kind === "error") throw new Error(ev.message);
    }
  } catch {
    // Fast-fail: any error (including a rate-limit or an abort) yields no
    // suggestion rather than a late one. The client simply shows nothing.
    return empty();
  } finally {
    clearAbort();
  }

  const completion = cleanCompletion(raw, params.prefix);
  return { completion, requestId };
}

/** Abort an in-flight inline completion by requestId. Idempotent: an unknown or
 * already-finished id is a no-op. Fire-and-forget (no reply). */
export function handleCompletionCancel(ctx: ServerContext, params: CompletionCancelParams): void {
  if (!ctx.initialized) return;
  const controller = ctx.completionAborts.get(params.requestId);
  if (controller) {
    controller.abort();
    ctx.completionAborts.delete(params.requestId);
  }
}