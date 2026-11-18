import {
  approveProjectMcpServerForCwd,
  authorizeMcpServer,
  installMcpJson,
  inspectMcpServer,
  listInstalledMcpServers,
  listMcpMarkets,
  listProjectMcpServersForCwd,
  setMcpServerEnabled,
} from "@codepilot/core";
import { ErrorCode, RpcError } from "../../rpc.js";
import type { ServerContext } from "../context.js";
import {
  makeMcpOpenAuthUrl,
  mcpOauthByName,
  type McpOauthEntry,
  type McpOauthState,
} from "../mcpOpenAuth.js";

export async function handleMcpMarkets(): Promise<{
  markets: Awaited<ReturnType<typeof listMcpMarkets>>;
}> {
  return { markets: await listMcpMarkets() };
}

export async function handleMcpInstallJson(p: {
  json?: string;
  name?: string;
}): Promise<Awaited<ReturnType<typeof installMcpJson>>> {
  if (!p?.json?.trim()) throw new RpcError(ErrorCode.InvalidParams, "json required");
  return installMcpJson(p.json, { name: p.name });
}

export async function handleMcpList(): Promise<{
  servers: Awaited<ReturnType<typeof listInstalledMcpServers>>;
}> {
  return { servers: await listInstalledMcpServers() };
}

export async function handleMcpSetEnabled(p: {
  name?: string;
  enabled: boolean;
}): Promise<{ name: string; enabled: boolean; message: string }> {
  if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
  return setMcpServerEnabled(p.name, p.enabled);
}

export function handleMcpInspect(
  ctx: ServerContext,
  p: { name?: string },
): Promise<Awaited<ReturnType<typeof inspectMcpServer>>> {
  if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
  return inspectMcpServer(p.name, {
    cwd: ctx.defaultCwd,
    openAuthUrl: makeMcpOpenAuthUrl(ctx),
  });
}

export async function handleMcpListProject(
  ctx: ServerContext,
  p: { cwd?: string },
): Promise<{
  servers: Awaited<ReturnType<typeof listProjectMcpServersForCwd>>;
}> {
  return { servers: await listProjectMcpServersForCwd(p?.cwd ?? ctx.defaultCwd) };
}

export async function handleMcpApproveProject(
  ctx: ServerContext,
  p: { name?: string; cwd?: string },
): Promise<{ name: string; message: string }> {
  if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
  await approveProjectMcpServerForCwd(p.cwd ?? ctx.defaultCwd, p.name);
  return {
    name: p.name,
    message: `Approved project MCP server "${p.name}". New sessions may launch it.`,
  };
}

export async function handleMcpOauthStart(
  ctx: ServerContext,
  params: { name?: string },
): Promise<{ state: McpOauthState; url?: string; error?: string }> {
  const name = params?.name?.trim();
  if (!name) throw new RpcError(ErrorCode.InvalidParams, "name required");
  const existing = mcpOauthByName.get(name);
  if (existing?.state === "pending" && existing.running) {
    return { state: "pending", url: existing.url, error: existing.error };
  }
  const entry: McpOauthEntry = { state: "pending" };
  mcpOauthByName.set(name, entry);
  entry.running = (async () => {
    try {
      const r = await authorizeMcpServer(name, {
        cwd: ctx.defaultCwd,
        openAuthUrl: makeMcpOpenAuthUrl(ctx),
      });
      const cur = mcpOauthByName.get(name);
      if (!cur || cur.state === "idle") return; // cancelled
      if (r.authorized) {
        mcpOauthByName.set(name, { state: "authorized", url: cur.url });
      } else {
        mcpOauthByName.set(name, {
          state: "error",
          url: cur.url,
          error: r.error ?? "授权失败",
        });
      }
    } catch (err) {
      const cur = mcpOauthByName.get(name);
      if (!cur || cur.state === "idle") return;
      mcpOauthByName.set(name, {
        state: "error",
        url: cur.url,
        error: (err as Error).message,
      });
    }
  })();
  return { state: "pending", url: entry.url };
}

export function handleMcpOauthStatus(p: {
  name?: string;
}): { state: McpOauthState; url?: string; error?: string } {
  if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
  const entry = mcpOauthByName.get(p.name.trim());
  if (!entry) return { state: "idle" as const };
  return { state: entry.state, url: entry.url, error: entry.error };
}

export function handleMcpOauthCancel(p: { name?: string }): { state: McpOauthState } {
  if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
  const name = p.name.trim();
  mcpOauthByName.set(name, { state: "idle" });
  return { state: "idle" as const };
}