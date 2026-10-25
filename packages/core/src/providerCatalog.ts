// Provider catalog: vendor templates (GitHub JSON + daily cache), selectable
// model listing, user-config persistence, and apiKey redaction for clients.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodepilotConfig, ProviderName } from "./types.js";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  getUserConfigPath,
  type ModelCapabilities,
  type ModelModality,
  type ProviderPreset,
  type ProvidersConfig,
  type ResolvedCodepilotConfig,
  useProvider,
  resolveModelAlias,
} from "./config.js";
import { loadCatalogDocument } from "./remoteCatalog.js";

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

/** One model row from a provider `/models` probe (context + modalities). */
export interface RemoteModelInfo {
  id: string;
 /** Provider-reported context ceiling in tokens, when known. */
  contextWindowMax?: number;
  modalities?: ModelModality[];
  maxOutputTokens?: number;
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
 /** Per-model context ceiling + modalities (safe to show in UI). */
  modelCapabilities?: Record<string, ModelCapabilities>;
}

interface ProviderTemplatesDoc {
  version?: number;
  updatedAt?: string;
  templates?: ProviderTemplate[];
}

function bundledProviderTemplates(): ProviderTemplate[] {
  try {
    const path = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "catalog",
      "provider-templates.json",
    );
    const doc = JSON.parse(readFileSync(path, "utf-8")) as ProviderTemplatesDoc;
    return Array.isArray(doc.templates) ? doc.templates : [];
  } catch {
    return [];
  }
}

/** Offline / boot fallback (bundled JSON). Prefer {@link listProviderTemplates}. */
export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = bundledProviderTemplates();

function mergeTemplates(
  base: readonly ProviderTemplate[],
  overlay: ProviderTemplate[],
): ProviderTemplate[] {
  const map = new Map<string, ProviderTemplate>();
  for (const t of base) map.set(t.id, t);
  for (const t of overlay) {
    if (t?.id) map.set(t.id, t);
  }
  return [...map.values()];
}

/** GitHub catalog (update once per day; keep local forever on failure). */
export async function listProviderTemplates(opts?: {
  force?: boolean;
}): Promise<ProviderTemplate[]> {
  try {
    const { data } = await loadCatalogDocument<ProviderTemplatesDoc>(
      "provider-templates",
      opts,
    );
    const remote = Array.isArray(data.templates) ? data.templates : [];
    return mergeTemplates(PROVIDER_TEMPLATES, remote);
  } catch {
    return [...PROVIDER_TEMPLATES];
  }
}

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
    modelCapabilities: preset.modelCapabilities,
  };
}

/** Clamp a user context budget so it never exceeds the provider max. */
export function clampContextWindow(value: number, max: number): number {
  const ceiling = Math.max(1, Math.floor(max));
  const n = Math.floor(value);
  if (!Number.isFinite(n) || n < 1) return ceiling;
  return Math.min(n, ceiling);
}

const ALL_MODALITIES: readonly ModelModality[] = ["text", "image", "audio", "video"];

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

function nestedNumber(obj: Record<string, unknown>, ...path: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return asPositiveInt(cur);
}

/** Normalize modality tokens from vendor-specific `/models` payloads. */
export function parseModalities(raw: unknown): ModelModality[] | undefined {
  const found = new Set<ModelModality>();
  const add = (token: string): void => {
    const t = token.toLowerCase().trim();
    if (!t) return;
    if (t === "text" || t === "language" || t.includes("text")) found.add("text");
    if (t === "image" || t === "vision" || t.includes("image") || t.includes("vision")) {
      found.add("image");
    }
    if (t === "audio" || t === "speech" || t.includes("audio") || t.includes("speech")) {
      found.add("audio");
    }
    if (t === "video" || t.includes("video")) found.add("video");
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") add(item);
    }
  } else if (typeof raw === "string") {
    for (const part of raw.split(/[+|,/\s->]+/)) add(part);
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.input_text || o.text) found.add("text");
    if (o.input_image || o.vision || o.image) found.add("image");
    if (o.input_audio || o.audio) found.add("audio");
    if (o.input_video || o.video) found.add("video");
  }
  if (found.size === 0) return undefined;
  if (!found.has("text")) found.add("text");
  return ALL_MODALITIES.filter((m) => found.has(m));
}

/** Parse one `/models` data entry into RemoteModelInfo. */
export function parseRemoteModelEntry(raw: Record<string, unknown>): RemoteModelInfo | undefined {
  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : undefined;
  if (!id) return undefined;

  const contextWindowMax =
    asPositiveInt(raw.context_length) ??
    asPositiveInt(raw.context_window) ??
    asPositiveInt(raw.max_model_len) ??
    asPositiveInt(raw.max_context_length) ??
    nestedNumber(raw, "architecture", "context_length") ??
    nestedNumber(raw, "limits", "context_window") ??
    nestedNumber(raw, "limits", "max_context_tokens") ??
    nestedNumber(raw, "meta", "context_length") ??
 // Anthropic-style / some gateways
    asPositiveInt(raw.max_input_tokens) ??
    undefined;

  const maxOutputTokens =
    asPositiveInt(raw.max_output_tokens) ??
    asPositiveInt(raw.max_completion_tokens) ??
    nestedNumber(raw, "limits", "max_output_tokens") ??
    undefined;

  const modalities =
    parseModalities(raw.modalities) ??
    parseModalities(raw.supported_modalities) ??
    parseModalities(raw.input_modalities) ??
    parseModalities((raw.architecture as Record<string, unknown> | undefined)?.modality) ??
    parseModalities((raw.architecture as Record<string, unknown> | undefined)?.input_modalities) ??
    parseModalities((raw.capabilities as Record<string, unknown> | undefined)?.modalities) ??
    (() => {
      const caps = raw.capabilities;
      if (caps && typeof caps === "object") {
        const c = caps as Record<string, unknown>;
        if (c.vision === true || c.image === true) return ["text", "image"] as ModelModality[];
      }
      return undefined;
    })();

  return {
    id,
    ...(contextWindowMax !== undefined ? { contextWindowMax } : {}),
    ...(modalities ? { modalities } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

/**
 * Build effective model capabilities from `/models` (and optional prior edits).
 * Provider max is only set when the gateway reports it — we do not invent one
 * from a local model table. User budget defaults to 200k when unknown.
 */
export function resolveModelCapabilities(
  _modelId: string,
  remote?: Pick<RemoteModelInfo, "contextWindowMax" | "modalities" | "maxOutputTokens">,
  existing?: ModelCapabilities,
): ModelCapabilities {
  const max = remote?.contextWindowMax ?? existing?.contextWindowMax;
  let contextWindow =
    existing?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  if (max !== undefined) {
    // First-time with a reported max: start at the provider ceiling.
    if (existing?.contextWindow === undefined && remote?.contextWindowMax !== undefined) {
      contextWindow = max;
    } else {
      contextWindow = clampContextWindow(contextWindow, max);
    }
  }
  const modalities: ModelModality[] =
    existing?.modalities?.length
      ? existing.modalities
      : remote?.modalities?.length
        ? remote.modalities
        : ["text"];
  const normalized = modalities.includes("text")
    ? modalities
    : (["text", ...modalities] as ModelModality[]);
  const maxOutputTokens =
    remote?.maxOutputTokens ??
    existing?.maxOutputTokens ??
    DEFAULT_MODEL_MAX_OUTPUT_TOKENS;
  return {
    ...(max !== undefined ? { contextWindowMax: max } : {}),
    contextWindow,
    modalities: normalized,
    maxOutputTokens,
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
  const extended = withModel as ResolvedCodepilotConfig;
  const caps =
    (resolvedProviderId &&
      extended.providers?.[resolvedProviderId]?.modelCapabilities?.[resolved]) ||
    undefined;
  const out: CodepilotConfig = { ...withModel, model: resolved };
  if (caps) {
    out.contextWindow = caps.contextWindow;
    if (caps.maxOutputTokens !== undefined) {
      out.maxTokens = caps.maxOutputTokens;
    }
  }
  return {
    config: out,
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

/** Ensure per-model context budgets never exceed provider max (when known). */
export function normalizeProviderPreset(preset: ProviderPreset): ProviderPreset {
  if (!preset.modelCapabilities) return preset;
  const modelCapabilities: Record<string, ModelCapabilities> = {};
  for (const [modelId, caps] of Object.entries(preset.modelCapabilities)) {
    modelCapabilities[modelId] = {
      ...caps,
      contextWindow:
        caps.contextWindowMax !== undefined
          ? clampContextWindow(caps.contextWindow, caps.contextWindowMax)
          : Math.max(1, Math.floor(caps.contextWindow)),
      modalities: caps.modalities.includes("text")
        ? caps.modalities
        : (["text", ...caps.modalities] as ModelModality[]),
    };
  }
  return { ...preset, modelCapabilities };
}

/** Upsert a provider preset into the user-level config.json. */
export async function upsertUserProvider(
  id: string,
  preset: ProviderPreset,
): Promise<ProvidersConfig> {
  const normalized = normalizeProviderPreset(preset);
  const { raw } = await readUserConfigFile();
  const providers = {
    ...((raw.providers as ProvidersConfig | undefined) ?? {}),
    [id]: normalized,
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
 /** Effective context budget for the active model (≤ provider max). */
  contextWindow?: number;
}): Promise<void> {
  const { raw } = await readUserConfigFile();
  if (opts.provider !== undefined) raw.provider = opts.provider;
  if (opts.model !== undefined) raw.model = opts.model;
  if (opts.smallModel !== undefined) raw.smallModel = opts.smallModel;
  if (opts.baseURL !== undefined) raw.baseURL = opts.baseURL;
  if (opts.apiKey !== undefined) raw.apiKey = opts.apiKey;
  if (opts.providerId !== undefined) raw.activeProvider = opts.providerId;
  if (opts.contextWindow !== undefined) raw.contextWindow = opts.contextWindow;
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
 * Probe a provider for available models (OpenAI-compatible `/models`
 * or Anthropic Models API), including context window + modalities when
 * the vendor reports them. Used by settings UI — never logs the apiKey.
 */
export async function listRemoteModels(opts: {
  provider: ProviderName;
  baseURL?: string;
  apiKey?: string;
}): Promise<RemoteModelInfo[]> {
  const provider = opts.provider;
  const apiKey = opts.apiKey?.trim();
  if (provider === "copilot") {
 // Copilot models are fixed; no public list endpoint without a token dance.
    return (PROVIDER_TEMPLATES.find((t) => t.id === "copilot")?.models ?? []).map((id) => ({
      id,
    }));
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
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
 // Leave context/modalities blank when the vendor omits them — do not invent
 // values from a local model table.
    return (body.data ?? [])
      .map((m) => parseRemoteModelEntry(m))
      .filter((m): m is RemoteModelInfo => !!m)
      .sort((a, b) => a.id.localeCompare(b.id));
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
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return (body.data ?? [])
    .map((m) => parseRemoteModelEntry(m))
    .filter((m): m is RemoteModelInfo => !!m)
    .sort((a, b) => a.id.localeCompare(b.id));
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
