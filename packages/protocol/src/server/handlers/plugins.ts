import {
  describeMarketplaceEntry,
  discoverPlugins,
  inspectPluginSource,
  installPlugin,
  listPluginMarket,
  pluginSensitiveTrusted,
  PluginTrustStore,
  searchMarketplace,
  trustPlugin,
  uninstallPlugin,
} from "@codepilot/core";
import { ErrorCode, RpcError } from "../../rpc.js";
import type { ServerContext } from "../context.js";

export async function handlePluginsMarket(p: { query?: string }): Promise<{
  plugins: Awaited<ReturnType<typeof listPluginMarket>>;
  describe: Record<string, string>;
}> {
  const all = await listPluginMarket();
  const plugins = p?.query?.trim() ? searchMarketplace(all, p.query.trim()) : all;
  const describe: Record<string, string> = {};
  for (const e of plugins) describe[e.name] = describeMarketplaceEntry(e);
  return { plugins, describe };
}

export async function handlePluginsList(ctx: ServerContext): Promise<{
  plugins: Array<{
    name: string;
    description: string;
    version: string;
    source: string;
    enabled: boolean;
    trusted: boolean;
  }>;
}> {
  const discovered = await discoverPlugins(ctx.defaultCwd);
  const trust = new PluginTrustStore();
  await trust.load();
  return {
    plugins: [...discovered.values()].map((pl) => {
      const sensitive = !!(pl.manifest.hooks || pl.manifest.mcpServers || pl.manifest.runtime);
      return {
        name: pl.manifest.name,
        description: pl.manifest.description,
        version: pl.manifest.version,
        source: pl.source,
        enabled: pl.manifest.enabled !== false,
        trusted: !sensitive || pluginSensitiveTrusted(pl, trust),
      };
    }),
  };
}

export async function handlePluginsInspect(p: {
  source?: string;
}): Promise<Awaited<ReturnType<typeof inspectPluginSource>>> {
  if (!p?.source?.trim()) throw new RpcError(ErrorCode.InvalidParams, "source required");
  return inspectPluginSource(p.source.trim());
}

export async function handlePluginsInstall(p: {
  source?: string;
  force?: boolean;
}): Promise<{ name: string; path: string }> {
  if (!p?.source?.trim()) throw new RpcError(ErrorCode.InvalidParams, "source required");
  const path = await installPlugin(p.source.trim(), {
    force: p.force === true,
    // RPC install is user-initiated after inspect/confirm in the UI.
    consent: true,
  });
  return { name: path.split(/[/\\]/).filter(Boolean).pop() ?? "plugin", path };
}

export async function handlePluginsUninstall(p: {
  name?: string;
}): Promise<{ removed: boolean }> {
  if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
  return { removed: await uninstallPlugin(p.name.trim()) };
}

export async function handlePluginsTrust(
  ctx: ServerContext,
  p: { name?: string },
): Promise<{ trusted: boolean }> {
  if (!p?.name?.trim()) throw new RpcError(ErrorCode.InvalidParams, "name required");
  return { trusted: await trustPlugin(ctx.defaultCwd, p.name.trim()) };
}