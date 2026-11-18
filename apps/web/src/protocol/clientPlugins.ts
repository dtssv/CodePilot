import type { PluginCapabilityReport } from "@codepilot/core";

import type { ClientRpcHost } from "./clientTypes.js";

/** Engine (CLI/daemon) update channel — not the IDE plugin / VSIX. */
export async function checkEngineUpdate(host: ClientRpcHost): Promise<{
  engine: {
    channel: "engine";
    current: string;
    latest: string | null;
    available: boolean;
    tag?: string;
    installRoot: string | null;
    canAutoApply: boolean;
  };
}> {
  return host.call("system/update-check", {});
}

export async function applyEngineUpdate(host: ClientRpcHost): Promise<{
  applied: boolean;
  version: string;
  message?: string;
}> {
  return host.call("system/update-apply", {});
}

export async function mintRemotePairing(
  host: ClientRpcHost,
  opts: {
    serveUrl: string;
    cwd?: string;
    cwds?: string[];
    sessionId?: string;
  },
): Promise<{
  code: string;
  url: string;
  qrPayload: string;
  expiresAt: number;
  qrDataUrl: string;
  rewritten?: boolean;
  warning?: string;
  lanIp?: string;
}> {
  return host.call("remote/pair-mint", opts);
}

export async function listMcpMarkets(host: ClientRpcHost): Promise<{
  markets: Array<{ id: string; name: string; description: string; url: string }>;
}> {
  return host.call("mcp/markets", {});
}

export async function installMcpJson(
  host: ClientRpcHost,
  json: string,
  name?: string,
): Promise<{
  mcpConfigPath: string;
  names: string[];
  message: string;
}> {
  return host.call("mcp/install-json", { json, name });
}

export async function listInstalledMcp(host: ClientRpcHost): Promise<{
  servers: Array<{
    name: string;
    enabled: boolean;
    summary: string;
    command?: string;
    url?: string;
    type?: string;
  }>;
}> {
  return host.call("mcp/list", {});
}

export async function setMcpEnabled(
  host: ClientRpcHost,
  name: string,
  enabled: boolean,
): Promise<{ name: string; enabled: boolean; message: string }> {
  return host.call("mcp/set-enabled", { name, enabled });
}

export async function inspectMcp(
  host: ClientRpcHost,
  name: string,
): Promise<{
  name: string;
  connected: boolean;
  tools: Array<{ name: string; description: string }>;
  resources: Array<{ uri: string; name: string; description?: string }>;
  prompts: Array<{ name: string; description?: string }>;
  error?: string;
  needsAuth?: boolean;
}> {
  return host.call("mcp/inspect", { name });
}

export async function startMcpOauth(host: ClientRpcHost, name: string): Promise<{
  state: "idle" | "pending" | "authorized" | "error";
  url?: string;
  error?: string;
}> {
  return host.call("mcp/oauth-start", { name });
}

export async function mcpOauthStatus(host: ClientRpcHost, name: string): Promise<{
  state: "idle" | "pending" | "authorized" | "error";
  url?: string;
  error?: string;
}> {
  return host.call("mcp/oauth-status", { name });
}

export async function cancelMcpOauth(
  host: ClientRpcHost,
  name: string,
): Promise<{ state: "idle" | "pending" | "authorized" | "error" }> {
  return host.call("mcp/oauth-cancel", { name });
}

export async function listPluginMarket(host: ClientRpcHost, query?: string): Promise<{
  plugins: Array<{
    name: string;
    description: string;
    source: string;
    version?: string;
    author?: string;
    tags?: string[];
  }>;
  describe: Record<string, string>;
}> {
  return host.call("plugins/market", query ? { query } : {});
}

export async function listInstalledPlugins(host: ClientRpcHost): Promise<{
  plugins: Array<{
    name: string;
    description: string;
    version: string;
    source: string;
    enabled: boolean;
    /** False when the plugin's hooks / MCP servers / runtime await approval. */
    trusted?: boolean;
  }>;
}> {
  return host.call("plugins/list", {});
}

export async function trustPlugin(host: ClientRpcHost, name: string): Promise<{ trusted: boolean }> {
  return host.call("plugins/trust", { name });
}

export async function inspectPlugin(host: ClientRpcHost, source: string): Promise<PluginCapabilityReport> {
  return host.call("plugins/inspect", { source });
}

export async function installPlugin(
  host: ClientRpcHost,
  source: string,
  force?: boolean,
): Promise<{ name: string; path: string }> {
  return host.call("plugins/install", force ? { source, force } : { source });
}

export async function uninstallPlugin(host: ClientRpcHost, name: string): Promise<{ removed: boolean }> {
  return host.call("plugins/uninstall", { name });
}

export async function revokeAllRemote(host: ClientRpcHost): Promise<{ revoked: boolean }> {
  return host.call("remote/revoke-all", {});
}

export async function listConnectors(
  host: ClientRpcHost,
  opts?: {
    q?: string;
    tab?: "all" | "installed" | "available";
    offset?: number;
    limit?: number;
  },
): Promise<{
  connectors: unknown[];
  total: number;
  offset: number;
  limit: number;
}> {
  return host.call("connectors/list", opts ?? {});
}

export async function installConnector(
  host: ClientRpcHost,
  connectorId: string,
  values: Record<string, string>,
): Promise<{ mcpName?: string; skillPath?: string; mcpConfigPath: string; message: string }> {
  return host.call("connectors/install", { connectorId, values });
}

export async function updateConnector(
  host: ClientRpcHost,
  connectorId: string,
  values: Record<string, string>,
): Promise<{ mcpName?: string; skillPath?: string; mcpConfigPath: string; message: string }> {
  return host.call("connectors/update", { connectorId, values });
}

export async function setConnectorEnabled(
  host: ClientRpcHost,
  connectorId: string,
  enabled: boolean,
): Promise<{ connectorId: string; enabled: boolean; message: string }> {
  return host.call("connectors/set-enabled", { connectorId, enabled });
}

export async function listSkills(
  host: ClientRpcHost,
  opts?: {
    q?: string;
    tab?: "all" | "installed" | "available";
    offset?: number;
    limit?: number;
  },
): Promise<{
  skills: Array<{
    name: string;
    description: string;
    state: "installed" | "available";
    enabled: boolean;
    source?: string;
    connectorId?: string;
    when?: string;
  }>;
  total: number;
  offset: number;
  limit: number;
}> {
  return host.call("skills/list", opts ?? {});
}

export async function installSkill(
  host: ClientRpcHost,
  connectorId: string,
): Promise<{ skillPath: string; message: string }> {
  return host.call("skills/install", { connectorId });
}

export async function installSkillArchive(
  host: ClientRpcHost,
  filename: string,
  dataBase64: string,
): Promise<{
  names: string[];
  replaced: string[];
  skillPaths: string[];
  message: string;
}> {
  return host.call("skills/install-archive", { filename, dataBase64 });
}

/**
 * Install a skill from a git URL, remote archive URL, or local path (the
 * same source vector as plugin install). Complements the connector-catalog
 * and zip-upload paths with a "paste a repo/URL" entry.
 */
export async function installSkillSource(host: ClientRpcHost, source: string): Promise<{
  names: string[];
  replaced: string[];
  skillPaths: string[];
  message: string;
}> {
  return host.call("skills/install-source", { source });
}

export async function setSkillEnabled(
  host: ClientRpcHost,
  name: string,
  enabled: boolean,
): Promise<{ name: string; enabled: boolean; message: string }> {
  return host.call("skills/set-enabled", { name, enabled });
}

export async function getSkillContent(host: ClientRpcHost, name: string): Promise<{
  name: string;
  markdown: string;
  path: string;
  source?: string;
  editablePath: string;
  readOnlySource: boolean;
  rootDir?: string;
  files?: string[];
}> {
  return host.call("skills/get", { name });
}

export async function getSkillFile(
  host: ClientRpcHost,
  name: string,
  relativePath: string,
): Promise<{
  name: string;
  relativePath: string;
  content: string;
  rootDir: string;
  readOnlySource: boolean;
}> {
  return host.call("skills/get-file", { name, relativePath });
}

export async function saveSkillContent(
  host: ClientRpcHost,
  name: string,
  markdown: string,
): Promise<{ name: string; path: string; message: string }> {
  return host.call("skills/save", { name, markdown });
}

export async function saveSkillFile(
  host: ClientRpcHost,
  name: string,
  relativePath: string,
  content: string,
): Promise<{ name: string; path: string; message: string }> {
  return host.call("skills/save-file", { name, relativePath, content });
}

export async function skillCreatorPrompt(host: ClientRpcHost): Promise<{ prompt: string }> {
  return host.call("skills/creator-prompt", {});
}

export async function listScheduledTasks(host: ClientRpcHost): Promise<{ tasks: unknown[] }> {
  return host.call("schedule/list", {});
}

export async function addScheduledTask(
  host: ClientRpcHost,
  task: {
    title: string;
    prompt: string;
    cwd?: string;
    kind: "idle" | "once" | "daily" | "weekly" | "interval" | "cron";
    at?: string;
    daysOfWeek?: number[];
    cron?: string;
    timezone?: string;
    runAt?: number;
    everyMinutes?: number;
    idleAfterMs?: number;
    delivery?: "new_session" | { sessionId: string };
    paused?: boolean;
    endsAt?: number;
    model?: string;
    providerId?: string;
    agentMode?: "chat" | "plan" | "agent";
  },
): Promise<{ task: unknown }> {
  return host.call("schedule/add", task);
}

export async function updateScheduledTask(
  host: ClientRpcHost,
  id: string,
  patch: {
    title?: string;
    prompt?: string;
    cwd?: string;
    at?: string;
    daysOfWeek?: number[];
    cron?: string;
    timezone?: string;
    runAt?: number;
    everyMinutes?: number;
    idleAfterMs?: number;
    delivery?: "new_session" | { sessionId: string };
    paused?: boolean;
    endsAt?: number;
    model?: string;
    providerId?: string;
    agentMode?: "chat" | "plan" | "agent";
    enabled?: boolean;
  },
): Promise<{ task: unknown }> {
  return host.call("schedule/update", { id, ...patch });
}

export async function removeScheduledTask(host: ClientRpcHost, id: string): Promise<{ removed: boolean }> {
  return host.call("schedule/remove", { id });
}