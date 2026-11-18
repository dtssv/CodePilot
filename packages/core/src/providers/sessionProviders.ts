import type { CodepilotConfig } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { CopilotProvider } from "./copilot.js";
import { GeminiProvider } from "./gemini.js";
import { FallbackProvider } from "./fallback.js";
import type { ChatProvider } from "./types.js";

export function buildProvider(config: CodepilotConfig) {
  const primary = buildSingleProvider(config);
  const chain = [primary];
  for (const fb of config.fallbacks ?? []) {
    chain.push(buildSingleProvider({ ...config, ...fb }));
  }
  if (chain.length === 1) return primary;
  return new FallbackProvider(
    chain,
    (from, to, reason, kind) => {
      process.stderr.write(`[provider] failover ${from} → ${to} (${kind}): ${reason}\n`);
    },
    config.fallbackPolicy?.onQuota ?? "fail",
  );
}

export function buildSingleProvider(config: CodepilotConfig): ChatProvider {
  const provider = config.provider ?? "anthropic";
  switch (provider) {
    case "openai":
      return new OpenAIProvider({
        // "responses" selects the /v1/responses dialect; default chat.
        apiStyle: config.apiStyle === "responses" ? "responses" : "openai",
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: config.model,
        smallModel: config.smallModel ?? config.model,
        headers: config.headers,
        maxRetries: config.maxRetries,
        baseDelayMs: config.baseRetryDelayMs,
        maxDelayMs: config.maxRetryDelayMs,
        abortOnDelayMs: config.retryAbortOnDelayMs,
      });
    case "azure":
      // Azure OpenAI speaks the same wire protocol as OpenAI; it differs only
      // in URL shape (deployment + api-version) and auth header. Reuse the
      // OpenAI provider in "azure" dialect.
      return new OpenAIProvider({
        apiStyle: "azure",
        azureApiVersion: config.azureApiVersion,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: config.model,
        smallModel: config.smallModel ?? config.model,
        headers: config.headers,
        maxRetries: config.maxRetries,
        baseDelayMs: config.baseRetryDelayMs,
        maxDelayMs: config.maxRetryDelayMs,
        abortOnDelayMs: config.retryAbortOnDelayMs,
      });
    case "copilot":
      return new CopilotProvider({
        defaultModel: config.model,
        smallModel: config.smallModel ?? config.model,
      });
    case "gemini":
      return new GeminiProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: config.model,
        smallModel: config.smallModel ?? config.model,
        headers: config.headers,
      });
    case "anthropic":
    default:
      return new AnthropicProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: config.model,
        smallModel: config.smallModel ?? config.model,
        cacheTtl: config.promptCache?.ttl,
        headers: config.headers,
      });
  }
}

export function buildSmallProvider(config: CodepilotConfig) {
  return buildSingleProvider(config);
}