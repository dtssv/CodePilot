import type { Plugin, PluginManifest, PluginPermission, PluginTrustGate } from "./types.js";

export function untrustedPluginMessage(p: Plugin, trust: PluginTrustGate | undefined): string {
  return p.source === "project" && trust?.recorded && trust.recorded(p.manifest.name) === null
    ? `project plugin "${p.manifest.name}" (${p.path}) ships hooks / MCP servers / runtime code that you have not approved — skipped. Approve it with the plugins/trust RPC (Settings → Plugins) after reviewing it.`
    : `plugin "${p.manifest.name}" has changed on disk since you approved it — its hooks, MCP servers and runtime are disabled until you re-confirm the plugin (its sensitive content no longer matches the approved fingerprint).`;
}

/** Whether a plugin may contribute the given gated capability. Only plugins
 * that opt into enforcement are gated; others keep the legacy behaviour. */
export function allowsCapability(manifest: PluginManifest, cap: PluginPermission): boolean {
  if (!Array.isArray(manifest.permissions)) return true; // legacy: no gating
  return manifest.permissions.includes(cap);
}