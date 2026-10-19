import { describe, expect, it } from "vitest";
import {
  applyProviderAndModel,
  listSelectableModels,
  findProviderIdForFlat,
  redactProviderPreset,
  resolveModelTarget,
  PROVIDER_TEMPLATES,
  templateToPreset,
  nextProviderId,
} from "../src/providerCatalog.js";
import type { ResolvedCodepilotConfig } from "../src/config.js";

describe("listSelectableModels", () => {
  it("lists models across named providers", () => {
    const cfg: ResolvedCodepilotConfig = {
      provider: "openai",
      model: "deepseek-chat",
      providers: {
        deepseek: {
          provider: "openai",
          displayName: "DeepSeek",
          baseURL: "https://api.deepseek.com/v1",
          model: "deepseek-chat",
          models: ["deepseek-chat", "deepseek-reasoner"],
        },
        tongyi: {
          provider: "openai",
          displayName: "通义",
          baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          models: ["qwen-plus", "qwen-turbo"],
        },
      },
    };
    const rows = listSelectableModels(cfg);
    expect(rows.some((r) => r.id === "deepseek/deepseek-reasoner")).toBe(true);
    expect(rows.some((r) => r.id === "tongyi/qwen-plus")).toBe(true);
    expect(findProviderIdForFlat(cfg)).toBe("deepseek");
  });
});

describe("applyProviderAndModel", () => {
  it("switches baseURL when selecting another provider", () => {
    const cfg: ResolvedCodepilotConfig = {
      provider: "openai",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-a",
      model: "deepseek-chat",
      providers: {
        deepseek: {
          provider: "openai",
          baseURL: "https://api.deepseek.com/v1",
          apiKey: "sk-a",
          model: "deepseek-chat",
        },
        tongyi: {
          provider: "openai",
          baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: "sk-b",
          model: "qwen-plus",
          models: ["qwen-plus"],
        },
      },
    };
    const next = applyProviderAndModel(cfg, "tongyi", "qwen-plus");
    expect(next.config.baseURL).toContain("dashscope");
    expect(next.config.apiKey).toBe("sk-b");
    expect(next.model).toBe("qwen-plus");
    expect(next.providerId).toBe("tongyi");
  });
});

describe("templates", () => {
  it("includes common vendors", () => {
    const ids = PROVIDER_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "anthropic",
        "openai",
        "deepseek",
        "tongyi",
        "moonshot",
        "zhipu",
        "ollama",
        "custom-openai",
        "custom-anthropic",
      ]),
    );
    const preset = templateToPreset(PROVIDER_TEMPLATES.find((t) => t.id === "deepseek")!);
    expect(preset.provider).toBe("openai");
    expect(preset.baseURL).toContain("deepseek");
    const claudeCustom = PROVIDER_TEMPLATES.find((t) => t.id === "custom-anthropic")!;
    expect(claudeCustom.provider).toBe("anthropic");
    expect(claudeCustom.requiresBaseURL).toBe(true);
  });

  it("allocates unique endpoint ids for multiple keys", () => {
    expect(nextProviderId("deepseek", [])).toBe("deepseek");
    expect(nextProviderId("deepseek", ["deepseek"])).toBe("deepseek-2");
    expect(nextProviderId("deepseek", ["deepseek", "deepseek-2"])).toBe("deepseek-3");
  });

  it("redacts api keys", () => {
    const r = redactProviderPreset({
      provider: "openai",
      apiKey: "sk-abcdefghijklmnop",
      model: "x",
    });
    expect(r.hasApiKey).toBe(true);
    expect(r.apiKeyHint).toBe("mnop");
    expect(r).not.toHaveProperty("apiKey");
  });
});

describe("resolveModelTarget", () => {
  const cfg: ResolvedCodepilotConfig = {
    provider: "openai",
    model: "deepseek-chat",
    providers: {
      deepseek: {
        provider: "openai",
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        models: ["deepseek-chat", "deepseek-reasoner"],
      },
      siliconflow: {
        provider: "openai",
        baseURL: "https://api.siliconflow.cn/v1",
        models: ["deepseek-ai/DeepSeek-V3"],
      },
    },
  };

  it("resolves selectable id", () => {
    expect(resolveModelTarget(cfg, "deepseek/deepseek-reasoner")).toEqual({
      model: "deepseek-reasoner",
      providerId: "deepseek",
    });
  });

  it("keeps slash inside model when provider id matches longest prefix", () => {
    expect(resolveModelTarget(cfg, "siliconflow/deepseek-ai/DeepSeek-V3")).toEqual({
      model: "deepseek-ai/DeepSeek-V3",
      providerId: "siliconflow",
    });
  });

  it("falls back to bare model name", () => {
    expect(resolveModelTarget(cfg, "gpt-4o")).toEqual({ model: "gpt-4o" });
  });
});
