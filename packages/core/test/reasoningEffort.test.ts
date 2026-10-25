import { describe, expect, it } from "vitest";
import {
  reasoningEffortChoicesForModel,
  reasoningEffortFromChoice,
  supportsReasoningEffort,
} from "../src/reasoningEffort.js";

describe("reasoningEffortChoicesForModel", () => {
  it("exposes low/medium/high for OpenAI o-series", () => {
    expect(reasoningEffortChoicesForModel("o3-mini")).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortChoicesForModel("o1")).toEqual(["low", "medium", "high"]);
    expect(supportsReasoningEffort("gpt-5")).toBe(true);
  });

  it("exposes off+levels for Claude Sonnet/Opus", () => {
    expect(reasoningEffortChoicesForModel("claude-sonnet-4-5", "anthropic")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(reasoningEffortChoicesForModel("claude-opus-4", "anthropic")[0]).toBe("off");
  });

  it("hides effort for plain haiku / unrelated models", () => {
    expect(reasoningEffortChoicesForModel("claude-haiku-3-5", "anthropic")).toEqual([]);
    expect(reasoningEffortChoicesForModel("gpt-4o")).toEqual([]);
  });

  it("maps UI choice to config", () => {
    expect(reasoningEffortFromChoice("off")).toBeUndefined();
    expect(reasoningEffortFromChoice("high")).toBe("high");
  });
});
