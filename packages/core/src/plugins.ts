/**
 * Plugins — distributable extensions. A plugin dir has a `plugin.json` manifest
 * plus any of: skills, agents, commands, hooks, MCP configs. Discovered from
 * <cwd>/.codepilot/plugins/ and ~/.codepilot/plugins/; install clones/copies into
 * ~/.codepilot/plugins/<name>/.
 * @module plugins
 */
import { readdir, readFile, stat, rm, mkdir, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runtimeRegistry, type RuntimeFactory, type RuntimeRegistry } from "./runtime.js";
import { PROVIDER_NAMES, type ProviderName } from "./types.js";
import { pluginContentHash } from "./plugins-trust.js";
import { PluginTrustStore } from "./plugins-trust.js";

const execFileAsync = promisify(execFile);

/** The subset of PluginTrustStore mergePluginConfig needs. Defined here (not
 * imported as the class) to keep the dependency one-directional. */
export interface PluginTrustGate {
  isTrusted(name: string, currentHash: string): boolean;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Capabilities a plugin may declare under `permissions`.
 * - `hooks`    — register hooks (run shell/http/mcp/prompt/agent handlers)
 * - `mcp`      — register MCP servers (spawn external processes / endpoints)
 * - `runtime`  — replace the agent loop with plugin-provided Node code
 * - `tools`    — contribute tools the model can call (via the runtime toolkit)
 * - `network`  — advisory: the plugin's skills/agents reach the network
 * - `fileWrite`— advisory: the plugin's skills/agents write files
 * - `bash`     — advisory: the plugin's skills/agents run shell commands
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
 * Plain-data subset of the catalog's `ProviderTemplate` (duplicated, not imported,
 * to keep the manifest decoupled). Plugins contribute templates (baseURL + models
 * + protocol), NOT provider code; custom transport/OAuth is out of scope (§4.3).
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
  * Capabilities the plugin needs. Opt-in enforcement: when present, an
  * undeclared `hooks`/`mcpServers`/`runtime` is refused at merge (fail-closed)
  * + warned; when absent, legacy no-gating behaviour. `hooks`/`mcp`/`runtime`
  * gate the matching resource; `network`/`fileWrite`/`bash`/`tools` are advisory
  * consent tags (`tools` is advisory — the hard gate is `runtime`).
  */
  permissions?: PluginPermission[];
 /** Whether the plugin is enabled (default true). */
  enabled?: boolean;
 /**
 * Custom agent runtime: a JS module exporting a `RuntimeFactory` (default
 * export, or named `factory`/`runtimeFactory`).
 * - String form: relative module path (factory's own `name` used).
 * - Object form: `module` + optional `name` + optional `default: true` to
 *   claim the session runtime (only one plugin may; see {@link initPluginRuntimes}).
 * Runs in-host with full Node access — install only trusted plugins.
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

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoverPluginsOptions {
 /** Override the project-local plugins directory. */
  projectDir?: string;
 /** Override the user-global plugins directory. */
  userDir?: string;
}

/**
 * Discover plugins from project + user sources. Project plugins take
 * precedence over user plugins with the same name. Disabled plugins
 * (`enabled: false` in the manifest) are skipped.
 */
export async function discoverPlugins(
  cwd: string,
  opts: DiscoverPluginsOptions = {}
): Promise<Map<string, Plugin>> {
  const projectDir = opts.projectDir ?? join(cwd, ".codepilot", "plugins");
  const userDir = opts.userDir ?? join(homedir(), ".codepilot", "plugins");
  const out = new Map<string, Plugin>();

 // User plugins first (lower priority), then project plugins overwrite.
  for (const [source, dir] of [["user", userDir], ["project", projectDir]] as const) {
    const found = await scanPluginsDir(dir, source);
    for (const p of found) {
      if (p.manifest.enabled === false) continue;
      out.set(p.manifest.name, p);
    }
  }
  return out;
}

async function scanPluginsDir(
  dir: string,
  source: "project" | "user"
): Promise<Plugin[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: Plugin[] = [];
  for (const name of entries) {
    const pluginDir = join(dir, name);
    try {
      const st = await stat(pluginDir);
      if (!st.isDirectory()) continue;
      const manifestPath = join(pluginDir, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      const text = await readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(text) as PluginManifest;
      if (!manifest.name || !manifest.description || !manifest.version) continue;
      out.push({
        manifest,
        path: pluginDir,
        source,
        paths: {
          skills: join(pluginDir, "skills"),
          agents: join(pluginDir, "agents"),
          commands: join(pluginDir, "commands"),
        },
      });
    } catch {
 /* skip unreadable/malformed plugin */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Capability-bearing resources a plugin can contribute, and the permission
 * each requires. These are the ones that run code or spawn processes. */
const GATED_CAPABILITIES: ReadonlyArray<{ cap: PluginPermission; present: (m: PluginManifest) => boolean }> = [
  { cap: "hooks", present: (m) => !!m.hooks && Object.keys(m.hooks).length > 0 },
  { cap: "mcp", present: (m) => !!m.mcpServers && Object.keys(m.mcpServers).length > 0 },
  { cap: "runtime", present: (m) => m.runtime !== undefined },
];

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
 * Report a plugin's declared permissions against the capabilities its
 * manifest actually ships. Pure; use it to drive a consent UI (`/plugins`)
 * or to explain why a resource was skipped. `violations` is always empty
 * when the plugin didn't opt into enforcement (no `permissions` field).
 */
export function pluginPermissionReport(plugin: Plugin): PluginPermissionReport {
  const m = plugin.manifest;
  const enforced = Array.isArray(m.permissions);
  const declared = enforced ? [...new Set(m.permissions!)] : [];
  const used = GATED_CAPABILITIES.filter((g) => g.present(m)).map((g) => g.cap);
  const violations = enforced ? used.filter((c) => !declared.includes(c)) : [];
  return { name: m.name, declared, enforced, used, violations };
}

// ---------------------------------------------------------------------------
// Pre-install capability / side-effect report
// ---------------------------------------------------------------------------

/**
 * What a plugin will contribute and what side effects it carries, derived
 * from its manifest (and, when the directory is on disk, a best-effort static
 * scan of the runtime module). Built BEFORE a plugin is activated — or even
 * before it is committed to the plugins dir — so a host can show the user
 * exactly what they are about to run and ask for consent.
 *
 * This is deliberately static and execution-free: we never run plugin code to
 * find out what it does (running it is the very thing we are gating). Tool
 * detection from a runtime module is therefore best-effort — see `toolsPartial`.
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

/** Statically scan a runtime module's source for `registerTool({ name: "..." })`
 * calls and return the tool names it can find. Pure string scan — never
 * executes the module. Misses dynamically-built names (reported via
 * `toolsPartial`). */
function scanRuntimeToolNames(moduleSource: string): string[] {
  const names = new Set<string>();
  // Match `registerTool( ... name: "x" ... )` without executing anything. We
  // only look at the first `name:` after each `registerTool(` occurrence.
  const re = /registerTool\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(moduleSource))) {
    const rest = moduleSource.slice(m.index, m.index + 600);
    const nameMatch = rest.match(/\bname\s*:\s*["'`]([A-Za-z0-9_.-]+)["'`]/);
    if (nameMatch?.[1]) names.add(nameMatch[1]);
  }
  return [...names];
}

/** Resolve the runtime module path from a manifest's `runtime` field. */
function runtimeModulePath(manifest: PluginManifest): string | null {
  const r = manifest.runtime;
  if (!r) return null;
  const mod = typeof r === "string" ? r : r.module;
  return typeof mod === "string" && mod.trim() ? mod : null;
}

/**
 * Build a {@link PluginCapabilityReport} from a manifest. When `pluginDir` is
 * given, directory resources are counted and the runtime module is scanned for
 * tool names. Pure and execution-free.
 */
export async function describePluginCapabilities(
  manifest: PluginManifest,
  pluginDir?: string,
): Promise<PluginCapabilityReport> {
  const countDir = async (sub: string): Promise<number> => {
    if (!pluginDir) return 0;
    try {
      const entries = await readdir(join(pluginDir, sub));
      return entries.filter((e) => !e.startsWith(".")).length;
    } catch {
      return 0;
    }
  };
  const [skills, agents, commands] = await Promise.all([
    countDir("skills"),
    countDir("agents"),
    countDir("commands"),
  ]);

  const hooks = manifest.hooks ? Object.keys(manifest.hooks) : [];
  const mcpServers = manifest.mcpServers ? Object.keys(manifest.mcpServers) : [];
  const hasRuntime = manifest.runtime !== undefined;

  // Tool detection: scan the runtime module when available.
  let tools: string[] = [];
  const modRel = runtimeModulePath(manifest);
  if (pluginDir && modRel) {
    try {
      const src = await readFile(join(pluginDir, modRel), "utf-8");
      tools = scanRuntimeToolNames(src);
    } catch {
      /* unreadable module → leave tools empty, flagged partial below */
    }
  }
  const declaresTools = Array.isArray(manifest.permissions)
    ? manifest.permissions.includes("tools")
    : false;
  // Partial when the plugin says it registers tools but we couldn't enumerate
  // any (no dir to scan, unreadable module, or dynamic names).
  const toolsPartial = declaresTools && tools.length === 0;

  const ADVISORY: PluginPermission[] = ["network", "fileWrite", "bash"];
  const declaredPerms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const sideEffects = ADVISORY.filter((p) => declaredPerms.includes(p));

  const sideEffectFree =
    hooks.length === 0 &&
    mcpServers.length === 0 &&
    !hasRuntime &&
    tools.length === 0 &&
    !declaresTools &&
    sideEffects.length === 0;

  const parts: string[] = [];
  if (tools.length > 0) parts.push(`registers ${tools.length} tool${tools.length > 1 ? "s" : ""} (${tools.join(", ")})`);
  else if (declaresTools) parts.push("registers custom tools (names may be incomplete)");
  if (hasRuntime) parts.push("replaces the agent loop (runtime)");
  if (mcpServers.length > 0) parts.push(`adds ${mcpServers.length} MCP server${mcpServers.length > 1 ? "s" : ""}`);
  if (hooks.length > 0) parts.push(`hooks: ${hooks.join(", ")}`);
  if (skills > 0) parts.push(`${skills} skill${skills > 1 ? "s" : ""}`);
  if (agents > 0) parts.push(`${agents} agent${agents > 1 ? "s" : ""}`);
  if (commands > 0) parts.push(`${commands} command${commands > 1 ? "s" : ""}`);
  if (sideEffects.length > 0) parts.push(`may ${sideEffects.join(" / ")}`);
  const summary = sideEffectFree
    ? "no side effects (skills only)"
    : parts.length > 0
      ? parts.join("; ")
      : "no declared capabilities";

  return {
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    author: manifest.author,
    resources: { skills, agents, commands },
    hooks,
    mcpServers,
    hasRuntime,
    tools,
    toolsPartial,
    sideEffects,
    sideEffectFree,
    summary,
  };
}

/** Whether a plugin may contribute the given gated capability. Only plugins
 * that opt into enforcement are gated; others keep the legacy behaviour. */
function allowsCapability(manifest: PluginManifest, cap: PluginPermission): boolean {
  if (!Array.isArray(manifest.permissions)) return true; // legacy: no gating
  return manifest.permissions.includes(cap);
}

// ---------------------------------------------------------------------------
// Resource path aggregation
// ---------------------------------------------------------------------------

/**
 * Collect all resource directories from discovered plugins, in priority order
 * (project plugins before user plugins). These paths can be passed to the
 * respective discovery functions (`discoverSkills`, `discoverCustomAgents`,
 * `discoverSlashCommands`) as `extraDirs`.
 */
export function pluginResourcePaths(
  plugins: Map<string, Plugin>
): { skills: string[]; agents: string[]; commands: string[] } {
  const skills: string[] = [];
  const agents: string[] = [];
  const commands: string[] = [];
  for (const p of plugins.values()) {
    if (existsSync(p.paths.skills)) skills.push(p.paths.skills);
    if (existsSync(p.paths.agents)) agents.push(p.paths.agents);
    if (existsSync(p.paths.commands)) commands.push(p.paths.commands);
  }
  return { skills, agents, commands };
}

/**
 * Collect provider templates from discovered plugins (pure data, no code).
 * Ids namespaced `<plugin>/<id>`; templates missing `id`/`displayName`/`provider`
 * or naming an unsupported provider are skipped. Feed to
 * {@link listProviderTemplates} as an overlay.
 */
export async function collectPluginProviderTemplates(
  cwd: string,
  opts: DiscoverPluginsOptions = {},
): Promise<PluginProviderTemplate[]> {
  const plugins = await discoverPlugins(cwd, opts);
  const out: PluginProviderTemplate[] = [];
  for (const p of plugins.values()) {
    const templates = p.manifest.providerTemplates;
    if (!Array.isArray(templates)) continue;
    for (const t of templates) {
      if (!t || typeof t !== "object") continue;
      if (!t.id || !t.displayName || !t.provider) continue;
      // Skip templates naming an unsupported provider adapter.
      if (!(PROVIDER_NAMES as readonly string[]).includes(t.provider)) continue;
      out.push({
        ...t,
        // Namespace so plugin templates can't shadow built-ins or each other.
        id: `${p.manifest.name}/${t.id}`,
        displayName: t.displayName,
      });
    }
  }
  return out;
}

/**
 * Merge plugin hooks and MCP server configs into a session config.
 * Returns a new config object; does not mutate the input.
 *
 * When a plugin opts into permission enforcement (its manifest has a
 * `permissions` field), a capability-bearing resource it did not declare is
 * refused (fail-closed) and reported via `onWarn`. Plugins without a
 * `permissions` field keep the legacy behaviour (no gating).
 */
export function mergePluginConfig(
  config: Record<string, unknown>,
  plugins: Map<string, Plugin>,
  onWarn: (message: string) => void = () => {},
  /** Optional content-trust gate. When provided, a plugin whose sensitive
   * content (hooks / mcpServers / runtime) has DRIFTED from the hash recorded at
   * install consent has those components skipped until re-confirmation. A plugin
   * with no recorded hash is not gated (legacy-compatible). */
  trust?: PluginTrustGate,
): Record<string, unknown> {
  const merged = { ...config };
  const deny = (name: string, cap: PluginPermission): void =>
    onWarn(
      `plugin "${name}" ships ${cap === "mcp" ? "MCP servers" : cap} but did not declare the "${cap}" permission — skipped. Add "${cap}" to the plugin's permissions to allow it.`,
    );
  // A plugin whose fingerprinted content changed since consent: its sensitive
  // components are untrusted until re-confirmed. Warn once per plugin.
  const warnedDrift = new Set<string>();
  const contentTrusted = (p: Plugin): boolean => {
    if (!trust) return true;
    const ok = trust.isTrusted(p.manifest.name, pluginContentHash(p.manifest));
    if (!ok && !warnedDrift.has(p.manifest.name)) {
      warnedDrift.add(p.manifest.name);
      onWarn(
        `plugin "${p.manifest.name}" has changed on disk since you approved it — its hooks and MCP servers are disabled until you re-confirm the plugin (its sensitive content no longer matches the approved fingerprint).`,
      );
    }
    return ok;
  };

 // Merge hooks (gated by the "hooks" permission).
  const hooks = { ...(merged.hooks as Record<string, unknown[]> ?? {}) };
  let hooksChanged = false;
  for (const p of plugins.values()) {
    if (!p.manifest.hooks || Object.keys(p.manifest.hooks).length === 0) continue;
    if (!allowsCapability(p.manifest, "hooks")) {
      deny(p.manifest.name, "hooks");
      continue;
    }
    if (!contentTrusted(p)) continue;
    for (const [event, entries] of Object.entries(p.manifest.hooks)) {
      if (Array.isArray(entries)) {
        hooks[event] = [...(hooks[event] ?? []), ...entries];
        hooksChanged = true;
      }
    }
  }
  if (hooksChanged) merged.hooks = hooks;
 // Merge MCP servers (gated by the "mcp" permission).
  const mcpServers = { ...(merged.mcpServers as Record<string, unknown> ?? {}) };
  let mcpChanged = false;
  for (const p of plugins.values()) {
    if (!p.manifest.mcpServers || Object.keys(p.manifest.mcpServers).length === 0) continue;
    if (!allowsCapability(p.manifest, "mcp")) {
      deny(p.manifest.name, "mcp");
      continue;
    }
    if (!contentTrusted(p)) continue;
    for (const [name, cfg] of Object.entries(p.manifest.mcpServers)) {
      mcpServers[name] = cfg;
      mcpChanged = true;
    }
  }
  if (mcpChanged) merged.mcpServers = mcpServers;
 // Runtime: a plugin may declare itself the session runtime (`default: true`),
 // gated by the "runtime" permission. Drop runtime-bearing plugins that
 // didn't declare it before resolving the default, so an undeclared runtime
 // can neither become the default nor be referenced.
  const runtimeAllowed = new Map<string, Plugin>();
  for (const [key, p] of plugins) {
    if (p.manifest.runtime !== undefined && !allowsCapability(p.manifest, "runtime")) {
      deny(p.manifest.name, "runtime");
      continue;
    }
    // A runtime-bearing plugin whose content drifted is also untrusted — its
    // runtime replaces the agent loop, the most sensitive component of all.
    if (p.manifest.runtime !== undefined && !contentTrusted(p)) continue;
    runtimeAllowed.set(key, p);
  }
  const pluginDefault = pluginDefaultRuntime(runtimeAllowed, merged.runtime as string | undefined);
  if (pluginDefault !== undefined) merged.runtime = pluginDefault;
  return merged;
}

/**
 * The runtime name a plugin declared as session default (`runtime.default
 * === true`), or undefined. `existing` = already-chosen name (config/session);
 * conflicting defaults throw rather than pick silently. `registered` (plugin
 * → registered name, from {@link loadPluginRuntimes}) resolves a manifest
 * omitting `runtime.name` from the factory (post-import); without it the
 * plugin name is the best guess.
 */
export function pluginDefaultRuntime(
  plugins: Map<string, Plugin>,
  existing?: string,
  registered?: Map<string, string>
): string | undefined {
  let chosen: string | undefined;
  for (const p of plugins.values()) {
    const rt = p.manifest.runtime;
    if (!rt || typeof rt === "string" || rt.default !== true) continue;
    const name = registered?.get(p.manifest.name) ?? rt.name ?? p.manifest.name;
    const conflict = chosen ?? existing;
    if (conflict !== undefined) {
      throw new Error(
        `multiple plugins declare a default runtime: "${conflict}" (config) vs ` +
        `"${name}" (plugin ${p.manifest.name}). Set config.runtime explicitly to disambiguate.`
      );
    }
    chosen = name;
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Plugin-provided agent runtimes
// ---------------------------------------------------------------------------

export interface PluginRuntimeLoadResult {
 /** Factory names successfully registered, keyed by plugin name. */
  registered: Map<string, string>;
 /** Per-plugin load failures (plugin name → error message). */
  errors: Map<string, string>;
}

/**
 * Dynamically import each discovered plugin's `runtime` module and register
 * its `RuntimeFactory` (default: process-wide {@link runtimeRegistry}). Factory
 * export may be default or named `factory`/`runtimeFactory`; `name` overridable
 * via manifest `runtime.name`. Per-plugin isolated — failures collected in
 * `errors` for host surfacing. Call after `discoverPlugins`, before session
 * creation.
 */
export async function loadPluginRuntimes(
  plugins: Map<string, Plugin>,
  registry: RuntimeRegistry = runtimeRegistry
): Promise<PluginRuntimeLoadResult> {
  const registered = new Map<string, string>();
  const errors = new Map<string, string>();

  for (const p of plugins.values()) {
    const rt = p.manifest.runtime;
    if (!rt) continue;
    if (!allowsCapability(p.manifest, "runtime")) {
      // Opted into enforcement but didn't declare "runtime": do NOT import
      // the module (importing is itself code execution). Record it so hosts
      // can surface the refusal via /plugins.
      errors.set(
        p.manifest.name,
        `runtime module not loaded: plugin did not declare the "runtime" permission`,
      );
      continue;
    }
    const relModule = typeof rt === "string" ? rt : rt.module;
    const nameOverride = typeof rt === "object" ? rt.name : undefined;
    try {
      const modulePath = join(p.path, relModule);
      if (!existsSync(modulePath)) {
        throw new Error(`runtime module not found: ${modulePath}`);
      }
      const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
      const factory = (mod.default ?? mod.factory ?? mod.runtimeFactory) as RuntimeFactory | undefined;
      if (!factory || typeof factory !== "object") {
        throw new Error(
          `plugin runtime module must export a RuntimeFactory (default, "factory", or "runtimeFactory" export)`
        );
      }
      const factoryName = nameOverride ?? factory.name;
      if (!factoryName || typeof factoryName !== "string") {
        throw new Error("runtime factory has no name (set manifest runtime.name or factory.name)");
      }
      if (typeof factory.create !== "function") {
        throw new Error("runtime factory has no create(deps) function");
      }
      registry.register({ name: factoryName, create: factory.create.bind(factory) });
      registered.set(p.manifest.name, factoryName);
    } catch (err) {
      errors.set(p.manifest.name, (err as Error).message);
    }
  }
  return { registered, errors };
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
}

/**
 * Discover plugins for `cwd`, register their runtimes, and report the session
 * default runtime if any. The one call hosts need; `createSession` does it
 * automatically. Idempotent — safe to call once per session.
 */
export async function initPluginRuntimes(
  cwd: string,
  opts: InitPluginRuntimesOptions = {}
): Promise<PluginRuntimeInit> {
  const plugins = await discoverPlugins(cwd, opts);
  const loaded = await loadPluginRuntimes(plugins, opts.registry);
 // A plugin whose module failed to load must not be named as the default —
 // that would turn a load warning into a hard failure at prompt time.
  const loadable = new Map(
    [...plugins].filter(([name]) => !loaded.errors.has(name))
  );
  return {
    ...loaded,
    plugins,
    defaultRuntime: pluginDefaultRuntime(loadable, opts.existingRuntime, loaded.registered),
  };
}

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

export interface InstallOptions {
 /** Override the install directory (default: ~/.codepilot/plugins/<name>). */
  installDir?: string;
 /** Force re-install if the plugin already exists. */
  force?: boolean;
 /** Trust store to record the plugin's sensitive-content fingerprint into at
  * install-consent time. Defaults to the shared `~/.codepilot/plugins/.trust.json`
  * store; override for tests. */
  trustStore?: PluginTrustStore;
}

/**
 * Install a plugin from a git URL (cloned) or local path (copied). A `#subdir`
 * fragment selects a monorepo sub-directory (cloned to temp, only `<subdir>`
 * copied; works for git URLs and local paths).
 * Returns the installed path. Throws if it exists (unless `force`) or has no
 * `plugin.json`.
 */
export async function installPlugin(
  source: string,
  opts: InstallOptions = {}
): Promise<string> {
  const name = derivePluginName(source);
  const target = opts.installDir ?? join(homedir(), ".codepilot", "plugins", name);
  if (existsSync(target)) {
    if (!opts.force) {
      throw new Error(`plugin ${name} already installed at ${target} (use force: true to overwrite)`);
    }
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(join(homedir(), ".codepilot", "plugins"), { recursive: true });

  await fetchPluginInto(source, target);

 // Verify the manifest exists.
  const manifestPath = join(target, "plugin.json");
  if (!existsSync(manifestPath)) {
    await rm(target, { recursive: true, force: true });
    throw new Error(`installed source has no plugin.json — not a valid plugin`);
  }
 // Record the sensitive-content fingerprint at install-consent time. Reaching
 // here means the caller consented (after inspectPluginSource). A later on-disk
 // change to the plugin's hooks / MCP servers / runtime will no longer match
 // this hash, and mergePluginConfig skips those components until the user
 // re-confirms. Best-effort: a trust-file write failure must not fail install.
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as PluginManifest;
    const store = opts.trustStore ?? new PluginTrustStore();
    await store.record(manifest.name, pluginContentHash(manifest));
  } catch {
 /* non-fatal: content trust is defence-in-depth, not install-critical */
  }
  return target;
}

/**
 * Fetch a plugin source (git URL or local path, honouring a `#subdir`
 * monorepo fragment) into `target`. Shared by {@link installPlugin} and
 * {@link inspectPluginSource}. Does not verify the manifest — the caller does.
 */
async function fetchPluginInto(source: string, target: string): Promise<void> {
  // Split off an optional `#subdir` monorepo fragment.
  const hash = source.indexOf("#");
  const bare = hash >= 0 ? source.slice(0, hash) : source;
  const subdir = hash >= 0 ? source.slice(hash + 1).replace(/^\/+|\/+$/g, "") : "";

  if (bare.startsWith("http://") || bare.startsWith("https://") || bare.startsWith("git@")) {
    if (subdir) {
      // Clone the whole repo to a temp dir, then copy only the sub-directory.
      const tmp = await mkdtemp(join(tmpdir(), "codepilot-plugin-"));
      try {
        await execFileAsync("git", ["clone", "--depth", "1", bare, tmp]);
        const picked = join(tmp, subdir);
        if (!existsSync(picked)) {
          throw new Error(`sub-directory not found in repo: ${subdir}`);
        }
        await mkdir(target, { recursive: true });
        await execFileAsync("cp", ["-R", `${picked}/.`, target]);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    } else {
      const { stdout, stderr } = await execFileAsync("git", ["clone", "--depth", "1", bare, target]);
      if (stderr && !stdout) {
        // git writes progress to stderr; only throw on actual errors
      }
    }
  } else {
    // Local directory copy (honours a `#subdir` fragment too).
    const root = isAbsolute(bare) ? bare : resolve(process.cwd(), bare);
    const src = subdir ? join(root, subdir) : root;
    if (!existsSync(src)) throw new Error(`source not found: ${src}`);
    await mkdir(target, { recursive: true });
    const { stdout } = await execFileAsync("cp", ["-R", `${src}/.`, target]);
    void stdout;
  }
}

/**
 * Inspect what a plugin source WILL do, without installing it. Fetches the
 * source into a temp dir (git clone / local copy), reads its manifest, builds
 * a {@link PluginCapabilityReport} (including a static scan for registered
 * tools), then discards the temp copy. Use this to drive an install
 * confirmation prompt: show the user the tools / side effects before any
 * plugin code lands in `~/.codepilot/plugins/` or runs.
 *
 * Throws if the source has no valid `plugin.json`.
 */
export async function inspectPluginSource(source: string): Promise<PluginCapabilityReport> {
  const tmp = await mkdtemp(join(tmpdir(), "codepilot-plugin-inspect-"));
  try {
    await fetchPluginInto(source, tmp);
    const manifestPath = join(tmp, "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`source has no plugin.json — not a valid plugin`);
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as PluginManifest;
    if (!manifest?.name || !manifest?.description || !manifest?.version) {
      throw new Error(`plugin.json is missing required name/description/version`);
    }
    return await describePluginCapabilities(manifest, tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Uninstall a plugin by name. Removes the plugin directory from
 * `~/.codepilot/plugins/<name>/`. Returns true if the plugin was found
 * and removed.
 */
export async function uninstallPlugin(name: string): Promise<boolean> {
  const target = join(homedir(), ".codepilot", "plugins", name);
  if (!existsSync(target)) return false;
  await rm(target, { recursive: true, force: true });
  // Drop the recorded content fingerprint so a future re-install re-approves
  // from scratch rather than matching a stale hash. Best-effort.
  try {
    await new PluginTrustStore().forget(name);
  } catch {
    /* non-fatal */
  }
  return true;
}

/** Derive a plugin name from a source URL or path. */
export function derivePluginName(source: string): string {
 // For git URLs: use the repo name (last path segment, minus .git).
 // For local paths: use the directory name.
 // A `#subdir` fragment (monorepo sub-path) names the plugin after the
 // sub-directory, not the repo — e.g. `.../plugins.git#code-review` → `code-review`.
  const hash = source.indexOf("#");
  if (hash >= 0) {
    const sub = source.slice(hash + 1).replace(/\/$/, "");
    const segs = sub.split("/").filter(Boolean);
    if (segs.length > 0) return segs[segs.length - 1]!;
  }
  const clean = source.slice(0, hash >= 0 ? hash : undefined).replace(/\.git$/, "").replace(/\/$/, "");
  const segments = clean.split(/[\/:]/);
  return segments[segments.length - 1] ?? "unknown-plugin";
}

// ---------------------------------------------------------------------------
// Marketplace (simple JSON index)
// ---------------------------------------------------------------------------

/**
 * Fetch a marketplace index from a URL. The index is a JSON array of
 * `MarketplaceEntry` objects (or a `{ plugins: [...] }` document). This is a
 * simple HTTP GET — no auth, no pagination. Marketplace hosts can serve this
 * as a static JSON file (e.g. GitHub Pages / raw.githubusercontent.com).
 *
 * The URL must be http(s). This is third-party content: CodePilot validates
 * the format, not the claims — callers should show the install `source` for
 * confirmation before installing (see {@link describeMarketplaceEntry}).
 */
export async function fetchMarketplaceIndex(url: string): Promise<MarketplaceEntry[]> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "CodePilot-plugins/1" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`marketplace index fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as unknown;
  return coercePluginIndex(data);
}

/** Normalise a fetched index into `MarketplaceEntry[]`. Accepts either a bare
 * array or a `{ plugins: [...] }` document (the shape of the bundled catalog).
 * Entries missing the required `name`/`source` are dropped, so one malformed
 * row never poisons the whole list. */
function coercePluginIndex(data: unknown): MarketplaceEntry[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { plugins?: unknown })?.plugins)
      ? (data as { plugins: unknown[] }).plugins
      : null;
  if (!rows) throw new Error("marketplace index is not an array or { plugins: [] }");
  const out: MarketplaceEntry[] = [];
  for (const r of rows) {
    const e = r as Partial<MarketplaceEntry>;
    if (typeof e.name !== "string" || typeof e.source !== "string") continue;
    out.push({
      name: e.name,
      description: typeof e.description === "string" ? e.description : "",
      source: e.source,
      version: typeof e.version === "string" ? e.version : undefined,
      author: typeof e.author === "string" ? e.author : undefined,
      tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : undefined,
    });
  }
  return out;
}

/**
 * The default, GitHub-hosted plugin marketplace — the out-of-the-box
 * discovery entry point. Mirrors `listMcpMarkets`: served from the shared
 * remote catalog (`catalog/plugins.json`, daily refresh) with a bundled
 * offline seed, so it works offline and degrades to the shipped list on any
 * network/parse failure. Pass `{ force: true }` to refresh today.
 *
 * This is what a `/plugins` browse flow calls to list installable plugins
 * without the user having to know a git URL upfront.
 */
export async function listPluginMarket(opts?: { force?: boolean }): Promise<MarketplaceEntry[]> {
  try {
    const { loadCatalogDocument } = await import("./remoteCatalog.js");
    const { data } = await loadCatalogDocument<{ plugins?: unknown }>("plugins", opts);
    return coercePluginIndex(data);
  } catch {
    return [];
  }
}

/**
 * Search the marketplace index for entries matching a query. Matches
 * against name, description, and tags (case-insensitive substring).
 */
export function searchMarketplace(
  index: MarketplaceEntry[],
  query: string
): MarketplaceEntry[] {
  const q = query.toLowerCase();
  return index.filter((e) => {
    return (
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  });
}

/** A human-readable one-line summary of where a marketplace entry installs
 * FROM, for a confirmation prompt before install. Surfacing the source is the
 * trust gate: the index is third-party content, so the caller should show
 * this and get consent before `installPlugin(entry.source)`. */
export function describeMarketplaceEntry(entry: MarketplaceEntry): string {
  const kind = /^(https?:\/\/|git@)/.test(entry.source) ? "git" : "local path";
  const ver = entry.version ? ` v${entry.version}` : "";
  const by = entry.author ? ` by ${entry.author}` : "";
  return `${entry.name}${ver}${by} — installs from ${kind}: ${entry.source}`;
}
