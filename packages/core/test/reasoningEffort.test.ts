import { describe, expect, it } from "vitest";
import {
  reasoningEffortChoicesForModel,
  reasoningEffortFromChoice,
  supportsReasoningEffort,
} from "../src/config/reasoningEffort.js";
import { resolveModelCapabilities } from "../src/config/providerCatalog.js";

describe("reasoningEffortChoicesForModel", () => {
  it("exposes low/medium/high for OpenAI o-series and gpt major ≥ 5", () => {
    expect(reasoningEffortChoicesForModel("o3-mini")).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortChoicesForModel("o1")).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortChoicesForModel("gpt-5")).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortChoicesForModel("gpt-6")).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortChoicesForModel("gpt-6.1-mini")).toEqual(["low", "medium", "high"]);
    expect(supportsReasoningEffort("gpt-5")).toBe(true);
  });

  it("hides effort for non-reasoning GPT families", () => {
    expect(reasoningEffortChoicesForModel("gpt-4o")).toEqual([]);
    expect(reasoningEffortChoicesForModel("gpt-4.1-mini")).toEqual([]);
    expect(reasoningEffortChoicesForModel("gpt-4-turbo")).toEqual([]);
    expect(reasoningEffortChoicesForModel("gpt-3.5-turbo")).toEqual([]);
  });

  it("exposes off+levels for Claude Sonnet/Opus; hides plain haiku", () => {
    expect(reasoningEffortChoicesForModel("claude-sonnet-4-5", "anthropic")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(reasoningEffortChoicesForModel("claude-opus-4", "anthropic")[0]).toBe("off");
    expect(reasoningEffortChoicesForModel("claude-haiku-3-5", "anthropic")).toEqual([]);
  });

  it("tolerates provider prefixes on the id", () => {
    expect(reasoningEffortChoicesForModel("openrouter/openai/gpt-6")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(reasoningEffortChoicesForModel("openrouter/anthropic/claude-sonnet-4", "anthropic")).toEqual(
      ["off", "low", "medium", "high"],
    );
  });

  it("covers DeepSeek reasoner and Gemini ≥ 2.5 / thinking", () => {
    expect(reasoningEffortChoicesForModel("deepseek-reasoner")).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortChoicesForModel("deepseek-chat")).toEqual([]);
    expect(reasoningEffortChoicesForModel("gemini-2.5-pro")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(reasoningEffortChoicesForModel("gemini-3-pro")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(reasoningEffortChoicesForModel("gemini-2.0-flash")).toEqual([]);
  });

  it("falls back to id heuristics for gateway aliases", () => {
    expect(reasoningEffortChoicesForModel("custom-reasoning-7b")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(reasoningEffortChoicesForModel("mystery-model-9000")).toEqual([]);
  });

  it("lets modelCapabilities.reasoningEffortChoices override heuristics", () => {
    expect(
      reasoningEffortChoicesForModel("mystery-model-9000", undefined, {
        reasoningEffortChoices: ["low", "high"],
      }),
    ).toEqual(["low", "high"]);
    // Empty override means no effort knob (explicit disable).
    expect(
      reasoningEffortChoicesForModel("gpt-6", undefined, { reasoningEffortChoices: [] }),
    ).toEqual([]);
  });

  it("maps UI choice to config", () => {
    expect(reasoningEffortFromChoice("off")).toBeUndefined();
    expect(reasoningEffortFromChoice("high")).toBe("high");
  });
});

describe("resolveModelCapabilities without a static catalog", () => {
  it("defaults unprobed models to text-only", () => {
    expect(resolveModelCapabilities("gpt-4o").modalities).toEqual(["text"]);
    expect(resolveModelCapabilities("mystery-model-9000").modalities).toEqual(["text"]);
  });

  it("still lets a live probe win", () => {
    const caps = resolveModelCapabilities("gpt-4o", { modalities: ["text", "image"] });
    expect(caps.modalities).toEqual(["text", "image"]);
  });

  it("preserves reasoningEffortChoices from existing caps", () => {
    const caps = resolveModelCapabilities(
      "custom",
      { modalities: ["text"] },
      {
        contextWindow: 200_000,
        modalities: ["text"],
        reasoningEffortChoices: ["off", "high"],
      },
    );
    expect(caps.reasoningEffortChoices).toEqual(["off", "high"]);
  });
});
