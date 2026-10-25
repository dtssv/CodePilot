/**
 * Office / productivity connectors — guided installs for everyday tools.
 *
 * Catalog: GitHub `catalog/connectors.json` — try update once per day;
 * keep local forever if weak/offline. Bundled JSON is the offline seed.
 */

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalogDocument } from "./remoteCatalog.js";

export type ConnectorKind = "tool" | "tool+skill" | "skill";

export interface ConnectorCredentialField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  required?: boolean;
}

export interface ConnectorRecipe {
  id: string;
  name: string;
  description: string;
  category: "im" | "docs" | "dev" | "design" | "mail" | "calendar" | "custom";
  kind: ConnectorKind;
  docsUrl?: string;
  authUrl?: string;
  credentials: ConnectorCredentialField[];
  mcp?: {
    name: string;
    command: string;
    args?: string[];
    envFromCredentials?: string[];
  };
  skill?: {
    name: string;
    description: string;
    body: string;
  };
  securityNotice: string;
}

interface ConnectorsDoc {
  version?: number;
  updatedAt?: string;
  connectors?: ConnectorRecipe[];
}

function bundledConnectors(): ConnectorRecipe[] {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "catalog", "connectors.json");
    const doc = JSON.parse(readFileSync(path, "utf-8")) as ConnectorsDoc;
    return Array.isArray(doc.connectors) ? doc.connectors : [];
  } catch {
    return [];
  }
}

/** Offline / boot fallback (bundled JSON). Prefer {@link listConnectors}. */
export const CONNECTOR_CATALOG: ConnectorRecipe[] = bundledConnectors();

function mergeById(base: ConnectorRecipe[], overlay: ConnectorRecipe[]): ConnectorRecipe[] {
  const map = new Map<string, ConnectorRecipe>();
  for (const c of base) map.set(c.id, c);
  for (const c of overlay) {
    if (c?.id) map.set(c.id, c);
  }
  return [...map.values()];
}

/** Resolved connector list (local forever; daily remote refresh when possible). */
export async function listConnectors(opts?: { force?: boolean }): Promise<ConnectorRecipe[]> {
  try {
    const { data } = await loadCatalogDocument<ConnectorsDoc>("connectors", opts);
    const remote = Array.isArray(data.connectors) ? data.connectors : [];
    return mergeById(CONNECTOR_CATALOG, remote);
  } catch {
    return [...CONNECTOR_CATALOG];
  }
}

export async function getConnector(id: string): Promise<ConnectorRecipe | undefined> {
  return (await listConnectors()).find((c) => c.id === id);
}

export interface InstallConnectorInput {
  connectorId: string;
  values: Record<string, string>;
  skillsDir?: string;
  mcpConfigPath?: string;
}

export interface InstallConnectorResult {
  mcpName?: string;
  skillPath?: string;
  mcpConfigPath: string;
  message: string;
}

function defaultMcpConfigPath(): string {
  return join(homedir(), ".codepilot", "mcp.json");
}

function defaultSkillsDir(): string {
  return join(homedir(), ".codepilot", "skills");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function installConnector(
  input: InstallConnectorInput & { /** When true, blank credential fields keep existing env. */ patch?: boolean },
): Promise<InstallConnectorResult> {
  const recipe = await getConnector(input.connectorId);
  if (!recipe) throw new Error(`未知连接器：${input.connectorId}`);

  const mcpPath = input.mcpConfigPath ?? defaultMcpConfigPath();
  await mkdir(join(mcpPath, ".."), { recursive: true });
  const cfg = await readJson(mcpPath);
  const servers =
    (cfg.mcpServers as Record<string, unknown> | undefined) ??
    (cfg.servers as Record<string, unknown> | undefined) ??
    {};

  const prevEntry = recipe.mcp
    ? (servers[recipe.mcp.name] as Record<string, unknown> | undefined)
    : undefined;
  const prevEnv = (prevEntry?.env as Record<string, string> | undefined) ?? {};

  for (const f of recipe.credentials) {
    const provided = input.values[f.key]?.trim();
    if (f.required && !provided) {
      // Patch/update may leave blanks to keep existing secrets.
      if (input.patch && prevEnv[f.key]) continue;
      throw new Error(`缺少：${f.label}`);
    }
  }

  let mcpName: string | undefined;
  if (recipe.mcp) {
    mcpName = recipe.mcp.name;
    const env: Record<string, string> = { ...prevEnv };
    for (const k of recipe.mcp.envFromCredentials ?? []) {
      if (input.values[k]?.trim()) env[k] = input.values[k]!.trim();
    }
    servers[mcpName] = {
      command: recipe.mcp.command,
      ...(recipe.mcp.args ? { args: recipe.mcp.args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      // Keep enable/disable across credential updates.
      ...(prevEntry?.disabled === true ? { disabled: true } : {}),
    };
  }

  await writeFile(mcpPath, JSON.stringify({ ...cfg, mcpServers: servers }, null, 2) + "\n", "utf-8");

  let skillPath: string | undefined;
  if (recipe.skill) {
    const root = input.skillsDir ?? defaultSkillsDir();
    const dir = join(root, recipe.skill.name);
    await mkdir(dir, { recursive: true });
    skillPath = join(dir, "SKILL.md");
    const md = `---\nname: ${recipe.skill.name}\ndescription: ${recipe.skill.description}\n---\n\n${recipe.skill.body.trim()}\n`;
    await writeFile(skillPath, md, "utf-8");
  }

  return {
    mcpName,
    skillPath,
    mcpConfigPath: mcpPath,
    message: `已安装连接器「${recipe.name}」。${
      skillPath ? "配套技能已写入 ~/.codepilot/skills/。" : ""
    }重新加载后可用。`,
  };
}

export async function connectorInstalled(id: string, mcpConfigPath?: string): Promise<boolean> {
  const status = await getConnectorStatus(id, { mcpConfigPath });
  return status.installed;
}

export type ConnectorInstallState = "installed" | "available";

export interface ConnectorStatus {
  id: string;
  installed: boolean;
  /** False when installed but marked `disabled` in mcp.json (or companion skill disabled). */
  enabled: boolean;
  mcpName?: string;
  skillName?: string;
  skillInstalled?: boolean;
}

export interface ConnectorWithStatus extends ConnectorRecipe {
  status: ConnectorStatus;
}

async function readMcpServers(
  mcpConfigPath?: string,
): Promise<{ path: string; servers: Record<string, Record<string, unknown>> }> {
  const path = mcpConfigPath ?? defaultMcpConfigPath();
  const cfg = await readJson(path);
  const servers = ((cfg.mcpServers ?? cfg.servers ?? {}) as Record<
    string,
    Record<string, unknown>
  >) ?? {};
  return { path, servers };
}

async function writeMcpServers(
  path: string,
  servers: Record<string, Record<string, unknown>>,
  previous?: Record<string, unknown>,
): Promise<void> {
  const cfg = previous ?? (await readJson(path));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ ...cfg, mcpServers: servers }, null, 2) + "\n",
    "utf-8",
  );
}

async function skillDirExists(skillName: string, skillsDir?: string): Promise<boolean> {
  const root = skillsDir ?? defaultSkillsDir();
  try {
    await access(join(root, skillName, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

export async function getConnectorStatus(
  id: string,
  opts?: { mcpConfigPath?: string; skillsDir?: string },
): Promise<ConnectorStatus> {
  const recipe = await getConnector(id);
  if (!recipe) {
    return { id, installed: false, enabled: false };
  }
  const mcpName = recipe.mcp?.name;
  const skillName = recipe.skill?.name;
  let mcpInstalled = false;
  let mcpEnabled = true;
  if (mcpName) {
    const { servers } = await readMcpServers(opts?.mcpConfigPath);
    const entry = servers[mcpName];
    mcpInstalled = !!entry;
    mcpEnabled = !entry?.disabled;
  }
  const skillInstalled = skillName
    ? await skillDirExists(skillName, opts?.skillsDir)
    : false;

  // Installed if MCP entry exists, or skill-only connector has its skill on disk.
  const installed = mcpName ? mcpInstalled : skillInstalled;
  const enabled = installed && (mcpName ? mcpEnabled : true);

  return {
    id,
    installed,
    enabled,
    mcpName,
    skillName,
    skillInstalled,
  };
}

export type CatalogListTab = "all" | "installed" | "available";

export interface ConnectorListQuery {
  force?: boolean;
  mcpConfigPath?: string;
  skillsDir?: string;
  /** Case-insensitive match on id / name / description. */
  q?: string;
  tab?: CatalogListTab;
  offset?: number;
  /** When omitted (or ≤0), return the full filtered set. */
  limit?: number;
}

export interface ConnectorListPage {
  connectors: ConnectorWithStatus[];
  total: number;
  offset: number;
  limit: number;
}

/** Build install indexes once (avoids per-row disk I/O on large catalogs). */
async function connectorInstallIndex(opts?: {
  mcpConfigPath?: string;
  skillsDir?: string;
}): Promise<{
  servers: Record<string, Record<string, unknown>>;
  skillNames: Set<string>;
}> {
  const { servers } = await readMcpServers(opts?.mcpConfigPath);
  const skillNames = new Set<string>();
  const root = opts?.skillsDir ?? defaultSkillsDir();
  try {
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir(root)) {
      if (await skillDirExists(name, root)) skillNames.add(name);
    }
  } catch {
    /* no skills dir yet */
  }
  return { servers, skillNames };
}

function statusFromIndex(
  recipe: ConnectorRecipe,
  index: { servers: Record<string, Record<string, unknown>>; skillNames: Set<string> },
): ConnectorStatus {
  const mcpName = recipe.mcp?.name;
  const skillName = recipe.skill?.name;
  let mcpInstalled = false;
  let mcpEnabled = true;
  if (mcpName) {
    const entry = index.servers[mcpName];
    mcpInstalled = !!entry;
    mcpEnabled = !entry?.disabled;
  }
  const skillInstalled = skillName ? index.skillNames.has(skillName) : false;
  const installed = mcpName ? mcpInstalled : skillInstalled;
  const enabled = installed && (mcpName ? mcpEnabled : true);
  return {
    id: recipe.id,
    installed,
    enabled,
    mcpName,
    skillName,
    skillInstalled,
  };
}

function connectorMatchesQuery(c: ConnectorRecipe, q: string): boolean {
  if (!q) return true;
  const hay = `${c.id} ${c.name} ${c.description}`.toLowerCase();
  return hay.includes(q);
}

/**
 * Filtered + paginated catalog with install status. Prefer this for Settings
 * when the catalog may grow large; omit `limit` to get the full filtered set.
 */
export async function queryConnectorsWithStatus(
  opts?: ConnectorListQuery,
): Promise<ConnectorListPage> {
  const catalog = await listConnectors({ force: opts?.force });
  const index = await connectorInstallIndex({
    mcpConfigPath: opts?.mcpConfigPath,
    skillsDir: opts?.skillsDir,
  });
  const q = (opts?.q ?? "").trim().toLowerCase();
  const tab = opts?.tab ?? "all";
  const filtered: ConnectorWithStatus[] = [];
  for (const c of catalog) {
    if (!connectorMatchesQuery(c, q)) continue;
    const status = statusFromIndex(c, index);
    if (tab === "installed" && !status.installed) continue;
    if (tab === "available" && status.installed) continue;
    filtered.push({ ...c, status });
  }
  // Installed first, then name.
  filtered.sort((a, b) => {
    if (a.status.installed !== b.status.installed) {
      return a.status.installed ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  const total = filtered.length;
  const offset = Math.max(0, opts?.offset ?? 0);
  const limit =
    typeof opts?.limit === "number" && opts.limit > 0 ? opts.limit : total;
  const connectors = filtered.slice(offset, offset + limit);
  return { connectors, total, offset, limit };
}

/** Catalog plus per-connector install/enabled state (full list). */
export async function listConnectorsWithStatus(opts?: {
  force?: boolean;
  mcpConfigPath?: string;
  skillsDir?: string;
}): Promise<ConnectorWithStatus[]> {
  const page = await queryConnectorsWithStatus(opts);
  return page.connectors;
}

/** Update credentials / env for an already-installed connector (same as reinstall). */
export async function updateConnector(
  input: InstallConnectorInput,
): Promise<InstallConnectorResult> {
  const status = await getConnectorStatus(input.connectorId, {
    mcpConfigPath: input.mcpConfigPath,
    skillsDir: input.skillsDir,
  });
  if (!status.installed) {
    throw new Error(`连接器未安装：${input.connectorId}。请先安装。`);
  }
  const result = await installConnector({ ...input, patch: true });
  return {
    ...result,
    message: `已更新连接器「${(await getConnector(input.connectorId))?.name ?? input.connectorId}」。重新加载后生效。`,
  };
}

/** Enable or disable an installed connector without removing its config. */
export async function setConnectorEnabled(
  connectorId: string,
  enabled: boolean,
  opts?: { mcpConfigPath?: string },
): Promise<{ connectorId: string; enabled: boolean; message: string }> {
  const recipe = await getConnector(connectorId);
  if (!recipe) throw new Error(`未知连接器：${connectorId}`);
  if (!recipe.mcp) {
    throw new Error(`连接器「${recipe.name}」无 MCP 服务，请用技能页启停配套技能。`);
  }
  const { path, servers } = await readMcpServers(opts?.mcpConfigPath);
  const entry = servers[recipe.mcp.name];
  if (!entry) {
    throw new Error(`连接器未安装：${recipe.name}`);
  }
  if (enabled) {
    const { disabled: _d, ...rest } = entry;
    servers[recipe.mcp.name] = rest;
  } else {
    servers[recipe.mcp.name] = { ...entry, disabled: true };
  }
  await writeMcpServers(path, servers);
  return {
    connectorId,
    enabled,
    message: enabled
      ? `已启用「${recipe.name}」。重新加载会话后生效。`
      : `已停用「${recipe.name}」。配置仍保留，可随时启用。`,
  };
}
