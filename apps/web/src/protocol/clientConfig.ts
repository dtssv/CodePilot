import type {
  ClientRpcHost,
  ConfigProviderPreset,
  ConfigProviderRedacted,
  ConfigSnapshot,
  CustomSearchTemplateInfo,
  RemoteModelInfo,
} from "./clientTypes.js";

export async function getConfig(host: ClientRpcHost, cwd?: string): Promise<ConfigSnapshot> {
  return host.call("config/get", { cwd });
}

export async function setImageGen(
  host: ClientRpcHost,
  patch: {
    baseURL?: string;
    apiKey?: string;
    model?: string;
    enabled?: boolean;
  },
): Promise<{ imageGen: { baseURL?: string; model?: string; enabled: boolean; hasApiKey: boolean } }> {
  return host.call("config/setImageGen", patch);
}

/**
 * Set the web_search backend. Persists to the shared user config, so every
 * client following the same daemon inherits it. An empty apiKey keeps the
 * stored one; `custom` carries a full HTTP template.
 */
export async function setWebSearch(
  host: ClientRpcHost,
  patch: {
    provider?: "duckduckgo" | "brave" | "serper" | "google" | "custom";
    apiKey?: string;
    cx?: string;
    engineId?: string | null;
    env?: Record<string, string> | null;
    custom?: CustomSearchTemplateInfo | null;
  },
): Promise<{
  webSearch: {
    provider?: string;
    hasApiKey: boolean;
    customUrl?: string;
    engineId?: string;
    custom?: CustomSearchTemplateInfo;
    env?: Record<string, string>;
  };
}> {
  return host.call("config/setWebSearch", patch);
}

/** Stamp the first-run marker in the shared config (idempotent). */
export async function setOnboarded(host: ClientRpcHost): Promise<{ onboardedAt: string }> {
  return host.call("config/setOnboarded", {});
}

/**
 * Change the OS sandbox mode. Persists to the user config (next session
 * inherits it); pass `sessionId` to also hot-apply it to that live session so
 * the switch takes effect from the next bash command.
 */
export async function setSandbox(
  host: ClientRpcHost,
  patch: {
    mode: "off" | "workspace-write" | "read-only";
    sessionId?: string;
  },
): Promise<{
  sandbox: {
    mode: "off" | "workspace-write" | "read-only";
    unavailable: boolean;
    backend: string;
    reason?: { backend: string; platform: string; hint: string };
  };
}> {
  return host.call("config/setSandbox", patch);
}

export async function upsertProvider(
  host: ClientRpcHost,
  id: string,
  preset: ConfigProviderPreset,
  opts?: { setActive?: boolean; sessionId?: string },
): Promise<{ providers: Record<string, ConfigProviderRedacted> }> {
  return host.call("config/upsertProvider", {
    id,
    preset,
    setActive: opts?.setActive,
    sessionId: opts?.sessionId,
  });
}

export async function deleteProvider(
  host: ClientRpcHost,
  id: string,
): Promise<{ providers: Record<string, ConfigProviderRedacted> }> {
  return host.call("config/deleteProvider", { id });
}

export async function setActiveProvider(
  host: ClientRpcHost,
  providerId: string,
  opts?: { model?: string; sessionId?: string; persist?: boolean },
): Promise<{ model: string; providerId: string }> {
  return host.call("config/setActive", {
    providerId,
    model: opts?.model,
    sessionId: opts?.sessionId,
    persist: opts?.persist,
  });
}

export async function listRemoteModels(
  host: ClientRpcHost,
  opts: {
    providerId?: string;
    provider?: "anthropic" | "openai" | "copilot" | "gemini" | "azure";
    baseURL?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  },
): Promise<RemoteModelInfo[]> {
  const { models } = await host.call<{ models: RemoteModelInfo[] }>(
    "config/listRemoteModels",
    opts,
  );
  return models;
}