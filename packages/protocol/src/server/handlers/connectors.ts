import {
  getSkillContent,
  getSkillFile,
  installConnector,
  installSkillFromArchive,
  installSkillFromConnector,
  installSkillFromSource,
  queryConnectorsWithStatus,
  queryManagedSkills,
  saveSkillContent,
  saveSkillFile,
  setConnectorEnabled,
  setSkillEnabled,
  SKILL_CREATOR_STARTER_PROMPT,
  updateConnector,
  type CatalogListTab,
  type SkillListTab,
} from "@codepilot/core";
import { ErrorCode, RpcError } from "../../rpc.js";
import type { ServerContext } from "../context.js";

export async function handleConnectorsList(p: {
  q?: string;
  tab?: CatalogListTab;
  offset?: number;
  limit?: number;
}): Promise<Awaited<ReturnType<typeof queryConnectorsWithStatus>>> {
  return queryConnectorsWithStatus({
    q: p?.q,
    tab: p?.tab,
    offset: p?.offset,
    limit: p?.limit,
  });
}

export function handleConnectorsInstall(p: {
  connectorId: string;
  values: Record<string, string>;
}): Promise<{
  mcpName?: string;
  skillPath?: string;
  mcpConfigPath: string;
  message: string;
}> {
  return installConnector(p);
}

export function handleConnectorsUpdate(p: {
  connectorId: string;
  values: Record<string, string>;
}): Promise<{
  mcpName?: string;
  skillPath?: string;
  mcpConfigPath: string;
  message: string;
}> {
  return updateConnector(p);
}

export async function handleConnectorsSetEnabled(p: {
  connectorId: string;
  enabled: boolean;
}): Promise<{ connectorId: string; enabled: boolean; message: string }> {
  return setConnectorEnabled(p.connectorId, p.enabled);
}

export async function handleSkillsList(
  ctx: ServerContext,
  p: {
    q?: string;
    tab?: SkillListTab;
    offset?: number;
    limit?: number;
  },
): Promise<Awaited<ReturnType<typeof queryManagedSkills>>> {
  return queryManagedSkills({
    cwd: ctx.defaultCwd,
    q: p?.q,
    tab: p?.tab,
    offset: p?.offset,
    limit: p?.limit,
  });
}

export function handleSkillsInstall(p: {
  connectorId: string;
}): Promise<{ skillPath: string; message: string }> {
  return installSkillFromConnector(p.connectorId);
}

export function handleSkillsInstallArchive(p: {
  filename?: string;
  dataBase64?: string;
}): Promise<Awaited<ReturnType<typeof installSkillFromArchive>>> {
  if (!p?.filename?.trim() || !p?.dataBase64?.trim()) {
    throw new RpcError(ErrorCode.InvalidParams, "filename and dataBase64 required");
  }
  return installSkillFromArchive({ filename: p.filename, dataBase64: p.dataBase64 });
}

export function handleSkillsInstallSource(p: {
  source?: string;
}): Promise<Awaited<ReturnType<typeof installSkillFromSource>>> {
  if (!p?.source?.trim()) {
    throw new RpcError(ErrorCode.InvalidParams, "source required");
  }
  return installSkillFromSource(p.source);
}

export async function handleSkillsSetEnabled(p: {
  name: string;
  enabled: boolean;
}): Promise<{ name: string; enabled: boolean; message: string }> {
  return setSkillEnabled(p.name, p.enabled);
}

export function handleSkillsGet(
  ctx: ServerContext,
  p: { name: string },
): Promise<Awaited<ReturnType<typeof getSkillContent>>> {
  return getSkillContent(p.name, ctx.defaultCwd);
}

export function handleSkillsGetFile(
  ctx: ServerContext,
  p: { name?: string; relativePath?: string },
): Promise<Awaited<ReturnType<typeof getSkillFile>>> {
  if (!p?.name?.trim() || !p?.relativePath?.trim()) {
    throw new RpcError(ErrorCode.InvalidParams, "name and relativePath required");
  }
  return getSkillFile(p.name, p.relativePath, ctx.defaultCwd);
}

export function handleSkillsSave(
  ctx: ServerContext,
  p: { name: string; markdown: string },
): Promise<Awaited<ReturnType<typeof saveSkillContent>>> {
  return saveSkillContent(p.name, p.markdown, ctx.defaultCwd);
}

export function handleSkillsSaveFile(
  ctx: ServerContext,
  p: { name?: string; relativePath?: string; content?: string },
): Promise<Awaited<ReturnType<typeof saveSkillFile>>> {
  if (!p?.name?.trim() || !p?.relativePath?.trim()) {
    throw new RpcError(ErrorCode.InvalidParams, "name and relativePath required");
  }
  return saveSkillFile(p.name, p.relativePath, p.content ?? "", ctx.defaultCwd);
}

export async function handleSkillsCreatorPrompt(): Promise<{ prompt: string }> {
  return { prompt: SKILL_CREATOR_STARTER_PROMPT };
}