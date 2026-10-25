/**
 * MCP marketplace links (open directories) + paste-JSON installer.
 * Market URLs live in catalog/mcp-markets.json (GitHub, daily refresh).
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalogDocument } from "./remoteCatalog.js";
import { McpManager } from "./mcp.js";
import type { McpServerConfigEntry } from "./mcp-types.js";

export interface McpMarketLink {
  id: string;
  name: string;
  description: string;
  url: string;
}

interface McpMarketsDoc {
  version?: number;
  markets?: McpMarketLink[];
}

function bundledMarkets(): McpMarketLink[] {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "catalog", "mcp-markets.json");
    const doc = JSON.parse(readFileSync(path, "utf-8")) as McpMarketsDoc;
    return Array.isArray(doc.markets) ? doc.markets : [];
  } catch {
    return [];
  }
}

/** Open MCP marketplaces for users to browse in the browser. */
export async function listMcpMarkets(opts?: { force?: boolean }): Promise<McpMarketLink[]> {
  try {
    const { data } = await loadCatalogDocument<McpMarketsDoc>("mcp-markets", opts);
    const remote = Array.isArray(data.markets) ? data.markets : [];
    if (remote.length > 0) return remote;
  } catch {
    /* fall through */
  }
  return bundledMarkets();
}

function defaultMcpConfigPath(): string {
  return join(homedir(), ".codepilot", "mcp.json");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface InstallMcpJsonResult {
  mcpConfigPath: string;
  names: string[];
  message: string;
}

/**
 * Merge a pasted mcpServers JSON blob into ~/.codepilot/mcp.json.
 * Accepts full `{ "mcpServers": { ... } }` or a single server object with a name.
 */
export async function installMcpJson(
  raw: string,
  opts?: { mcpConfigPath?: string; name?: string },
): Promise<InstallMcpJsonResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON — paste a valid mcpServers configuration.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("JSON must be an object.");
  }
  const obj = parsed as Record<string, unknown>;
  let incoming: Record<string, unknown> = {};

  if (obj.mcpServers && typeof obj.mcpServers === "object") {
    incoming = obj.mcpServers as Record<string, unknown>;
  } else if (obj.servers && typeof obj.servers === "object") {
    incoming = obj.servers as Record<string, unknown>;
  } else if (opts?.name?.trim()) {
    incoming = { [opts.name.trim()]: obj };
  } else if (obj.command || obj.url) {
    throw new Error('Provide a top-level "mcpServers" map, or pass a server name.');
  } else {
    incoming = obj;
  }

  const names = Object.keys(incoming);
  if (names.length === 0) throw new Error("No servers found in JSON.");

  const mcpPath = opts?.mcpConfigPath ?? defaultMcpConfigPath();
  await mkdir(join(mcpPath, ".."), { recursive: true });
  const cfg = await readJson(mcpPath);
  const servers =
    (cfg.mcpServers as Record<string, unknown> | undefined) ??
    (cfg.servers as Record<string, unknown> | undefined) ??
    {};
  for (const [k, v] of Object.entries(incoming)) {
    servers[k] = v;
  }
  await writeFile(
    mcpPath,
    JSON.stringify({ ...cfg, mcpServers: servers }, null, 2) + "\n",
    "utf-8",
  );
  return {
    mcpConfigPath: mcpPath,
    names,
    message: `已安装连接器：${names.join(", ")}。重新加载后生效。`,
  };
}

export interface InstalledMcpServer {
  name: string;
  enabled: boolean;
  /** Short summary for the UI (command / url), no secrets. */
  summary: string;
  command?: string;
  url?: string;
  type?: string;
}

function summarizeServer(cfg: Record<string, unknown>): string {
  const typ = typeof cfg.type === "string" ? cfg.type : undefined;
  if (typeof cfg.url === "string" && cfg.url.trim()) {
    return `${typ ?? "http"} · ${cfg.url}`;
  }
  const cmd = typeof cfg.command === "string" ? cfg.command : "";
  const args = Array.isArray(cfg.args)
    ? (cfg.args as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const line = [cmd, ...args].filter(Boolean).join(" ").trim();
  return line || (typ ?? "stdio");
}

/** List MCP servers from `~/.codepilot/mcp.json` (Settings → 自定义连接器). */
export async function listInstalledMcpServers(opts?: {
  mcpConfigPath?: string;
}): Promise<InstalledMcpServer[]> {
  const path = opts?.mcpConfigPath ?? defaultMcpConfigPath();
  const cfg = await readJson(path);
  const servers = (cfg.mcpServers ?? cfg.servers ?? {}) as Record<string, unknown>;
  const out: InstalledMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    out.push({
      name,
      enabled: entry.disabled !== true,
      summary: summarizeServer(entry),
      command: typeof entry.command === "string" ? entry.command : undefined,
      url: typeof entry.url === "string" ? entry.url : undefined,
      type: typeof entry.type === "string" ? entry.type : undefined,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Enable / disable an installed MCP without removing its config. */
export async function setMcpServerEnabled(
  name: string,
  enabled: boolean,
  opts?: { mcpConfigPath?: string },
): Promise<{ name: string; enabled: boolean; message: string }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("MCP 名称不能为空");
  const path = opts?.mcpConfigPath ?? defaultMcpConfigPath();
  const cfg = await readJson(path);
  const servers = {
    ...((cfg.mcpServers ?? cfg.servers ?? {}) as Record<string, Record<string, unknown>>),
  };
  const entry = servers[trimmed];
  if (!entry || typeof entry !== "object") {
    throw new Error(`未安装 MCP：${trimmed}`);
  }
  if (enabled) {
    const { disabled: _d, ...rest } = entry;
    servers[trimmed] = rest;
  } else {
    servers[trimmed] = { ...entry, disabled: true };
  }
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ ...cfg, mcpServers: servers }, null, 2) + "\n",
    "utf-8",
  );
  return {
    name: trimmed,
    enabled,
    message: enabled
      ? `已启用「${trimmed}」。新会话生效。`
      : `已停用「${trimmed}」。配置仍保留。`,
  };
}

export interface McpCapabilityTool {
  name: string;
  description: string;
}

export interface McpCapabilityResource {
  uri: string;
  name: string;
  description?: string;
}

export interface McpCapabilityPrompt {
  name: string;
  description?: string;
}

export interface InspectMcpServerResult {
  name: string;
  connected: boolean;
  tools: McpCapabilityTool[];
  resources: McpCapabilityResource[];
  prompts: McpCapabilityPrompt[];
  error?: string;
  /** True when the failure looks like missing / expired OAuth. */
  needsAuth?: boolean;
}

function looksLikeAuthError(message: string): boolean {
  return /\b401\b|unauthori[sz]ed|www-authenticate|oauth|login required|access.?token/i.test(
    message,
  );
}

async function loadEnabledServerEntry(
  name: string,
  mcpConfigPath?: string,
): Promise<McpServerConfigEntry> {
  const path = mcpConfigPath ?? defaultMcpConfigPath();
  const cfg = await readJson(path);
  const servers = (cfg.mcpServers ?? cfg.servers ?? {}) as Record<string, unknown>;
  const raw = servers[name];
  if (!raw || typeof raw !== "object") {
    throw new Error(`未安装 MCP：${name}`);
  }
  const entry = { ...(raw as Record<string, unknown>) };
  delete entry.disabled;
  return entry as McpServerConfigEntry;
}

/**
 * Briefly start one installed MCP server and list its tools / resources / prompts.
 * Always stops the client afterwards. Safe to call from Settings without a session.
 */
export async function inspectMcpServer(
  name: string,
  opts?: {
    mcpConfigPath?: string;
    cwd?: string;
    openAuthUrl?: ((server: string, url: string) => void | Promise<void>) | null;
  },
): Promise<InspectMcpServerResult> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("MCP 名称不能为空");
  const entry = await loadEnabledServerEntry(trimmed, opts?.mcpConfigPath);
  const manager = new McpManager(
    { [trimmed]: entry },
    {
      cwd: opts?.cwd ?? process.cwd(),
      openAuthUrl: opts?.openAuthUrl ?? null,
    },
  );
  try {
    await manager.startAll();
    const err = manager.startErrors().find((e) => e.server === trimmed);
    if (err) {
      return {
        name: trimmed,
        connected: false,
        tools: [],
        resources: [],
        prompts: [],
        error: err.message,
        needsAuth: looksLikeAuthError(err.message),
      };
    }
    return {
      name: trimmed,
      connected: true,
      tools: manager.listAllTools().map((t) => ({
        name: t.name,
        description: t.description ?? "",
      })),
      resources: manager.listAllResources().map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
      })),
      prompts: manager.listAllPrompts().map((p) => ({
        name: p.name,
        description: p.description,
      })),
    };
  } finally {
    await manager.stopAll().catch(() => undefined);
  }
}

export interface AuthorizeMcpServerResult {
  name: string;
  authorized: boolean;
  error?: string;
}

/**
 * Connect once with an OAuth host hook so remote HTTP/SSE servers can complete
 * Authorization Code + PKCE. Used by Settings "Authorize" / oauth-start.
 */
export async function authorizeMcpServer(
  name: string,
  opts: {
    openAuthUrl: (server: string, url: string) => void | Promise<void>;
    mcpConfigPath?: string;
    cwd?: string;
  },
): Promise<AuthorizeMcpServerResult> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("MCP 名称不能为空");
  const entry = await loadEnabledServerEntry(trimmed, opts.mcpConfigPath);
  const hasRemoteUrl =
    typeof (entry as { url?: unknown }).url === "string" &&
    Boolean((entry as { url?: string }).url?.trim());
  if (!hasRemoteUrl) {
    return {
      name: trimmed,
      authorized: false,
      error: "该 MCP 不是远程 HTTP/SSE 服务，无需 OAuth 授权。",
    };
  }
  const result = await inspectMcpServer(trimmed, {
    mcpConfigPath: opts.mcpConfigPath,
    cwd: opts.cwd,
    openAuthUrl: opts.openAuthUrl,
  });
  if (result.connected) {
    return { name: trimmed, authorized: true };
  }
  return {
    name: trimmed,
    authorized: false,
    error: result.error ?? "授权失败",
  };
}
