import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeRegistry, type RuntimeFactory, type RuntimeRegistry } from "../agent/runtime.js";
import { PluginTrustStore } from "./plugins-trust.js";
import { pluginSensitiveTrusted } from "./capabilities.js";
import { discoverPlugins, pluginDefaultRuntime } from "./discover.js";
import { allowsCapability, untrustedPluginMessage } from "./gating.js";
import type {
  InitPluginRuntimesOptions,
  Plugin,
  PluginRuntimeInit,
  PluginRuntimeLoadResult,
  PluginTrustGate,
} from "./types.js";

/**
 * Import each discovered plugin's `runtime` module and register its
 * `RuntimeFactory` (default or `factory`/`runtimeFactory` export). Per-plugin
 * isolated; failures collected in `errors`. Call after `discoverPlugins`.
 */
export async function loadPluginRuntimes(
  plugins: Map<string, Plugin>,
  registry: RuntimeRegistry = runtimeRegistry,
  trust?: PluginTrustGate,
): Promise<PluginRuntimeLoadResult> {
  const registered = new Map<string, string>();
  const errors = new Map<string, string>();

  for (const p of plugins.values()) {
    const rt = p.manifest.runtime;
    if (!rt) continue;
    if (!pluginSensitiveTrusted(p, trust)) {
      errors.set(p.manifest.name, untrustedPluginMessage(p, trust));
      continue;
    }
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
  let trust = opts.trust;
  if (!trust) {
    const store = new PluginTrustStore();
    await store.load();
    trust = store;
  }
  const loaded = await loadPluginRuntimes(plugins, opts.registry, trust);
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