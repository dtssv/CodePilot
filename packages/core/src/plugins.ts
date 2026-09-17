/**
 * Plugins — bundled, distributable extensions (claude-code parity).
 *
 * A plugin is a directory containing a `plugin.json` manifest plus any
 * combination of skills, agents, commands, hooks, and MCP server configs.
 * Plugins are discovered from:
 *
 *   1. <cwd>/.codepilot/plugins/<name>/   (project-local)
 *   2. ~/.codepilot/plugins/<name>/       (user-global, installed)
 *
 * When a plugin is loaded, its resources are merged into the session's
 * existing discovery paths:
 *   - `skills/`     → added to the skill discovery path list
 *   - `agents/`     → added to the custom-agent discovery path list
 *   - `commands/`   → added to the slash-command discovery path list
 *   - `hooks`       → merged into the session's hooks config
 *   - `mcpServers`  → merged into the session's MCP server config
 *
 * Installation: `installPlugin(cwd, source)` clones a git repo (or copies a
 * local directory) into `~/.codepilot/plugins/<name>/`. Uninstallation
 * removes the directory. A simple marketplace registry (JSON index of
 * plugin repos) can be fetched from a URL for `search`/`install` flows.
 *
 * @module plugins
 */
import { readdir, readFile, stat, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runtimeRegistry, type RuntimeFactory, type RuntimeRegistry } from "./runtime.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** Whether the plugin is enabled (default true). */
  enabled?: boolean;
  /**
   * Custom agent runtime (ROADMAP-NEXT §4.1 Phase 2). Points to a JS module
   * inside the plugin directory that exports a `RuntimeFactory` — either as
   * the default export or as a named `factory` / `runtimeFactory` export:
   *
   *   // runtime.mjs
   *   export default { name: "my-runtime", create: (deps) => new MyRuntime(deps) };
   *
   * - String form: relative module path; the factory's own `name` is used.
   * - Object form: `module` (path), optional `name` (overrides the factory
   *   name), optional `default: true` to claim the session runtime, so a
   *   session uses it without any config (see {@link initPluginRuntimes},
   *   which `createSession` calls). Only one plugin may claim the default.
   *
   * The module runs in the host process with full Node access — only install
   * plugins from trusted sources. Load via {@link loadPluginRuntimes}.
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
 * Merge plugin hooks and MCP server configs into a session config.
 * Returns a new config object; does not mutate the input.
 */
export function mergePluginConfig(
  config: Record<string, unknown>,
  plugins: Map<string, Plugin>
): Record<string, unknown> {
  const merged = { ...config };
  // Merge hooks.
  const hooks = { ...(merged.hooks as Record<string, unknown[]> ?? {}) };
  let hooksChanged = false;
  for (const p of plugins.values()) {
    if (p.manifest.hooks) {
      for (const [event, entries] of Object.entries(p.manifest.hooks)) {
        if (Array.isArray(entries)) {
          hooks[event] = [...(hooks[event] ?? []), ...entries];
          hooksChanged = true;
        }
      }
    }
  }
  if (hooksChanged) merged.hooks = hooks;
  // Merge MCP servers.
  const mcpServers = { ...(merged.mcpServers as Record<string, unknown> ?? {}) };
  let mcpChanged = false;
  for (const p of plugins.values()) {
    if (p.manifest.mcpServers) {
      for (const [name, cfg] of Object.entries(p.manifest.mcpServers)) {
        mcpServers[name] = cfg;
        mcpChanged = true;
      }
    }
  }
  if (mcpChanged) merged.mcpServers = mcpServers;
  // Runtime: a plugin may declare itself the session runtime (`default: true`).
  const pluginDefault = pluginDefaultRuntime(plugins, merged.runtime as string | undefined);
  if (pluginDefault !== undefined) merged.runtime = pluginDefault;
  return merged;
}

/**
 * The runtime name a plugin declared as the session default (manifest
 * `runtime.default === true`), or undefined when no plugin claims one.
 *
 * `existing` is an already-chosen runtime name (from config or an explicit
 * session option). Because two conflicting defaults — or a default that
 * contradicts explicit config — can only be resolved by the user, this
 * throws instead of picking a winner silently. Returns undefined when
 * `existing` is set and no plugin declares a default, so callers can keep
 * their own value.
 *
 * `registered` maps plugin name → the name the runtime was actually
 * registered under (as returned by {@link loadPluginRuntimes}). Pass it
 * whenever the modules have been loaded: a manifest that omits
 * `runtime.name` takes its name from the factory, which is only knowable
 * after the import. Without it, the plugin's own name is the best guess.
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
// Plugin-provided agent runtimes (ROADMAP-NEXT §4.1 Phase 2)
// ---------------------------------------------------------------------------

export interface PluginRuntimeLoadResult {
  /** Factory names successfully registered, keyed by plugin name. */
  registered: Map<string, string>;
  /** Per-plugin load failures (plugin name → error message). */
  errors: Map<string, string>;
}

/**
 * Dynamically import every discovered plugin's `runtime` module and register
 * its `RuntimeFactory` with the given registry (default: the process-wide
 * {@link runtimeRegistry}).
 *
 * The module may export the factory as the default export, or as a named
 * `factory` / `runtimeFactory` export. The factory's `name` may be overridden
 * by the manifest's `runtime.name`. Loading is per-plugin isolated: one bad
 * module does not prevent other plugins from loading; failures are collected
 * in the returned `errors` map so hosts can surface them (e.g. `/plugins`).
 *
 * Call this AFTER `discoverPlugins` and BEFORE creating a session whose
 * config references a plugin runtime.
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
   *  conflicts with a plugin that declares itself the default. */
  existingRuntime?: string;
}

/**
 * Discover plugins for `cwd` and register every runtime they declare, then
 * report which runtime (if any) should become the session default.
 *
 * This is the one call a host needs to make plugin runtimes usable;
 * `createSession` does it automatically. Registration is idempotent, so
 * calling it once per session is fine.
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
}

/**
 * Install a plugin from a git URL or local directory.
 *
 * - Git URLs (start with `http` or `git@`): cloned into the plugins dir.
 * - Local paths: copied into the plugins dir.
 *
 * Returns the installed plugin path. Throws if the plugin already exists
 * (unless `force: true`) or if the source has no `plugin.json`.
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

  if (source.startsWith("http://") || source.startsWith("https://") || source.startsWith("git@")) {
    // Git clone.
    const { stdout, stderr } = await execFileAsync("git", ["clone", "--depth", "1", source, target]);
    if (stderr && !stdout) {
      // git writes progress to stderr; only throw on actual errors
    }
  } else {
    // Local directory copy.
    const src = isAbsolute(source) ? source : resolve(process.cwd(), source);
    if (!existsSync(src)) throw new Error(`source not found: ${src}`);
    await mkdir(target, { recursive: true });
    const { stdout } = await execFileAsync("cp", ["-R", `${src}/.`, target]);
    void stdout;
  }

  // Verify the manifest exists.
  const manifestPath = join(target, "plugin.json");
  if (!existsSync(manifestPath)) {
    await rm(target, { recursive: true, force: true });
    throw new Error(`installed source has no plugin.json — not a valid plugin`);
  }
  return target;
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
  return true;
}

/** Derive a plugin name from a source URL or path. */
export function derivePluginName(source: string): string {
  // For git URLs: use the repo name (last path segment, minus .git).
  // For local paths: use the directory name.
  const clean = source.replace(/\.git$/, "").replace(/\/$/, "");
  const segments = clean.split(/[\/:]/);
  return segments[segments.length - 1] ?? "unknown-plugin";
}

// ---------------------------------------------------------------------------
// Marketplace (simple JSON index)
// ---------------------------------------------------------------------------

/**
 * Fetch a marketplace index from a URL. The index is a JSON array of
 * `MarketplaceEntry` objects. This is a simple HTTP GET — no auth,
 * no pagination. Marketplace hosts can serve this as a static JSON file.
 */
export async function fetchMarketplaceIndex(url: string): Promise<MarketplaceEntry[]> {
  const { default: fetch } = await import("node:https");
  // Use global fetch (Node 20+).
  const res = await globalThis.fetch(url);
  if (!res.ok) {
    throw new Error(`marketplace index fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as MarketplaceEntry[];
  if (!Array.isArray(data)) {
    throw new Error("marketplace index is not an array");
  }
  return data;
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
