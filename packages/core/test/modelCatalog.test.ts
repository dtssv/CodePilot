import { describe, expect, it } from "vitest";
import {
  catalogEffortChoices,
  catalogModalities,
  catalogSuggestedSmall,
  lookupModelCatalog,
} from "../src/modelCatalog.js";
import { reasoningEffortChoicesForModel } from "../src/reasoningEffort.js";
import { resolveModelCapabilities } from "../src/providerCatalog.js";

describe("model catalog lookup", () => {
  it("matches known families by id glob, most-specific first", () => {
    expect(lookupModelCatalog("gpt-5")?.effort).toEqual(["low", "medium", "high"]);
    expect(lookupModelCatalog("gpt-4o-mini")?.effort).toEqual([]);
    expect(lookupModelCatalog("claude-sonnet-4-5")?.effort).toEqual(["off", "low", "medium", "high"]);
    expect(lookupModelCatalog("claude-haiku-4-5")?.effort).toEqual([]);
    expect(lookupModelCatalog("deepseek-reasoner")?.effort).toEqual(["low", "medium", "high"]);
    expect(lookupModelCatalog("deepseek-chat")?.effort).toEqual([]);
    expect(lookupModelCatalog("gemini-2.5-pro")?.effort).toEqual(["off", "low", "medium", "high"]);
  });

  it("is tolerant of a provider prefix on the id", () => {
    expect(lookupModelCatalog("jdcloud/glm-5.2")).toBeDefined();
    expect(lookupModelCatalog("openrouter/anthropic/claude-sonnet-4")?.effort).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  it("returns undefined for an unknown id", () => {
    expect(lookupModelCatalog("mystery-model-9000")).toBeUndefined();
    expect(catalogEffortChoices("mystery-model-9000")).toBeUndefined();
    expect(catalogModalities("mystery-model-9000")).toBeUndefined();
    expect(catalogSuggestedSmall("mystery-model-9000")).toBeUndefined();
  });

  it("declares modalities and a suggested small model for known families", () => {
    expect(catalogModalities("gpt-4o")).toEqual(["text", "image"]);
    expect(catalogModalities("deepseek-chat")).toEqual(["text"]);
    expect(catalogSuggestedSmall("claude-opus-4")).toBe("claude-haiku-4-5");
    expect(catalogSuggestedSmall("gpt-5")).toBe("gpt-4.1-mini");
  });
});

describe("reasoningEffortChoicesForModel consults the catalog first", () => {
  it("returns the catalog entry for a known model", () => {
    expect(reasoningEffortChoicesForModel("gpt-5")).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortChoicesForModel("claude-sonnet-4-5", "anthropic")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  it("falls back to id heuristics for a model not in the catalog", () => {
    // A gateway alias that only the generic "thinking/reason" heuristic covers.
    expect(reasoningEffortChoicesForModel("custom-reasoning-7b")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    // An unknown non-reasoning id gets no effort knob.
    expect(reasoningEffortChoicesForModel("mystery-model-9000")).toEqual([]);
  });
});

describe("resolveModelCapabilities uses the catalog for modalities when unprobed", () => {
  it("defaults a known vision model to its declared modalities", () => {
    const caps = resolveModelCapabilities("gpt-4o");
    expect(caps.modalities).toEqual(["text", "image"]);
  });

  it("still lets a live probe win over the catalog", () => {
    const caps = resolveModelCapabilities("gpt-4o", { modalities: ["text"] });
    expect(caps.modalities).toEqual(["text"]);
  });

  it("falls back to text for an unknown model", () => {
    const caps = resolveModelCapabilities("mystery-model-9000");
    expect(caps.modalities).toEqual(["text"]);
  });
});
