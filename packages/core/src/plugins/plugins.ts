/**
 * Plugins — distributable extensions (skills, agents, commands, hooks, MCP).
 * Discovered from <cwd>/.codepilot/plugins/ and ~/.codepilot/plugins/.
 * @module plugins
 */

export type {
  PluginTrustGate,
  PluginPermission,
  PluginProviderTemplate,
  PluginManifest,
  Plugin,
  MarketplaceEntry,
  DiscoverPluginsOptions,
  PluginPermissionReport,
  PluginCapabilityReport,
  InstallOptions,
  PluginRuntimeLoadResult,
  PluginRuntimeInit,
  InitPluginRuntimesOptions,
} from "./types.js";

export { PLUGIN_PERMISSIONS } from "./types.js";

export { pluginSensitiveTrusted, pluginPermissionReport, describePluginCapabilities } from "./capabilities.js";

export {
  discoverPlugins,
  trustPlugin,
  pluginResourcePaths,
  collectPluginProviderTemplates,
  mergePluginConfig,
  pluginDefaultRuntime,
} from "./discover.js";

export { loadPluginRuntimes, initPluginRuntimes } from "./runtime.js";

export {
  installPlugin,
  inspectPluginSource,
  uninstallPlugin,
  derivePluginName,
} from "./install.js";

export {
  fetchMarketplaceIndex,
  listPluginMarket,
  searchMarketplace,
  describeMarketplaceEntry,
} from "./marketplace.js";