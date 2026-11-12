// FallbackProvider: an ordered chain of ChatProviders with automatic failover.
// If the primary stream fails BEFORE any content is produced (rate limit, auth,
// outage) the request retries on the next provider; once real content streams we
// stay put (switching mid-stream would corrupt tool-call framing).

import type {
  ChatProvider,
  CountTokensOptions,
  CountTokensResult,
  StreamChatOptions,
  StreamEvent,
} from "./types.js";
import {
  classifyFailover,
  shouldCascadeFailover,
  type QuotaFailoverPolicy,
} from "../transientError.js";

/** Back-compat predicate: whether an error would cascade to the next provider
 * under the default policy (quota does NOT cascade by default). Retained for
 * callers that want a boolean; the chain itself uses the structured classifier
 * so it can also honour a configured quota policy. */
export function isFailoverError(message: string, onQuota: QuotaFailoverPolicy = "fail"): boolean {
  return shouldCascadeFailover(classifyFailover(message), onQuota);
}

export class FallbackProvider implements ChatProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly smallModel: string;
  private readonly onQuota: QuotaFailoverPolicy;

  constructor(
    private readonly chain: ChatProvider[],
 /** Optional observer notified on each failover (from, to, reason, kind). */
    private readonly onFailover?: (from: string, to: string, reason: string, kind: string) => void,
 /** Whether an exhausted quota cascades to the next provider. Default "fail"
  * (quota is usually account-wide, so a same-account backup rarely helps). */
    onQuota: QuotaFailoverPolicy = "fail",
  ) {
    if (chain.length === 0) throw new Error("FallbackProvider needs at least one provider");
    this.name = chain.map((p) => p.name).join(">");
    this.defaultModel = chain[0]!.defaultModel;
    this.smallModel = chain[0]!.smallModel;
    this.onQuota = onQuota;
  }

  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    let lastError = "no providers configured";
    for (let i = 0; i < this.chain.length; i++) {
      const provider = this.chain[i]!;
      let producedContent = false;
      let failed: string | null = null;
      try {
        for await (const ev of provider.stream(opts)) {
          if (ev.kind === "error") {
            // Only a pre-content error can cascade; once a provider has streamed
            // real content we stay on it (switching mid-stream corrupts framing).
            if (!producedContent && shouldCascadeFailover(classifyFailover(ev.message), this.onQuota)) {
              failed = ev.message;
              break;
            }
            yield ev;
            continue;
          }
          if (
            ev.kind === "text_delta" ||
            ev.kind === "tool_call" ||
            ev.kind === "tool_input_delta"
          ) {
            producedContent = true;
          }
          yield ev;
        }
      } catch (err) {
        if (!producedContent) {
          failed = (err as Error).message;
        } else {
          yield { kind: "error", message: (err as Error).message };
        }
      }
      if (failed === null) return; // completed normally
      lastError = failed;
      const next = this.chain[i + 1];
      if (!next) break;
      const kind = classifyFailover(failed);
      if (!shouldCascadeFailover(kind, this.onQuota)) {
        // Deterministic errors (auth, invalid request) and — by default —
        // quota do not cascade: a backup would fail identically or is
        // account-scoped, so burning the rest of the chain helps nothing.
        break;
      }
      this.onFailover?.(provider.name, next.name, failed, kind);
      // Surface the switch to the caller as an observational stream event so a
      // host can show which provider served the turn and why it changed.
      yield { kind: "provider_failover", from: provider.name, to: next.name, reason: failed, failureKind: kind };
      // Loop continues with the next provider.
    }
    yield { kind: "error", message: `all providers failed; last error: ${lastError}` };
  }

  /** Delegate an exact token count to the primary provider when it supports it
   * (precise counting is an opt-in, non-failover path). */
  async countTokens(opts: CountTokensOptions): Promise<CountTokensResult> {
    const primary = this.chain[0]!;
    if (typeof primary.countTokens !== "function") {
      throw new Error("primary provider does not support count_tokens");
    }
    return primary.countTokens(opts);
  }
}
