import type {
  CustomSearchTemplate,
  ImageGenConfig,
  WebSearchConfig,
} from "@codepilot/core";
import {
  buildSandboxUnavailable,
  collectPluginProviderTemplates,
  deleteUserProvider,
  detectSandboxBackend,
  findProviderIdForFlat,
  listProviderTemplates,
  listRemoteModels,
  listSearchEngines,
  listSelectableModels,
  loadConfigWithSources,
  redactProviderPreset,
  setUserActiveEndpoint,
  templateToPreset,
  upsertUserProvider,
  readUserConfigFile,
  writeUserConfigFile,
  type ProviderName,
  type ProviderPreset,
  type ResolvedCodepilotConfig,
} from "@codepilot/core";
import { ErrorCode, RpcError } from "../../rpc.js";
import { assertInitialized, requireSession, type ServerContext } from "../context.js";
import { loadConfigSafe } from "../loadConfigSafe.js";
import type {
  ConfigDeleteProviderParams,
  ConfigSetActiveParams,
  ConfigUpsertProviderParams,
} from "../wireTypes.js";

/** Wire shape of the sandbox availability status returned by
 * `config/setSandbox`. `reason` carries structured, platform-specific install
 * guidance when the active mode has no usable OS backend (fail-closed). */
type SandboxStatusWire = {
  mode: "off" | "workspace-write" | "read-only";
  unavailable: boolean;
  backend: string;
  reason?: { backend: string; platform: string; hint: string };
};

export async function handleConfigGet(
  ctx: ServerContext,
  params: { cwd?: string } = {},
): Promise<{
  active: {
    provider?: string;
    model?: string;
    smallModel?: string;
    baseURL?: string;
    providerId?: string;
    hasApiKey: boolean;
    apiKeyHint?: string;
    onboardedAt?: string;
  };
  providers: Record<string, ReturnType<typeof redactProviderPreset>>;
  selectableModels: ReturnType<typeof listSelectableModels>;
  templates: Awaited<ReturnType<typeof listProviderTemplates>>;
  imageGen: { baseURL?: string; model?: string; enabled: boolean; hasApiKey: boolean };
  webSearch: {
    provider?: string;
    hasApiKey: boolean;
    customUrl?: string;
    engineId?: string;
    custom?: CustomSearchTemplate;
    env?: Record<string, string>;
    engines: Awaited<ReturnType<typeof listSearchEngines>>;
  };
  sandbox: { mode: "off" | "workspace-write" | "read-only" };
}> {
  assertInitialized(ctx);
  const cwd = params?.cwd ?? ctx.defaultCwd;
  let config: ResolvedCodepilotConfig;
  try {
    const loaded = await loadConfigWithSources(cwd);
    config = loaded.config;
  } catch {
    config = (await loadConfigSafe(cwd)) as ResolvedCodepilotConfig ?? {};
  }
  const providers: Record<string, ReturnType<typeof redactProviderPreset>> = {};
  for (const [id, preset] of Object.entries(config.providers ?? {})) {
    providers[id] = redactProviderPreset(preset);
  }
  const { hasApiKey, apiKeyHint } = (() => {
    const key = config.apiKey;
    if (!key) return { hasApiKey: false as const };
    return {
      hasApiKey: true as const,
      apiKeyHint: key.length <= 4 ? "****" : key.slice(-4),
    };
  })();
  // Plugin-contributed templates merge on top of the bundled + GitHub catalog
  // (namespaced ids, pure data — no plugin code runs).
  const pluginTemplates = await collectPluginProviderTemplates(cwd).catch(() => []);
  const templates = await listProviderTemplates({ overlay: pluginTemplates });
  const searchEngines = await listSearchEngines().catch(() => []);
  return {
    active: {
      provider: config.provider,
      model: config.model,
      smallModel: config.smallModel,
      baseURL: config.baseURL,
      providerId: findProviderIdForFlat(config),
      hasApiKey,
      apiKeyHint,
      // The first-run marker so a remote client (TUI) can tell whether the user
      // has already completed onboarding instead of re-showing the setup guide.
      onboardedAt: config.onboardedAt,
    },
    providers,
    selectableModels: listSelectableModels(config),
    templates,
    imageGen: {
      baseURL: config.imageGen?.baseURL,
      model: config.imageGen?.model,
      enabled: config.imageGen?.enabled !== false,
      hasApiKey: !!config.imageGen?.apiKey,
    },
    webSearch: {
      provider: config.webSearch?.provider,
      hasApiKey: !!config.webSearch?.apiKey,
      customUrl: config.webSearch?.custom?.url,
      engineId: config.webSearch?.engineId,
      // Full template + env so settings can edit catalog/custom engines
      // without re-bundling the catalog shape. apiKey stays redacted.
      custom: config.webSearch?.custom,
      env: config.webSearch?.env,
      engines: searchEngines,
    },
    sandbox: {
      // Default mirrors core's resolveSandbox default (workspace-write).
      mode: config.sandbox?.mode ?? "workspace-write",
    },
  };
}

export async function handleConfigSetSandbox(
  ctx: ServerContext,
  params: { mode?: "off" | "workspace-write" | "read-only"; sessionId?: string },
): Promise<{ sandbox: SandboxStatusWire }> {
  assertInitialized(ctx);
  const mode = params?.mode;
  if (mode !== "off" && mode !== "workspace-write" && mode !== "read-only") {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `sandbox mode must be one of: off, workspace-write, read-only`,
    );
  }
  // Persist to the user config (next session inherits it) — same merge-and-write
  // pattern as config/setImageGen; other sandbox settings are preserved.
  const { raw } = await readUserConfigFile();
  const prev =
    raw.sandbox && typeof raw.sandbox === "object"
      ? { ...(raw.sandbox as Record<string, unknown>) }
      : {};
  prev.mode = mode;
  raw.sandbox = prev;
  await writeUserConfigFile(raw);
  // Hot-apply to the live session when the client names one, so the switch takes
  // effect immediately (from the next bash command) rather than next session.
  let status: SandboxStatusWire = { mode, unavailable: false, backend: detectSandboxBackend() };
  if (params.sessionId) {
    const session = requireSession(ctx, params.sessionId);
    const live = session.setSandboxMode(mode);
    status = {
      mode: live.mode,
      unavailable: live.unavailable,
      backend: live.backend,
      reason: live.reason
        ? { backend: live.reason.backend, platform: live.reason.platform, hint: live.reason.hint }
        : undefined,
    };
  } else if (mode !== "off" && detectSandboxBackend() === "none") {
    // No live session to probe fallback policy, but the configured mode clearly
    // has no backend on this host — surface the structured guidance anyway.
    const reason = buildSandboxUnavailable();
    status.reason = { backend: reason.backend, platform: reason.platform, hint: reason.hint };
  }
  return { sandbox: status };
}

export async function handleConfigUpsertProvider(
  ctx: ServerContext,
  params: ConfigUpsertProviderParams,
): Promise<{ providers: Record<string, ReturnType<typeof redactProviderPreset>> }> {
  assertInitialized(ctx);
  if (!params?.id || !params.preset?.provider) {
    throw new RpcError(ErrorCode.InvalidParams, "id and preset.provider required");
  }
 // Preserve existing apiKey when the client sends an empty placeholder.
  const cwd = ctx.defaultCwd;
  let existingKey: string | undefined;
  try {
    const loaded = await loadConfigWithSources(cwd);
    existingKey = loaded.config.providers?.[params.id]?.apiKey;
  } catch {
 /* ignore */
  }
  const preset: ProviderPreset = { ...params.preset };
  if ((!preset.apiKey || preset.apiKey === "") && existingKey) {
    preset.apiKey = existingKey;
  }
  const providers = await upsertUserProvider(params.id, preset);
  if (params.setActive) {
    const activeModel = preset.model;
    await setUserActiveEndpoint({
      providerId: params.id,
      provider: preset.provider,
      model: activeModel,
      smallModel: preset.smallModel,
      baseURL: preset.baseURL,
      apiKey: preset.apiKey,
      apiStyle: preset.apiStyle,
      headers: preset.headers,
      contextWindow: activeModel
        ? preset.modelCapabilities?.[activeModel]?.contextWindow
        : undefined,
    });
    if (params.sessionId) {
      const session = ctx.sessions.get(params.sessionId);
      if (session) {
        await session.setEndpoint({
          providerId: params.id,
          model: activeModel ?? session.getModel(),
        });
      }
    }
  }
  const redacted: Record<string, ReturnType<typeof redactProviderPreset>> = {};
  for (const [id, p] of Object.entries(providers)) {
    redacted[id] = redactProviderPreset(p);
  }
  return { providers: redacted };
}

export async function handleConfigDeleteProvider(
  ctx: ServerContext,
  params: ConfigDeleteProviderParams,
): Promise<{ providers: Record<string, ReturnType<typeof redactProviderPreset>> }> {
  assertInitialized(ctx);
  if (!params?.id) {
    throw new RpcError(ErrorCode.InvalidParams, "id required");
  }
  const providers = await deleteUserProvider(params.id);
  const redacted: Record<string, ReturnType<typeof redactProviderPreset>> = {};
  for (const [id, p] of Object.entries(providers)) {
    redacted[id] = redactProviderPreset(p);
  }
  return { providers: redacted };
}

export async function handleConfigListRemoteModels(
  ctx: ServerContext,
  params: {
    providerId?: string;
    provider?: ProviderName;
    baseURL?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{
  models: Array<{
    id: string;
    contextWindowMax?: number;
    modalities?: Array<"text" | "image" | "audio" | "video">;
    maxOutputTokens?: number;
  }>;
}> {
  assertInitialized(ctx);
  let provider: ProviderName = params.provider ?? "openai";
  let baseURL = params.baseURL;
  let apiKey = params.apiKey;
  let headers = params.headers;
  if (params.providerId) {
    const tmpl = (await listProviderTemplates()).find((t) => t.id === params.providerId);
    if (tmpl) {
      provider = tmpl.provider;
      baseURL = baseURL || tmpl.baseURL;
    }
    try {
      const loaded = await loadConfigWithSources(ctx.defaultCwd);
      const saved = loaded.config.providers?.[params.providerId];
      if (saved) {
        provider = saved.provider ?? provider;
        baseURL = baseURL || saved.baseURL;
        if (!apiKey) apiKey = saved.apiKey;
        if (!headers) headers = saved.headers;
      }
    } catch {
 /* ignore */
    }
  }
  if (provider === "openai" && !baseURL) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      "baseURL required to list models for OpenAI-compatible providers " +
        "(they have no fixed endpoint; Anthropic/Copilot/Gemini use their vendor default)",
    );
  }
  try {
    const models = await listRemoteModels({ provider, baseURL, apiKey, headers });
    return { models };
  } catch (err) {
    throw new RpcError(
      ErrorCode.InternalError,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function handleConfigSetImageGen(
  ctx: ServerContext,
  params: { baseURL?: string; apiKey?: string; model?: string; enabled?: boolean },
): Promise<{ imageGen: { baseURL?: string; model?: string; enabled: boolean; hasApiKey: boolean } }> {
  assertInitialized(ctx);
  const { raw } = await readUserConfigFile();
  const prev = (raw.imageGen as ImageGenConfig | undefined) ?? {};
  // Preserve the stored key when the client sends an empty placeholder.
  const apiKey =
    params.apiKey === undefined || params.apiKey === "" ? prev.apiKey : params.apiKey.trim();
  const next: ImageGenConfig = {
    baseURL: params.baseURL?.trim() || prev.baseURL,
    apiKey,
    model: params.model?.trim() || prev.model,
    enabled: params.enabled ?? prev.enabled ?? true,
  };
  raw.imageGen = next;
  await writeUserConfigFile(raw);
  return {
    imageGen: {
      baseURL: next.baseURL,
      model: next.model,
      enabled: next.enabled !== false,
      hasApiKey: !!next.apiKey,
    },
  };
}

/**
 * Persist the web_search backend to the shared user config, so every client
 * (TUI / web / desktop) that follows the same daemon inherits it. Writing an
 * empty apiKey preserves the stored one; a `custom` template is stored verbatim.
 * Pass `engineId`/`env`/`custom` as `null` to clear those fields.
 */
export async function handleConfigSetWebSearch(
  ctx: ServerContext,
  params: {
    provider?: WebSearchConfig["provider"];
    apiKey?: string;
    cx?: string;
    engineId?: string | null;
    env?: Record<string, string> | null;
    custom?: CustomSearchTemplate | null;
  },
): Promise<{
  webSearch: {
    provider?: string;
    hasApiKey: boolean;
    customUrl?: string;
    engineId?: string;
    custom?: CustomSearchTemplate;
    env?: Record<string, string>;
  };
}> {
  assertInitialized(ctx);
  const { raw } = await readUserConfigFile();
  const prev = (raw.webSearch as WebSearchConfig | undefined) ?? {};
  const apiKey =
    params.apiKey === undefined || params.apiKey === "" ? prev.apiKey : params.apiKey.trim();
  const next: WebSearchConfig = { ...prev };
  if (params.provider !== undefined) next.provider = params.provider;
  if (apiKey !== undefined) next.apiKey = apiKey;
  if (params.cx !== undefined) next.cx = params.cx.trim() || undefined;
  if (params.custom !== undefined) {
    next.custom = params.custom === null ? undefined : params.custom;
  }
  if (params.engineId !== undefined) {
    next.engineId = params.engineId === null || params.engineId === "" ? undefined : params.engineId;
  }
  if (params.env !== undefined) {
    if (params.env === null) {
      next.env = undefined;
    } else {
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(params.env)) {
        const key = k.trim();
        const val = typeof v === "string" ? v.trim() : "";
        if (key && val) cleaned[key] = val;
      }
      next.env = Object.keys(cleaned).length > 0 ? cleaned : undefined;
    }
  }
  // DuckDuckGo is keyless; clear a stale key/template so it doesn't leak through.
  if (next.provider === "duckduckgo") {
    next.apiKey = undefined;
    next.custom = undefined;
    next.engineId = undefined;
    next.env = undefined;
  }
  raw.webSearch = next;
  await writeUserConfigFile(raw);
  return {
    webSearch: {
      provider: next.provider,
      hasApiKey: !!next.apiKey,
      customUrl: next.custom?.url,
      engineId: next.engineId,
      custom: next.custom,
      env: next.env,
    },
  };
}

/**
 * Stamp the first-run marker in the shared user config so every client (TUI /
 * web / desktop) following the same daemon knows onboarding is done and does
 * not re-show its setup guide. Idempotent; keeps an existing marker.
 */
export async function handleConfigSetOnboarded(
  ctx: ServerContext,
  params: { onboardedAt?: string },
): Promise<{ onboardedAt: string }> {
  assertInitialized(ctx);
  const { raw } = await readUserConfigFile();
  const existing = typeof raw.onboardedAt === "string" ? raw.onboardedAt : undefined;
  const stamp = existing ?? params.onboardedAt ?? new Date().toISOString();
  raw.onboardedAt = stamp;
  await writeUserConfigFile(raw);
  return { onboardedAt: stamp };
}

export async function handleConfigSetActive(
  ctx: ServerContext,
  params: ConfigSetActiveParams,
): Promise<{ model: string; providerId: string }> {
  assertInitialized(ctx);
  if (!params?.providerId) {
    throw new RpcError(ErrorCode.InvalidParams, "providerId required");
  }
  const cwd = ctx.defaultCwd;
  let preset: ProviderPreset | undefined;
  try {
    const loaded = await loadConfigWithSources(cwd);
    preset = loaded.config.providers?.[params.providerId];
  } catch {
 /* ignore */
  }
  if (!preset) {
 // Allow activating a freshly-templated id that isn't saved yet by
 // looking up catalog templates.
    const tmpl = (await listProviderTemplates()).find((t) => t.id === params.providerId);
    if (tmpl) {
      preset = templateToPreset(tmpl);
      await upsertUserProvider(params.providerId, preset);
    }
  }
  if (!preset) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `unknown provider preset: ${params.providerId}`,
    );
  }
  const model = params.model ?? preset.model ?? preset.models?.[0];
  if (!model) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `no model specified for provider "${params.providerId}"; pass a model or set one in the provider preset`,
    );
  }
  const contextWindow = preset.modelCapabilities?.[model]?.contextWindow;
  if (params.persist !== false) {
    await setUserActiveEndpoint({
      providerId: params.providerId,
      provider: preset.provider as ProviderName,
      model,
      smallModel: preset.smallModel,
      baseURL: preset.baseURL,
      apiKey: preset.apiKey,
      apiStyle: preset.apiStyle,
      headers: preset.headers,
      contextWindow,
    });
  }
  if (params.sessionId) {
    const session = requireSession(ctx, params.sessionId);
    await session.setEndpoint({ providerId: params.providerId, model });
    return { model: session.getModel(), providerId: params.providerId };
  }
  return { model, providerId: params.providerId };
}