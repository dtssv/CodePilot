import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PROVIDER_NAMES } from "../types.js";
import { pluginContentHash, PluginTrustStore } from "./plugins-trust.js";
import { pluginSensitiveTrusted } from "./capabilities.js";
import { allowsCapability, untrustedPluginMessage } from "./gating.js";
import type {
  DiscoverPluginsOptions,
  Plugin,
  PluginManifest,
  PluginPermission,
  PluginProviderTemplate,
  PluginTrustGate,
} from "./types.js";

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

/** Record approval of a discovered plugin's current sensitive content. */
export async function trustPlugin(
  cwd: string,
  name: string,
  store: PluginTrustStore = new PluginTrustStore(),
): Promise<boolean> {
  const p = (await discoverPlugins(cwd)).get(name);
  if (!p) return false;
  await store.record(name, pluginContentHash(p.manifest));
  return true;
}

/**
 * Collect resource directories from discovered plugins (project before user).
 * Pass to `discoverSkills`/`discoverCustomAgents`/`discoverSlashCommands`
 * as `extraDirs`.
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
 * Ids namespaced `<plugin>/<id>`; invalid ones are skipped. Feed to
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
 * Merge plugin hooks and MCP server configs into a session config (new object).
 * Enforced plugins refuse undeclared capabilities (fail-closed, via `onWarn`);
 * plugins without a `permissions` field keep legacy no-gating behaviour.
 */
export function mergePluginConfig(
  config: Record<string, unknown>,
  plugins: Map<string, Plugin>,
  onWarn: (message: string) => void = () => {},
  /** Optional content-trust gate (see {@link pluginSensitiveTrusted}): drifted
   * user plugins and unapproved project plugins have their hooks / MCP servers
   * skipped until confirmed. */
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
    const ok = pluginSensitiveTrusted(p, trust);
    if (!ok && !warnedDrift.has(p.manifest.name)) {
      warnedDrift.add(p.manifest.name);
      onWarn(untrustedPluginMessage(p, trust));
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
 * === true`), or undefined. Conflicting defaults throw. `registered` resolves
 * a manifest omitting `runtime.name` from the factory post-import.
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