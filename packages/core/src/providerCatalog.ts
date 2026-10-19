// Provider catalog: built-in vendor templates, selectable model listing,
// user-config persistence, and apiKey redaction for protocol clients.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodepilotConfig, ProviderName } from "./types.js";
import {
  getUserConfigPath,
  type ProviderPreset,
  type ProvidersConfig,
  type ResolvedCodepilotConfig,
  useProvider,
  resolveModelAlias,
} from "./config.js";

/** One row in the cross-provider model picker. */
export interface SelectableModel {
 /** Stable id: `${providerId}/${model}`. */
  id: string;
  providerId: string;
  providerLabel: string;
  model: string;
  kind: "chat" | "small";
}

/** Built-in vendor template (no secrets). */
export interface ProviderTemplate {
  id: string;
  displayName: string;
  provider: ProviderName;
  baseURL?: string;
  models?: string[];
  smallModel?: string;
 /** Hint shown in the settings UI. */
  description?: string;
 /**
 * When true the settings UI requires the user to supply `baseURL`
 * (custom OpenAI-compatible gateways). Built-ins hide baseURL.
 */
  requiresBaseURL?: boolean;
}

/** Desensitized preset for `config/get`. */
export interface RedactedProviderPreset {
  provider: ProviderName;
  displayName?: string;
  baseURL?: string;
 /** True when an apiKey is configured (value never returned). */
  hasApiKey: boolean;
 /** Last 4 chars of the key when present. */
  apiKeyHint?: string;
  model?: string;
  smallModel?: string;
  models?: string[];
}

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    provider: "anthropic",
    models: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
    smallModel: "claude-haiku-4-5",
    description: "Claude Messages API",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    provider: "openai",
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "o4-mini"],
    smallModel: "gpt-4.1-mini",
    description: "OpenAI Chat Completions",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    provider: "openai",
    baseURL: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    smallModel: "deepseek-chat",
    description: "OpenAI-compatible",
  },
  {
    id: "tongyi",
    displayName: "通义千问",
    provider: "openai",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-turbo", "qwen-max"],
    smallModel: "qwen-turbo",
    description: "DashScope OpenAI-compatible",
  },
  {
    id: "moonshot",
    displayName: "Moonshot / Kimi",
    provider: "openai",
    baseURL: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-turbo-preview", "moonshot-v1-128k", "moonshot-v1-32k"],
    smallModel: "moonshot-v1-32k",
    description: "OpenAI-compatible",
  },
  {
    id: "zhipu",
    displayName: "智谱 GLM",
    provider: "openai",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5", "glm-4.5-air", "glm-4-flash"],
    smallModel: "glm-4-flash",
    description: "OpenAI-compatible",
  },
  {
    id: "siliconflow",
    displayName: "SiliconFlow",
    provider: "openai",
    baseURL: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
    description: "OpenAI-compatible aggregator",
  },
  {
    id: "ollama",
    displayName: "Ollama",
    provider: "openai",
    baseURL: "http://127.0.0.1:11434/v1",
    models: ["llama3.2", "qwen2.5-coder", "deepseek-r1"],
    smallModel: "llama3.2",
    description: "Local OpenAI-compatible",
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    provider: "openai",
    baseURL: "https://openrouter.ai/api/v1",
    models: ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1"],
    description: "OpenAI-compatible multi-vendor gateway",
  },
  {
    id: "groq",
    displayName: "Groq",
    provider: "openai",
    baseURL: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
    description: "OpenAI-compatible",
  },
  {
    id: "custom-openai",
    displayName: "Custom (OpenAI protocol)",
    provider: "openai",
    models: [],
    requiresBaseURL: true,
    description: "Any Chat Completions gateway — set baseURL yourself",
  },
  {
    id: "custom-anthropic",
    displayName: "Custom (Claude protocol)",
    provider: "anthropic",
    models: [],
    requiresBaseURL: true,
    description: "Any Anthropic Messages-compatible gateway — set baseURL yourself",
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot",
    provider: "copilot",
    models: ["gpt-4.1", "gpt-4o"],
    description: "Requires GITHUB_TOKEN",
  },
];

/** Allocate a unique providers-map id from a template / base name. */
export function nextProviderId(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const root = base.trim() || "endpoint";
  if (!taken.has(root)) return root;
  let i = 2;
  while (taken.has(`${root}-${i}`)) i++;
  return `${root}-${i}`;
}

const SYNTHETIC_ACTIVE_ID = "_active";

/**
 * Pick a concrete chat model when the caller did not pass one.
 * Prefer flat `config.model`, then `activeProvider`'s preset, then the first
 * selectable chat model from `providers`. Never invent a vendor default
 * (the old `"claude-sonnet-4-5"` fallback showed up as a phantom model).
 */
export function resolveDefaultModel(
  config: CodepilotConfig | ResolvedCodepilotConfig,
): { model: string; providerId?: string } | undefined {
  const extended = config as ResolvedCodepilotConfig;
  if (config.model) {
    return {
      model: resolveModelAlias(extended) ?? config.model,
      providerId: findProviderIdForFlat(extended),
    };
  }
  const activeId =
    typeof (extended as { activeProvider?: string }).activeProvider === "string"
      ? (extended as { activeProvider?: string }).activeProvider
      : undefined;
  if (activeId && extended.providers?.[activeId]) {
    const preset = extended.providers[activeId]!;
    const model = preset.model ?? preset.models?.[0];
    if (model) return { model, providerId: activeId };
  }
  const chat = listSelectableModels(config).filter((m) => m.kind === "chat");
  if (chat[0]) return { model: chat[0].model, providerId: chat[0].providerId };
  return undefined;
}

/** List every (providerId, model) pair the UI/CLI can switch to. */
export function listSelectableModels(
  config: CodepilotConfig | ResolvedCodepilotConfig,
): SelectableModel[] {
  const extended = config as ResolvedCodepilotConfig;
  const out: SelectableModel[] = [];
  const seen = new Set<string>();

  const push = (
    providerId: string,
    providerLabel: string,
    model: string,
    kind: "chat" | "small" = "chat",
  ): void => {
    const id = `${providerId}/${model}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, providerId, providerLabel, model, kind });
  };

  const providers = extended.providers ?? {};
  for (const [id, preset] of Object.entries(providers)) {
    const label = preset.displayName ?? id;
    const models = new Set<string>();
    for (const m of preset.models ?? []) models.add(m);
    if (preset.model) models.add(preset.model);
    if (preset.smallModel) models.add(preset.smallModel);
    if (models.size === 0 && preset.model) models.add(preset.model);
    for (const m of models) {
      const kind =
        preset.smallModel && m === preset.smallModel && m !== preset.model
          ? "small"
          : "chat";
      push(id, label, m, kind);
    }
  }

 // Flat top-level config as a synthetic preset when it isn't already covered.
  if (config.model) {
    const flatId = findProviderIdForFlat(extended) ?? SYNTHETIC_ACTIVE_ID;
    const label =
      flatId === SYNTHETIC_ACTIVE_ID
        ? "Active"
        : (providers[flatId]?.displayName ?? flatId);
    push(flatId, label, config.model, "chat");
  }
  if (config.smallModel && config.smallModel !== config.model) {
    const flatId = findProviderIdForFlat(extended) ?? SYNTHETIC_ACTIVE_ID;
    const label =
      flatId === SYNTHETIC_ACTIVE_ID
        ? "Active"
        : (providers[flatId]?.displayName ?? flatId);
    push(flatId, label, config.smallModel, "small");
  }

 // Aliases as selectable chat models under the active provider.
  const aliases = extended.models?.aliases ?? {};
  const activeId = findProviderIdForFlat(extended) ?? SYNTHETIC_ACTIVE_ID;
  const activeLabel =
    activeId === SYNTHETIC_ACTIVE_ID
      ? "Active"
      : (providers[activeId]?.displayName ?? activeId);
  for (const [alias, target] of Object.entries(aliases)) {
    push(activeId, activeLabel, alias, "chat");
    push(activeId, activeLabel, target, "chat");
  }

  return out;
}

/** Best-effort match of flat config fields to a named providers entry. */
export function findProviderIdForFlat(
  config: ResolvedCodepilotConfig,
): string | undefined {
  const providers = config.providers ?? {};
  for (const [id, preset] of Object.entries(providers)) {
    if (
      (preset.provider === undefined || preset.provider === config.provider) &&
      (preset.baseURL === undefined || preset.baseURL === config.baseURL) &&
      (preset.model === undefined ||
        preset.model === config.model ||
        (preset.models ?? []).includes(config.model ?? ""))
    ) {
 // Prefer exact baseURL+provider match.
      if (preset.provider === config.provider && preset.baseURL === config.baseURL) {
        return id;
      }
    }
  }
  for (const [id, preset] of Object.entries(providers)) {
    if (preset.provider === config.provider && preset.baseURL === config.baseURL) {
      return id;
    }
  }
  for (const [id, preset] of Object.entries(providers)) {
    if (preset.provider === config.provider) return id;
  }
  return undefined;
}

export function redactApiKey(apiKey: string | undefined): {
  hasApiKey: boolean;
  apiKeyHint?: string;
} {
  if (!apiKey || apiKey.trim() === "") return { hasApiKey: false };
  const trimmed = apiKey.trim();
  const hint = trimmed.length <= 4 ? "****" : trimmed.slice(-4);
  return { hasApiKey: true, apiKeyHint: hint };
}

export function redactProviderPreset(preset: ProviderPreset): RedactedProviderPreset {
  const { hasApiKey, apiKeyHint } = redactApiKey(preset.apiKey);
  return {
    provider: preset.provider,
    displayName: preset.displayName,
    baseURL: preset.baseURL,
    hasApiKey,
    apiKeyHint,
    model: preset.model,
    smallModel: preset.smallModel,
    models: preset.models,
  };
}

/** Apply a named provider + model onto a config copy. */
export function applyProviderAndModel(
  config: CodepilotConfig,
  providerId: string | undefined,
  model: string,
): { config: CodepilotConfig; providerId?: string; model: string } {
  let next = { ...config };
  let resolvedProviderId = providerId;
  if (providerId && providerId !== SYNTHETIC_ACTIVE_ID) {
    next = useProvider(next, providerId);
  } else if (!providerId) {
    resolvedProviderId = findProviderIdForFlat(next as ResolvedCodepilotConfig);
  }
  const withModel = { ...next, model };
  const resolved = resolveModelAlias(withModel) ?? model;
  return {
    config: { ...withModel, model: resolved },
    providerId: resolvedProviderId,
    model: resolved,
  };
}

export interface UserConfigFile {
  raw: Record<string, unknown>;
  path: string;
}

export async function readUserConfigFile(): Promise<UserConfigFile> {
  const path = getUserConfigPath();
  try {
    const text = await readFile(path, "utf-8");
    const raw = JSON.parse(text) as Record<string, unknown>;
    return { raw: raw && typeof raw === "object" ? raw : {}, path };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { raw: {}, path };
    throw err;
  }
}

export async function writeUserConfigFile(
  raw: Record<string, unknown>,
): Promise<string> {
  const path = getUserConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  return path;
}

/** Upsert a provider preset into the user-level config.json. */
export async function upsertUserProvider(
  id: string,
  preset: ProviderPreset,
): Promise<ProvidersConfig> {
  const { raw } = await readUserConfigFile();
  const providers = {
    ...((raw.providers as ProvidersConfig | undefined) ?? {}),
    [id]: preset,
  };
  raw.providers = providers;
  await writeUserConfigFile(raw);
  return providers;
}

/** Delete a provider preset from the user-level config.json. */
export async function deleteUserProvider(id: string): Promise<ProvidersConfig> {
  const { raw } = await readUserConfigFile();
  const providers = {
    ...((raw.providers as ProvidersConfig | undefined) ?? {}),
  };
  delete providers[id];
  raw.providers = providers;
  await writeUserConfigFile(raw);
  return providers;
}

/**
 * Persist the active flat endpoint fields onto the user config
 * (and optionally stamp `activeProvider`).
 */
export async function setUserActiveEndpoint(opts: {
  providerId?: string;
  provider?: ProviderName;
  model?: string;
  smallModel?: string;
  baseURL?: string;
  apiKey?: string;
}): Promise<void> {
  const { raw } = await readUserConfigFile();
  if (opts.provider !== undefined) raw.provider = opts.provider;
  if (opts.model !== undefined) raw.model = opts.model;
  if (opts.smallModel !== undefined) raw.smallModel = opts.smallModel;
  if (opts.baseURL !== undefined) raw.baseURL = opts.baseURL;
  if (opts.apiKey !== undefined) raw.apiKey = opts.apiKey;
  if (opts.providerId !== undefined) raw.activeProvider = opts.providerId;
  await writeUserConfigFile(raw);
}

export function templateToPreset(template: ProviderTemplate): ProviderPreset {
  return {
    provider: template.provider,
    displayName: template.displayName,
    baseURL: template.baseURL,
    model: template.models?.[0],
    smallModel: template.smallModel,
    models: template.models?.length ? [...template.models] : undefined,
  };
}

/**
 * Resolve a `/model` argument against configured selectable models.
 * Accepts a selectable id (`providerId/model`), a bare model name, or
 * `providerId/...` when `providerId` is a known providers key.
 */
/**
 * Probe a provider for available model ids (OpenAI-compatible `/models`
 * or Anthropic Models API). Used by settings UI so the user can pick
 * which models to enable — never logs the apiKey.
 */
export async function listRemoteModels(opts: {
  provider: ProviderName;
  baseURL?: string;
  apiKey?: string;
}): Promise<string[]> {
  const provider = opts.provider;
  const apiKey = opts.apiKey?.trim();
  if (provider === "copilot") {
 // Copilot models are fixed; no public list endpoint without a token dance.
    return [...(PROVIDER_TEMPLATES.find((t) => t.id === "copilot")?.models ?? [])];
  }
  const local =
    !!opts.baseURL &&
    (() => {
      try {
        const host = new URL(opts.baseURL!).hostname;
        return host === "127.0.0.1" || host === "localhost";
      } catch {
        return false;
      }
    })();
  if (!apiKey && !local) {
    throw new Error("apiKey required to list models");
  }
  if (provider === "anthropic") {
    if (!apiKey) throw new Error("apiKey required to list Anthropic models");
    const root = (opts.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
 // Official API is `/v1/models`; some proxies already include `/v1` in baseURL.
    const url = /\/v1$/i.test(root) ? `${root}/models?limit=100` : `${root}/v1/models?limit=100`;
    const res = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) {
      throw new Error(`Anthropic models HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort();
  }
 // openai-compatible
  const base = (opts.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${base}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`List models HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

export function resolveModelTarget(
  config: CodepilotConfig | ResolvedCodepilotConfig,
  target: string,
): { model: string; providerId?: string } {
  const selectable = listSelectableModels(config);
  const byId = selectable.find((m) => m.id === target);
  if (byId) return { model: byId.model, providerId: byId.providerId };
  const byModel = selectable.filter((m) => m.model === target);
  if (byModel.length === 1) {
    return { model: byModel[0]!.model, providerId: byModel[0]!.providerId };
  }
  const providerIds = Object.keys(
    (config as ResolvedCodepilotConfig).providers ?? {},
  );
  const matched = providerIds
    .filter((pid) => target.startsWith(`${pid}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (matched) {
    return { providerId: matched, model: target.slice(matched.length + 1) };
  }
  return { model: target };
}
