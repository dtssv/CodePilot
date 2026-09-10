// FallbackProvider: an ordered chain of ChatProviders with automatic
// failover. If the primary provider's stream fails BEFORE any content was
// produced (rate limit, quota exhausted, auth error, outage), the request
// is retried against the next provider in the chain. Once a provider has
// streamed real content we stay on it for the rest of the call — switching
// mid-stream would corrupt tool-call framing.
//
// Config (see config.ts):
//   "fallbacks": [
//     { "provider": "openai", "model": "gpt-5", "apiKey": "${OPENAI_API_KEY}" },
//     { "provider": "anthropic", "model": "claude-sonnet-4-5" }
//   ]
//
// The primary provider is implicit (the top-level provider/model fields);
// `fallbacks` lists the backups tried in order.

import type {
  ChatProvider,
  StreamChatOptions,
  StreamEvent,
} from "./types.js";

const FAILOVER_PATTERNS = [
  /rate.?limit/i,
  /quota/i,
  /insufficient/i,
  /overloaded/i,
  /\b401\b/,
  /\b403\b/,
  /\b429\b/,
  /\b5\d\d\b/,
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/,
];

export function isFailoverError(message: string): boolean {
  return FAILOVER_PATTERNS.some((re) => re.test(message));
}

export class FallbackProvider implements ChatProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly smallModel: string;

  constructor(
    private readonly chain: ChatProvider[],
    /** Optional observer notified on each failover (from, to, reason). */
    private readonly onFailover?: (from: string, to: string, reason: string) => void
  ) {
    if (chain.length === 0) throw new Error("FallbackProvider needs at least one provider");
    this.name = chain.map((p) => p.name).join(">");
    this.defaultModel = chain[0]!.defaultModel;
    this.smallModel = chain[0]!.smallModel;
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
            if (!producedContent && isFailoverError(ev.message)) {
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
      if (!isFailoverError(failed)) {
        // Non-transient errors (e.g. invalid request) should not cascade.
        break;
      }
      this.onFailover?.(provider.name, next.name, failed);
      // Loop continues with the next provider.
    }
    yield { kind: "error", message: `all providers failed; last error: ${lastError}` };
  }
}
