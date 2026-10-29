import { describe, expect, it } from "vitest";
import { buildProvider } from "../src/session-utils.js";
import type { CodepilotConfig } from "../src/types.js";

// Guards the shared provider factory that both the main session AND sub-agents
// use. Before this, sub-agents built their own provider and silently skipped
// the fallback chain; they now go through buildProvider, so a configured
// `fallbacks` list must produce a chained provider here.
describe("buildProvider fallback chain", () => {
  const base: CodepilotConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "x",
  } as CodepilotConfig;

  it("returns a single provider when no fallbacks are configured", () => {
    const p = buildProvider(base);
    // A single provider's name is the bare provider name (no chain separator).
    expect(p.name).not.toContain(">");
  });

  it("returns a chained (fallback) provider when fallbacks are configured", () => {
    const p = buildProvider({
      ...base,
      fallbacks: [{ provider: "openai", model: "gpt-5", apiKey: "y" }],
    } as CodepilotConfig);
    // FallbackProvider joins member names with ">".
    expect(p.name).toContain(">");
  });

  it("builds an azure provider via the OpenAI-compatible backend", () => {
    const p = buildProvider({
      provider: "azure",
      model: "my-deploy",
      apiKey: "k",
      baseURL: "https://res.openai.azure.com",
      azureApiVersion: "2024-10-21",
    } as CodepilotConfig);
    // Azure reuses the OpenAI provider implementation.
    expect(p.name).toBe("openai");
    expect(p.defaultModel).toBe("my-deploy");
  });
});
