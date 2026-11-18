import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginContentHash } from "./plugins-trust.js";
import type {
  Plugin,
  PluginManifest,
  PluginPermission,
  PluginPermissionReport,
  PluginCapabilityReport,
  PluginTrustGate,
} from "./types.js";

/**
 * Whether a plugin's sensitive parts (hooks / MCP servers / runtime code) may
 * load. A user plugin is trusted unless its content drifted from the hash
 * recorded at install. A project plugin ships inside the repository being
 * opened, so it needs an explicit approval matching its current content —
 * otherwise opening an untrusted repo would run its code.
 */
export function pluginSensitiveTrusted(p: Plugin, trust: PluginTrustGate | undefined): boolean {
  if (!trust) return true;
  const hash = pluginContentHash(p.manifest);
  if (p.source === "project" && trust.recorded) return trust.recorded(p.manifest.name) === hash;
  return trust.isTrusted(p.manifest.name, hash);
}

/** Capability-bearing resources a plugin can contribute, and the permission
 * each requires. These are the ones that run code or spawn processes. */
const GATED_CAPABILITIES: ReadonlyArray<{ cap: PluginPermission; present: (m: PluginManifest) => boolean }> = [
  { cap: "hooks", present: (m) => !!m.hooks && Object.keys(m.hooks).length > 0 },
  { cap: "mcp", present: (m) => !!m.mcpServers && Object.keys(m.mcpServers).length > 0 },
  { cap: "runtime", present: (m) => m.runtime !== undefined },
];

/**
 * Report a plugin's declared permissions vs. the capabilities its manifest
 * ships. `violations` is empty when the plugin didn't opt into enforcement.
 */
export function pluginPermissionReport(plugin: Plugin): PluginPermissionReport {
  const m = plugin.manifest;
  const enforced = Array.isArray(m.permissions);
  const declared = enforced ? [...new Set(m.permissions!)] : [];
  const used = GATED_CAPABILITIES.filter((g) => g.present(m)).map((g) => g.cap);
  const violations = enforced ? used.filter((c) => !declared.includes(c)) : [];
  return { name: m.name, declared, enforced, used, violations };
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
