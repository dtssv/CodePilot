import type { RuntimeRegistry } from "../agent/runtime.js";
import type { ProviderName } from "../types.js";
import type { PluginTrustStore } from "./plugins-trust.js";

/** The subset of PluginTrustStore mergePluginConfig needs. Defined here (not
 * imported as the class) to keep the dependency one-directional. */
export interface PluginTrustGate {
  isTrusted(name: string, currentHash: string): boolean;
  /** The recorded hash, or null when never approved. */
  recorded?(name: string): string | null;
}

/**
 * Capabilities a plugin may declare under `permissions`.
 * `hooks`/`mcp`/`runtime`/`tools` gate the matching resource;
 * `network`/`fileWrite`/`bash` are advisory side-effect tags.
 */
export type PluginPermission =
  | "hooks"
  | "mcp"
  | "runtime"
  | "tools"
  | "network"
  | "fileWrite"
  | "bash";

/** All recognised plugin permissions. */
export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  "hooks",
  "mcp",
  "runtime",
  "tools",
  "network",
  "fileWrite",
  "bash",
];

/**
 * A provider template a plugin may contribute (`plugin.json` `providerTemplates`).
 * Plain-data (baseURL + models + protocol), no provider code.
 */
export interface PluginProviderTemplate {
 /** Stable id; namespaced to the plugin on merge to avoid clashes. */
  id: string;
  displayName: string;
 /** Which built-in protocol adapter to use. Must be a supported provider
  * name; a template naming an unknown provider is skipped on collect. */
  provider: ProviderName;
  baseURL?: string;
  models?: string[];
  smallModel?: string;
  description?: string;
  requiresBaseURL?: boolean;
}

/** Plugin manifest (`plugin.json`). */
export interface PluginManifest {
 /** Canonical plugin name (lowercase, hyphens). */
  name: string;
 /** Human-readable display name. */
  displayName?: string;
 /** One-line description. */
  description: string;
 /** Version string (semver). */
  version: string;
 /** Author or maintainer. */
  author?: string;
 /** Homepage or repo URL. */
  homepage?: string;
 /** Minimum CodePilot version required. */
  minCodepilotVersion?: string;
 /** Hooks to register (merged into session hooks config). */
  hooks?: Record<string, unknown[]>;
 /** MCP servers to register (merged into session mcpServers config). */
  mcpServers?: Record<string, unknown>;
 /**
  * Provider templates for the picker (baseURL + models + protocol; no secrets,
  * no code). Merged via {@link collectPluginProviderTemplates}; ids namespaced
  * `<plugin>/<id>`. Never runs plugin provider code (§4.3).
  */
  providerTemplates?: PluginProviderTemplate[];
 /**
  * Capabilities the plugin needs. Opt-in: when present, an undeclared
  * `hooks`/`mcpServers`/`runtime` is refused at merge (fail-closed).
  * `network`/`fileWrite`/`bash`/`tools` are advisory.
  */
  permissions?: PluginPermission[];
 /** Whether the plugin is enabled (default true). */
  enabled?: boolean;
 /**
  * Custom agent runtime: a JS module exporting a `RuntimeFactory` (default
  * export, or named `factory`/`runtimeFactory`). String = relative module path;
  * object form adds `name`/`default`. Runs in-host with full Node access.
  */
  runtime?: string | { module: string; name?: string; default?: boolean };
}

/** A discovered plugin with its manifest and filesystem path. */
export interface Plugin {
  manifest: PluginManifest;
 /** Absolute path to the plugin directory. */
  path: string;
 /** Which source the plugin came from. */
  source: "project" | "user";
 /** Subdirectory paths for each resource type (may not exist on disk). */
  paths: {
    skills: string;
    agents: string;
    commands: string;
  };
}

/** A marketplace index entry. */
export interface MarketplaceEntry {
  name: string;
  description: string;
 /** Git URL or local path to install from. */
  source: string;
  version?: string;
  author?: string;
  tags?: string[];
}

export interface DiscoverPluginsOptions {
 /** Override the project-local plugins directory. */
  projectDir?: string;
 /** Override the user-global plugins directory. */
  userDir?: string;
}

/** A plugin's declared vs. actually-used capabilities. */
export interface PluginPermissionReport {
  name: string;
 /** Permissions the manifest declares (empty when the field is absent). */
  declared: PluginPermission[];
 /** True when the manifest opts into enforcement (has a `permissions` field). */
  enforced: boolean;
 /** Gated capabilities the plugin ships (hooks / mcp / runtime). */
  used: PluginPermission[];
 /** Gated capabilities used but NOT declared — refused when `enforced`. */
  violations: PluginPermission[];
}

/**
 * What a plugin will contribute and its side effects, derived from the manifest
 * (+ best-effort static scan of the runtime module). Static and execution-free;
 * built before activation for consent. Tool detection is best-effort.
 */
export interface PluginCapabilityReport {
  name: string;
  displayName?: string;
  description: string;
  version: string;
  author?: string;
  /** Number of each directory-type resource the plugin ships. */
  resources: { skills: number; agents: number; commands: number };
  /** Lifecycle hook event names the manifest registers (e.g. "PreToolUse"). */
  hooks: string[];
  /** MCP server keys the manifest registers. */
  mcpServers: string[];
  /** True when the manifest declares a custom agent runtime. */
  hasRuntime: boolean;
  /** Names of model-callable tools the plugin registers, best-effort from a
   * static scan of the runtime module. Empty when none were found (which does
   * NOT prove there are none — see `toolsPartial`). */
  tools: string[];
  /** True when tool detection may be incomplete: the plugin declares the
   * `tools` permission (so it intends to register tools) but the static scan
   * could not enumerate them, or found fewer than the declaration implies.
   * A host should say "registers custom tools (names may be incomplete)". */
  toolsPartial: boolean;
  /** Advisory side-effect tags declared in `permissions`
   * (`network` / `fileWrite` / `bash`). Surfaced for consent. */
  sideEffects: PluginPermission[];
  /** True when the plugin carries NO side effects: skills-only (optionally
   * agents/commands), no hooks / mcp / runtime / tools, and no advisory
   * network/fileWrite/bash tags. A reassuring positive signal for the user. */
  sideEffectFree: boolean;
  /** One-line human summary for a confirmation prompt. */
  summary: string;
}

export interface InstallOptions {
 /** Override the install directory (default: ~/.codepilot/plugins/<name>). */
  installDir?: string;
 /** Force re-install if the plugin already exists. */
  force?: boolean;
 /** Trust store to record the plugin's sensitive-content fingerprint into at
  * install-consent time. Defaults to the shared `~/.codepilot/plugins/.trust.json`
  * store; override for tests. */
  trustStore?: PluginTrustStore;
  /**
   * Explicit user/host consent to install and record a trust fingerprint.
   * Required (`true`); callers must confirm after {@link inspectPluginSource}.
   */
  consent?: boolean;
}

export interface PluginRuntimeLoadResult {
 /** Factory names successfully registered, keyed by plugin name. */
  registered: Map<string, string>;
 /** Per-plugin load failures (plugin name → error message). */
  errors: Map<string, string>;
}

export interface PluginRuntimeInit extends PluginRuntimeLoadResult {
 /** Plugins discovered during this init (reusable for resource paths). */
  plugins: Map<string, Plugin>;
 /** Runtime name a plugin declared as the session default, if any. */
  defaultRuntime?: string;
}

export interface InitPluginRuntimesOptions extends DiscoverPluginsOptions {
 /** Registry to register into (default: the process-wide registry). */
  registry?: RuntimeRegistry;
 /** Runtime name already chosen by config/session options. Used to detect
 * conflicts with a plugin that declares itself the default. */
  existingRuntime?: string;
  /** Content-trust gate for runtime modules. Default: the shared
   * `~/.codepilot/plugins/.trust.json` store. */
  trust?: PluginTrustGate;
}