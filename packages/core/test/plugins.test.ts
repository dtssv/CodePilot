import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverPlugins,
  pluginResourcePaths,
  collectPluginProviderTemplates,
  mergePluginConfig,
  installPlugin,
  inspectPluginSource,
  uninstallPlugin,
  searchMarketplace,
  fetchMarketplaceIndex,
  listPluginMarket,
  describeMarketplaceEntry,
  describePluginCapabilities,
  derivePluginName,
  pluginPermissionReport,
  type Plugin,
  type PluginManifest,
  type MarketplaceEntry,
} from "../src/plugins.js";
import { resetCatalogMemoryForTests } from "../src/remoteCatalog.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "test-plugin",
    description: "A test plugin",
    version: "1.0.0",
    ...overrides,
  };
}

function writePlugin(
  baseDir: string,
  dirName: string,
  manifest: Partial<PluginManifest> | null,
  subdirs: string[] = []
): string {
  const pluginDir = join(baseDir, dirName);
  mkdirSync(pluginDir, { recursive: true });
  if (manifest !== null) {
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify(makeManifest(manifest), null, 2),
      "utf-8"
    );
  }
  for (const sub of subdirs) {
    mkdirSync(join(pluginDir, sub), { recursive: true });
  }
  return pluginDir;
}

// ---------------------------------------------------------------------------
// discoverPlugins
// ---------------------------------------------------------------------------

describe("discoverPlugins", () => {
  let work: string;
  let userDir: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "plugins-work-"));
    userDir = mkdtempSync(join(tmpdir(), "plugins-user-"));
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it("finds plugins in the project directory", async () => {
    const projectPlugins = join(work, ".codepilot", "plugins");
    writePlugin(projectPlugins, "my-plugin", { name: "my-plugin", description: "proj" });

    const plugins = await discoverPlugins(work, {
      projectDir: projectPlugins,
      userDir: join(userDir, "plugins"),
    });

    expect(plugins.size).toBe(1);
    const p = plugins.get("my-plugin");
    expect(p).toBeDefined();
    expect(p!.source).toBe("project");
    expect(p!.manifest.name).toBe("my-plugin");
    expect(p!.path).toBe(join(projectPlugins, "my-plugin"));
  });

  it("finds plugins in the user directory", async () => {
    const userPlugins = join(userDir, "plugins");
    writePlugin(userPlugins, "user-plugin", { name: "user-plugin", description: "user" });

    const plugins = await discoverPlugins(work, {
      projectDir: join(work, ".codepilot", "plugins"),
      userDir: userPlugins,
    });

    expect(plugins.size).toBe(1);
    const p = plugins.get("user-plugin");
    expect(p).toBeDefined();
    expect(p!.source).toBe("user");
  });

  it("project plugins take precedence over user plugins with the same name", async () => {
    const projectPlugins = join(work, ".codepilot", "plugins");
    const userPlugins = join(userDir, "plugins");
    writePlugin(projectPlugins, "shared", { name: "shared", description: "from project" });
    writePlugin(userPlugins, "shared", { name: "shared", description: "from user" });

    const plugins = await discoverPlugins(work, {
      projectDir: projectPlugins,
      userDir: userPlugins,
    });

    expect(plugins.size).toBe(1);
    expect(plugins.get("shared")!.source).toBe("project");
    expect(plugins.get("shared")!.manifest.description).toBe("from project");
  });

  it("skips disabled plugins (enabled: false)", async () => {
    const projectPlugins = join(work, ".codepilot", "plugins");
    writePlugin(projectPlugins, "disabled-one", {
      name: "disabled-one",
      description: "disabled",
      enabled: false,
    });
    writePlugin(projectPlugins, "enabled-one", { name: "enabled-one", description: "enabled" });

    const plugins = await discoverPlugins(work, {
      projectDir: projectPlugins,
      userDir: join(userDir, "plugins"),
    });

    expect(plugins.size).toBe(1);
    expect(plugins.has("disabled-one")).toBe(false);
    expect(plugins.has("enabled-one")).toBe(true);
  });

  it("skips directories without a plugin.json", async () => {
    const projectPlugins = join(work, ".codepilot", "plugins");
 // Directory with no manifest at all
    writePlugin(projectPlugins, "no-manifest", null);
 // Valid plugin alongside it
    writePlugin(projectPlugins, "valid", { name: "valid", description: "ok" });

    const plugins = await discoverPlugins(work, {
      projectDir: projectPlugins,
      userDir: join(userDir, "plugins"),
    });

    expect(plugins.size).toBe(1);
    expect(plugins.has("no-manifest")).toBe(false);
    expect(plugins.has("valid")).toBe(true);
  });

  it("skips malformed manifests (invalid JSON)", async () => {
    const projectPlugins = join(work, ".codepilot", "plugins");
    const badDir = join(projectPlugins, "bad-json");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "plugin.json"), "not json{{{", "utf-8");
    writePlugin(projectPlugins, "good", { name: "good", description: "ok" });

    const plugins = await discoverPlugins(work, {
      projectDir: projectPlugins,
      userDir: join(userDir, "plugins"),
    });

    expect(plugins.size).toBe(1);
    expect(plugins.has("bad-json")).toBe(false);
    expect(plugins.has("good")).toBe(true);
  });

  it("skips manifests missing required fields", async () => {
    const projectPlugins = join(work, ".codepilot", "plugins");

 // Missing name
    writePlugin(projectPlugins, "no-name", { name: "", description: "ok", version: "1.0.0" });
 // Missing description
    writePlugin(projectPlugins, "no-desc", { name: "no-desc", description: "", version: "1.0.0" });
 // Missing version
    writePlugin(projectPlugins, "no-ver", { name: "no-ver", description: "ok", version: "" });
 // Valid one for contrast
    writePlugin(projectPlugins, "valid", { name: "valid", description: "ok", version: "1.0.0" });

    const plugins = await discoverPlugins(work, {
      projectDir: projectPlugins,
      userDir: join(userDir, "plugins"),
    });

    expect(plugins.size).toBe(1);
    expect(plugins.has("valid")).toBe(true);
  });

  it("returns an empty map when directories don't exist", async () => {
    const plugins = await discoverPlugins(work, {
      projectDir: join(work, "nonexistent"),
      userDir: join(userDir, "nonexistent"),
    });
    expect(plugins.size).toBe(0);
  });

  it("skips non-directory entries in the plugins dir", async () => {
    const projectPlugins = join(work, ".codepilot", "plugins");
    mkdirSync(projectPlugins, { recursive: true });
    writeFileSync(join(projectPlugins, "stray-file.txt"), "hello", "utf-8");
    writePlugin(projectPlugins, "real-plugin", { name: "real-plugin", description: "ok" });

    const plugins = await discoverPlugins(work, {
      projectDir: projectPlugins,
      userDir: join(userDir, "plugins"),
    });

    expect(plugins.size).toBe(1);
    expect(plugins.get("real-plugin")!.manifest.name).toBe("real-plugin");
  });
});

// ---------------------------------------------------------------------------
// collectPluginProviderTemplates (Phase 5 §4.3)
// ---------------------------------------------------------------------------

describe("collectPluginProviderTemplates", () => {
  let work: string;
  let userDir: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "plugins-tmpl-"));
    userDir = mkdtempSync(join(tmpdir(), "plugins-tmpl-user-"));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it("collects a plugin's provider templates with namespaced ids", async () => {
    const projectPlugins = join(work, ".codepilot", "plugins");
    writePlugin(projectPlugins, "acme", {
      name: "acme",
      description: "provider templates",
      providerTemplates: [
        {
          id: "gw",
          displayName: "Acme Gateway",
          provider: "openai",
          baseURL: "https://acme.example/v1",
          models: ["acme-large"],
        },
      ],
    });

    const templates = await collectPluginProviderTemplates(work, {
      projectDir: projectPlugins,
      userDir: join(userDir, "plugins"),
    });

    expect(templates).toHaveLength(1);
    // Namespaced so a plugin can never shadow a built-in id.
    expect(templates[0]!.id).toBe("acme/gw");
    expect(templates[0]!.displayName).toBe("Acme Gateway");
    expect(templates[0]!.baseURL).toBe("https://acme.example/v1");
  });

  it("skips templates missing a required field or naming an unknown provider", async () => {
    const projectPlugins = join(work, ".codepilot", "plugins");
    writePlugin(projectPlugins, "mixed", {
      name: "mixed",
      description: "some valid, some not",
      providerTemplates: [
        { id: "ok", displayName: "OK", provider: "anthropic" },
        // missing displayName
        { id: "bad1", provider: "openai" } as never,
        // unknown provider adapter
        { id: "bad2", displayName: "Bad", provider: "not-a-provider" } as never,
      ],
    });

    const templates = await collectPluginProviderTemplates(work, {
      projectDir: projectPlugins,
      userDir: join(userDir, "plugins"),
    });

    expect(templates.map((t) => t.id)).toEqual(["mixed/ok"]);
  });

  it("returns an empty list when no plugin declares templates", async () => {
    const projectPlugins = join(work, ".codepilot", "plugins");
    writePlugin(projectPlugins, "plain", { name: "plain", description: "no templates" });
    const templates = await collectPluginProviderTemplates(work, {
      projectDir: projectPlugins,
      userDir: join(userDir, "plugins"),
    });
    expect(templates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pluginResourcePaths
// ---------------------------------------------------------------------------

describe("pluginResourcePaths", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "plugins-res-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("aggregates skills/agents/commands paths from discovered plugins", async () => {
    const projectPlugins = join(base, "proj", "plugins");
    writePlugin(projectPlugins, "alpha", { name: "alpha", description: "a" }, [
      "skills",
      "agents",
      "commands",
    ]);
    writePlugin(projectPlugins, "beta", { name: "beta", description: "b" }, [
      "skills",
      "commands",
    ]);

    const plugins = await discoverPlugins(base, {
      projectDir: projectPlugins,
      userDir: join(base, "no-user"),
    });

    const paths = pluginResourcePaths(plugins);
    expect(paths.skills).toHaveLength(2);
    expect(paths.agents).toHaveLength(1);
    expect(paths.commands).toHaveLength(2);

    expect(paths.skills).toContain(join(projectPlugins, "alpha", "skills"));
    expect(paths.skills).toContain(join(projectPlugins, "beta", "skills"));
    expect(paths.agents).toContain(join(projectPlugins, "alpha", "agents"));
    expect(paths.commands).toContain(join(projectPlugins, "alpha", "commands"));
    expect(paths.commands).toContain(join(projectPlugins, "beta", "commands"));
  });

  it("skips non-existent subdirectories", async () => {
    const projectPlugins = join(base, "proj", "plugins");
 // Plugin with only skills/
    writePlugin(projectPlugins, "skills-only", { name: "skills-only", description: "s" }, [
      "skills",
    ]);
 // Plugin with no resource subdirs at all
    writePlugin(projectPlugins, "bare", { name: "bare", description: "b" });

    const plugins = await discoverPlugins(base, {
      projectDir: projectPlugins,
      userDir: join(base, "no-user"),
    });

    const paths = pluginResourcePaths(plugins);
    expect(paths.skills).toHaveLength(1);
    expect(paths.skills[0]).toBe(join(projectPlugins, "skills-only", "skills"));
    expect(paths.agents).toHaveLength(0);
    expect(paths.commands).toHaveLength(0);
  });

  it("returns empty arrays when no plugins are discovered", () => {
    const paths = pluginResourcePaths(new Map());
    expect(paths.skills).toEqual([]);
    expect(paths.agents).toEqual([]);
    expect(paths.commands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergePluginConfig
// ---------------------------------------------------------------------------

describe("mergePluginConfig", () => {
  function fakePlugin(
    name: string,
    overrides: Partial<PluginManifest> = {}
  ): Plugin {
    return {
      manifest: makeManifest({ name, ...overrides }),
      path: `/tmp/${name}`,
      source: "project",
      paths: {
        skills: `/tmp/${name}/skills`,
        agents: `/tmp/${name}/agents`,
        commands: `/tmp/${name}/commands`,
      },
    };
  }

  it("merges hooks from plugins into config", () => {
    const config = {
      hooks: {
        PreToolUse: [{ matcher: "bash", command: "lint" }],
      },
    };
    const plugins = new Map<string, Plugin>([
      [
        "p1",
        fakePlugin("p1", {
          hooks: {
            PreToolUse: [{ matcher: "edit", command: "format" }],
            PostToolUse: [{ matcher: "*", command: "notify" }],
          },
        }),
      ],
    ]);

    const merged = mergePluginConfig(config, plugins);
    const hooks = merged.hooks as Record<string, unknown[]>;

    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0]).toEqual({ matcher: "bash", command: "lint" });
    expect(hooks.PreToolUse[1]).toEqual({ matcher: "edit", command: "format" });
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PostToolUse[0]).toEqual({ matcher: "*", command: "notify" });
  });

  it("merges MCP servers from plugins into config", () => {
    const config = {
      mcpServers: {
        existing: { command: "npx", args: ["-y", "existing-server"] },
      },
    };
    const plugins = new Map<string, Plugin>([
      [
        "p1",
        fakePlugin("p1", {
          mcpServers: {
            "new-server": { command: "node", args: ["server.js"] },
          },
        }),
      ],
    ]);

    const merged = mergePluginConfig(config, plugins);
    const mcp = merged.mcpServers as Record<string, unknown>;

    expect(Object.keys(mcp)).toHaveLength(2);
    expect(mcp.existing).toEqual({ command: "npx", args: ["-y", "existing-server"] });
    expect(mcp["new-server"]).toEqual({ command: "node", args: ["server.js"] });
  });

  it("does not mutate the input config", () => {
    const originalHooks = { PreToolUse: [{ matcher: "bash" }] };
    const originalMcp = { existing: { command: "npx" } };
    const config = { hooks: originalHooks, mcpServers: originalMcp };

    const plugins = new Map<string, Plugin>([
      [
        "p1",
        fakePlugin("p1", {
          hooks: { PostToolUse: [{ command: "notify" }] },
          mcpServers: { added: { command: "node" } },
        }),
      ],
    ]);

    const merged = mergePluginConfig(config, plugins);

 // Original references should be untouched
    expect(originalHooks.PreToolUse).toHaveLength(1);
    expect(originalHooks).not.toHaveProperty("PostToolUse");
    expect(originalMcp).not.toHaveProperty("added");
 // Merged should be a different object
    expect(merged).not.toBe(config);
    expect(merged.hooks).not.toBe(originalHooks);
    expect(merged.mcpServers).not.toBe(originalMcp);
  });

  it("returns config unchanged when plugins have no hooks or mcpServers", () => {
    const config = { hooks: { PreToolUse: [] }, other: "value" };
    const plugins = new Map<string, Plugin>([["p1", fakePlugin("p1")]]);

    const merged = mergePluginConfig(config, plugins);
    expect(merged).toEqual(config);
  });

  it("merges from multiple plugins cumulatively", () => {
    const config = {};
    const plugins = new Map<string, Plugin>([
      [
        "p1",
        fakePlugin("p1", {
          hooks: { PreToolUse: [{ command: "a" }] },
        }),
      ],
      [
        "p2",
        fakePlugin("p2", {
          hooks: { PreToolUse: [{ command: "b" }] },
        }),
      ],
    ]);

    const merged = mergePluginConfig(config, plugins);
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// installPlugin
// ---------------------------------------------------------------------------

describe("installPlugin", () => {
  let base: string;
  let installRoot: string;
  let srcDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "plugins-install-"));
    installRoot = join(base, "installed");
    srcDir = join(base, "source-plugin");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "plugin.json"),
      JSON.stringify(makeManifest({ name: "source-plugin" })),
      "utf-8"
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("installs from a local directory", async () => {
    const target = await installPlugin(srcDir, { installDir: installRoot });

    expect(target).toBe(installRoot);
    expect(existsSync(join(target, "plugin.json"))).toBe(true);

    const manifest = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(join(target, "plugin.json"), "utf-8")
      )
    );
    expect(manifest.name).toBe("source-plugin");
  });

  it("throws when the plugin is already installed (without force)", async () => {
    await installPlugin(srcDir, { installDir: installRoot });

    await expect(installPlugin(srcDir, { installDir: installRoot })).rejects.toThrow(
      /already installed/
    );
  });

  it("force overwrites an existing installation", async () => {
    await installPlugin(srcDir, { installDir: installRoot });

 // Modify the source manifest
    writeFileSync(
      join(srcDir, "plugin.json"),
      JSON.stringify(makeManifest({ name: "source-plugin", version: "2.0.0" })),
      "utf-8"
    );

    const target = await installPlugin(srcDir, { installDir: installRoot, force: true });
    expect(existsSync(target)).toBe(true);

    const manifest = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(join(target, "plugin.json"), "utf-8")
      )
    );
    expect(manifest.version).toBe("2.0.0");
  });

  it("throws when source has no plugin.json", async () => {
    const emptySrc = join(base, "empty-src");
    mkdirSync(emptySrc, { recursive: true });

    await expect(
      installPlugin(emptySrc, { installDir: join(base, "target") })
    ).rejects.toThrow(/no plugin\.json/);
  });

  it("throws when source directory does not exist", async () => {
    await expect(
      installPlugin(join(base, "nonexistent"), { installDir: join(base, "target") })
    ).rejects.toThrow(/source not found/);
  });

  it("cleans up target directory when manifest is missing", async () => {
    const emptySrc = join(base, "empty-src");
    mkdirSync(emptySrc, { recursive: true });
    const target = join(base, "target");

    await expect(installPlugin(emptySrc, { installDir: target })).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it("installs a plugin from a monorepo sub-directory via a #subdir fragment", async () => {
    // A single repo/dir hosting many plugins. The source root has no
    // plugin.json; the real plugin lives under <root>/<subdir>.
    const mono = join(base, "mono-repo");
    const sub = join(mono, "code-review");
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, "plugin.json"),
      JSON.stringify(makeManifest({ name: "code-review" })),
      "utf-8",
    );

    const target = await installPlugin(`${mono}#code-review`, { installDir: installRoot });
    expect(existsSync(join(target, "plugin.json"))).toBe(true);
    const manifest = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(join(target, "plugin.json"), "utf-8"),
      ),
    );
    expect(manifest.name).toBe("code-review");
  });

  it("throws when the #subdir fragment points at a missing sub-directory", async () => {
    const mono = join(base, "mono-repo2");
    mkdirSync(mono, { recursive: true });
    await expect(
      installPlugin(`${mono}#does-not-exist`, { installDir: join(base, "t2") }),
    ).rejects.toThrow(/source not found|sub-directory not found/);
  });
});

// ---------------------------------------------------------------------------
// describePluginCapabilities — the pre-install side-effect report
// ---------------------------------------------------------------------------

describe("describePluginCapabilities", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "plugins-cap-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("flags a skills-only plugin as side-effect-free", async () => {
    const dir = writePlugin(base, "skilly", { name: "skilly", description: "s" }, ["skills/greet"]);
    const report = await describePluginCapabilities(makeManifest({ name: "skilly" }), dir);
    expect(report.sideEffectFree).toBe(true);
    expect(report.resources.skills).toBe(1);
    expect(report.summary).toMatch(/no side effects/i);
  });

  it("reports hooks, mcp servers, and runtime from the manifest", async () => {
    const manifest = makeManifest({
      name: "heavy",
      hooks: { PreToolUse: [{ matcher: "bash" }] } as never,
      mcpServers: { fetchy: {} } as never,
      runtime: { module: "./runtime.mjs" },
    });
    const report = await describePluginCapabilities(manifest);
    expect(report.hooks).toContain("PreToolUse");
    expect(report.mcpServers).toContain("fetchy");
    expect(report.hasRuntime).toBe(true);
    expect(report.sideEffectFree).toBe(false);
  });

  it("surfaces advisory side-effect tags (network/fileWrite/bash)", async () => {
    const report = await describePluginCapabilities(
      makeManifest({ name: "sfx", permissions: ["bash", "network"] }),
    );
    expect(report.sideEffects).toEqual(expect.arrayContaining(["bash", "network"]));
    expect(report.sideEffectFree).toBe(false);
  });

  it("statically scans the runtime module for registered tool names", async () => {
    const dir = writePlugin(
      base,
      "tooler",
      { name: "tooler", description: "t", permissions: ["runtime", "tools"], runtime: { module: "./runtime.mjs" } },
    );
    writeFileSync(
      join(dir, "runtime.mjs"),
      `export default { name: "x", create(deps) {
         deps.toolkit.registerTool({ name: "reverse_text", description: "", parameters: {}, async execute() { return { content: "" }; } });
         deps.toolkit.registerTool({ name: "shout", description: "", parameters: {}, async execute() { return { content: "" }; } });
         return { name: "x", prompt: (i, d) => deps.toolkit.runDefault(i, d), cancel(){}, state: () => "idle" };
       } };`,
      "utf-8",
    );
    const report = await describePluginCapabilities(
      makeManifest({ name: "tooler", permissions: ["runtime", "tools"], runtime: { module: "./runtime.mjs" } }),
      dir,
    );
    expect(report.tools).toEqual(expect.arrayContaining(["reverse_text", "shout"]));
    expect(report.toolsPartial).toBe(false);
    expect(report.summary).toMatch(/reverse_text/);
  });

  it("marks tools partial when it declares `tools` but no names could be scanned", async () => {
    // Declares the tools permission but ships no readable runtime module.
    const report = await describePluginCapabilities(
      makeManifest({ name: "dyn", permissions: ["runtime", "tools"], runtime: { module: "./missing.mjs" } }),
    );
    expect(report.tools).toEqual([]);
    expect(report.toolsPartial).toBe(true);
    expect(report.summary).toMatch(/custom tools/i);
  });
});

// ---------------------------------------------------------------------------
// inspectPluginSource — download, report, discard (no install)
// ---------------------------------------------------------------------------

describe("inspectPluginSource", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "plugins-inspect-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("reports a local source's capabilities without installing it", async () => {
    const src = join(base, "src");
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(
      join(src, "plugin.json"),
      JSON.stringify(makeManifest({ name: "inspect-me", description: "d" })),
      "utf-8",
    );
    const report = await inspectPluginSource(src);
    expect(report.name).toBe("inspect-me");
    expect(report.resources.skills).toBe(1);
    expect(report.sideEffectFree).toBe(true);
    // Nothing was installed anywhere under the user plugins dir.
    expect(existsSync(join(base, "installed"))).toBe(false);
  });

  it("scans a local source's runtime module for tools, source untouched", async () => {
    const src = join(base, "src2");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "plugin.json"),
      JSON.stringify(
        makeManifest({ name: "t2", permissions: ["runtime", "tools"], runtime: { module: "./runtime.mjs" } }),
      ),
      "utf-8",
    );
    writeFileSync(
      join(src, "runtime.mjs"),
      `export default { create(deps) { deps.toolkit.registerTool({ name: "do_thing", description:"", parameters:{}, async execute(){return {content:""};} }); return {}; } };`,
      "utf-8",
    );
    const report = await inspectPluginSource(src);
    expect(report.tools).toContain("do_thing");
    // The source dir is left exactly as-is (inspect copies to temp, discards).
    expect(existsSync(join(src, "runtime.mjs"))).toBe(true);
  });

  it("throws on a source with no valid plugin.json", async () => {
    const empty = join(base, "empty");
    mkdirSync(empty, { recursive: true });
    await expect(inspectPluginSource(empty)).rejects.toThrow(/no plugin\.json/);
  });
});

// ---------------------------------------------------------------------------
// uninstallPlugin
// ---------------------------------------------------------------------------

describe("uninstallPlugin", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "plugins-home-"));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("removes an installed plugin and returns true", async () => {
    const pluginDir = join(fakeHome, ".codepilot", "plugins", "to-remove");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify(makeManifest({ name: "to-remove" })),
      "utf-8"
    );

    const result = await uninstallPlugin("to-remove");
    expect(result).toBe(true);
    expect(existsSync(pluginDir)).toBe(false);
  });

  it("returns false for a non-existent plugin", async () => {
    const result = await uninstallPlugin("does-not-exist");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// searchMarketplace
// ---------------------------------------------------------------------------

describe("searchMarketplace", () => {
  const index: MarketplaceEntry[] = [
    {
      name: "code-review",
      description: "Automated code review with AI",
      source: "https://github.com/user/code-review",
      tags: ["review", "quality"],
    },
    {
      name: "git-helper",
      description: "Git workflow automation",
      source: "https://github.com/user/git-helper",
      tags: ["git", "workflow"],
    },
    {
      name: "Deploy Bot",
      description: "Deployment automation",
      source: "https://github.com/user/deploy-bot",
      tags: ["deploy", "ci"],
    },
  ];

  it("matches by name", () => {
    const results = searchMarketplace(index, "code-review");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("code-review");
  });

  it("matches by description", () => {
    const results = searchMarketplace(index, "workflow");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("git-helper");
  });

  it("matches by tags", () => {
    const results = searchMarketplace(index, "deploy");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Deploy Bot");
  });

  it("is case-insensitive", () => {
    expect(searchMarketplace(index, "CODE-REVIEW")).toHaveLength(1);
    expect(searchMarketplace(index, "deploy")).toHaveLength(1);
    expect(searchMarketplace(index, "DEPLOY")).toHaveLength(1);
    expect(searchMarketplace(index, "Git")).toHaveLength(1);
  });

  it("returns empty array when nothing matches", () => {
    expect(searchMarketplace(index, "unicorn")).toEqual([]);
  });

  it("matches multiple entries", () => {
    const results = searchMarketplace(index, "automation");
    expect(results).toHaveLength(2);
  });

  it("handles entries with no tags", () => {
    const noTags: MarketplaceEntry[] = [
      { name: "simple", description: "A simple plugin", source: "https://example.com" },
    ];
    expect(searchMarketplace(noTags, "simple")).toHaveLength(1);
    expect(searchMarketplace(noTags, "nope")).toEqual([]);
  });

  it("empty query matches everything", () => {
    const results = searchMarketplace(index, "");
    expect(results).toHaveLength(index.length);
  });
});

// ---------------------------------------------------------------------------
// listPluginMarket — the GitHub-hosted discovery entry point (bundled seed)
// ---------------------------------------------------------------------------

describe("listPluginMarket", () => {
  beforeEach(() => resetCatalogMemoryForTests());
  afterEach(() => resetCatalogMemoryForTests());

  it("lists installable plugins from the bundled catalog (offline-safe)", async () => {
    // No network in test → daily fetch fails → falls back to the bundled
    // catalog/plugins.json shipped with @codepilot/core.
    const list = await listPluginMarket();
    expect(list.length).toBeGreaterThan(0);
    // Every entry must carry the fields install + a browse UI need.
    for (const e of list) {
      expect(typeof e.name).toBe("string");
      expect(e.name.length).toBeGreaterThan(0);
      expect(typeof e.source).toBe("string");
      expect(e.source.length).toBeGreaterThan(0);
    }
    // The shipped reference plugins are discoverable by name.
    expect(list.some((e) => e.name === "code-review")).toBe(true);
    expect(list.some((e) => e.name === "test-gen")).toBe(true);
  });

  it("feeds searchMarketplace so a browse flow can filter", async () => {
    const list = await listPluginMarket();
    const hits = searchMarketplace(list, "security");
    expect(hits.some((e) => e.name === "security-audit")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchMarketplaceIndex — custom third-party index source (add-your-own URL)
// ---------------------------------------------------------------------------

describe("fetchMarketplaceIndex", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(status: number, body: unknown): void {
    globalThis.fetch = (async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "ERR",
        json: async () => body,
      }) as unknown as Response) as typeof fetch;
  }

  it("accepts a bare array of entries", async () => {
    mockFetch(200, [
      { name: "a", description: "d", source: "https://github.com/x/a" },
      { name: "b", description: "d", source: "https://github.com/x/b" },
    ]);
    const list = await fetchMarketplaceIndex("https://example.com/index.json");
    expect(list.map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("accepts a { plugins: [...] } document (same shape as the catalog)", async () => {
    mockFetch(200, { version: 1, plugins: [{ name: "c", source: "https://github.com/x/c" }] });
    const list = await fetchMarketplaceIndex("https://example.com/index.json");
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("c");
    expect(list[0]!.description).toBe("");
  });

  it("drops malformed rows instead of poisoning the whole list", async () => {
    mockFetch(200, [
      { name: "good", source: "https://github.com/x/good" },
      { description: "no name or source" },
      { name: "no-source" },
      42,
    ]);
    const list = await fetchMarketplaceIndex("https://example.com/index.json");
    expect(list.map((e) => e.name)).toEqual(["good"]);
  });

  it("throws on a non-2xx response", async () => {
    mockFetch(404, {});
    await expect(fetchMarketplaceIndex("https://example.com/missing.json")).rejects.toThrow(
      /fetch failed: 404/,
    );
  });

  it("throws when the index is neither an array nor { plugins }", async () => {
    mockFetch(200, { nope: true });
    await expect(fetchMarketplaceIndex("https://example.com/weird.json")).rejects.toThrow(
      /not an array or/,
    );
  });
});

// ---------------------------------------------------------------------------
// describeMarketplaceEntry — the install-source confirmation line
// ---------------------------------------------------------------------------

describe("describeMarketplaceEntry", () => {
  it("surfaces the git source for a confirmation prompt", () => {
    const line = describeMarketplaceEntry({
      name: "code-review",
      description: "d",
      source: "https://github.com/codepilot/plugins",
      version: "1.0.0",
      author: "CodePilot",
    });
    expect(line).toContain("code-review");
    expect(line).toContain("v1.0.0");
    expect(line).toContain("by CodePilot");
    expect(line).toContain("git:");
    expect(line).toContain("https://github.com/codepilot/plugins");
  });

  it("labels a local-path source", () => {
    const line = describeMarketplaceEntry({
      name: "local",
      description: "d",
      source: "/home/me/my-plugin",
    });
    expect(line).toContain("local path:");
    expect(line).toContain("/home/me/my-plugin");
  });
});

// ---------------------------------------------------------------------------
// derivePluginName
// ---------------------------------------------------------------------------

describe("derivePluginName", () => {
  it("extracts name from a plain local path", () => {
    expect(derivePluginName("/home/user/my-plugin")).toBe("my-plugin");
  });

  it("extracts name from a path with a trailing slash", () => {
    expect(derivePluginName("/home/user/my-plugin/")).toBe("my-plugin");
  });

  it("extracts name from an HTTPS git URL", () => {
    expect(derivePluginName("https://github.com/user/my-plugin")).toBe("my-plugin");
  });

  it("strips .git suffix from HTTPS URLs", () => {
    expect(derivePluginName("https://github.com/user/my-plugin.git")).toBe("my-plugin");
  });

  it("extracts name from an SSH git URL", () => {
    expect(derivePluginName("git@github.com:user/my-plugin")).toBe("my-plugin");
  });

  it("strips .git suffix from SSH URLs", () => {
    expect(derivePluginName("git@github.com:user/my-plugin.git")).toBe("my-plugin");
  });

  it("extracts name from a relative path", () => {
    expect(derivePluginName("./plugins/cool-tool")).toBe("cool-tool");
  });

  it("handles deep paths", () => {
    expect(derivePluginName("/very/deeply/nested/path/to/awesome-plugin")).toBe(
      "awesome-plugin"
    );
  });

  it("returns last segment for a bare name", () => {
    expect(derivePluginName("just-a-name")).toBe("just-a-name");
  });

  it("names the plugin after the #subdir fragment on a git URL", () => {
    expect(
      derivePluginName("https://github.com/dtssv/codepilot-plugins.git#code-review"),
    ).toBe("code-review");
  });

  it("uses the last segment of a nested #subdir fragment", () => {
    expect(
      derivePluginName("https://github.com/acme/repo.git#plugins/test-gen"),
    ).toBe("test-gen");
  });

  it("falls back to the repo name when the fragment is empty", () => {
    expect(derivePluginName("https://github.com/acme/my-plugin.git#")).toBe("my-plugin");
  });
});

// ---------------------------------------------------------------------------
// Plugin permissions
// ---------------------------------------------------------------------------

describe("plugin permissions", () => {
  function fakePlugin(name: string, overrides: Partial<PluginManifest> = {}): Plugin {
    return {
      manifest: makeManifest({ name, ...overrides }),
      path: `/tmp/${name}`,
      source: "project",
      paths: { skills: `/tmp/${name}/skills`, agents: `/tmp/${name}/agents`, commands: `/tmp/${name}/commands` },
    };
  }

  describe("pluginPermissionReport", () => {
    it("reports no enforcement / no violations when the field is absent (legacy)", () => {
      const r = pluginPermissionReport(fakePlugin("legacy", { hooks: { PreToolUse: [{ x: 1 }] } }));
      expect(r.enforced).toBe(false);
      expect(r.used).toEqual(["hooks"]);
      expect(r.violations).toEqual([]);
    });

    it("flags a used-but-undeclared capability as a violation when enforced", () => {
      const r = pluginPermissionReport(
        fakePlugin("p", { permissions: ["mcp"], hooks: { PreToolUse: [{ x: 1 }] } }),
      );
      expect(r.enforced).toBe(true);
      expect(r.declared).toEqual(["mcp"]);
      expect(r.used).toEqual(["hooks"]);
      expect(r.violations).toEqual(["hooks"]);
    });

    it("has no violations when every used capability is declared", () => {
      const r = pluginPermissionReport(
        fakePlugin("p", { permissions: ["hooks", "mcp"], hooks: { PreToolUse: [{ x: 1 }] }, mcpServers: { s: {} } }),
      );
      expect(r.violations).toEqual([]);
    });
  });

  describe("mergePluginConfig enforcement", () => {
    it("merges hooks for a legacy plugin (no permissions field)", () => {
      const plugins = new Map<string, Plugin>([["p", fakePlugin("p", { hooks: { PreToolUse: [{ a: 1 }] } })]]);
      const warnings: string[] = [];
      const merged = mergePluginConfig({}, plugins, (m) => warnings.push(m));
      expect((merged.hooks as Record<string, unknown[]>).PreToolUse).toHaveLength(1);
      expect(warnings).toHaveLength(0);
    });

    it("skips undeclared hooks and warns when the plugin opts into enforcement", () => {
      const plugins = new Map<string, Plugin>([
        ["p", fakePlugin("p", { permissions: ["network"], hooks: { PreToolUse: [{ a: 1 }] } })],
      ]);
      const warnings: string[] = [];
      const merged = mergePluginConfig({}, plugins, (m) => warnings.push(m));
      expect(merged.hooks).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/did not declare the "hooks" permission/);
    });

    it("merges declared hooks and skips undeclared mcp servers", () => {
      const plugins = new Map<string, Plugin>([
        ["p", fakePlugin("p", { permissions: ["hooks"], hooks: { PreToolUse: [{ a: 1 }] }, mcpServers: { srv: { command: "x" } } })],
      ]);
      const warnings: string[] = [];
      const merged = mergePluginConfig({}, plugins, (m) => warnings.push(m));
      expect((merged.hooks as Record<string, unknown[]>).PreToolUse).toHaveLength(1);
      expect(merged.mcpServers).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/MCP servers.*"mcp" permission/);
    });

    it("drops an undeclared runtime default so it cannot be selected", () => {
      const plugins = new Map<string, Plugin>([
        ["p", fakePlugin("p", { permissions: [], runtime: { module: "r.mjs", name: "rt", default: true } })],
      ]);
      const warnings: string[] = [];
      const merged = mergePluginConfig({}, plugins, (m) => warnings.push(m));
      expect(merged.runtime).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/did not declare the "runtime" permission/);
    });

    it("keeps a declared runtime default", () => {
      const plugins = new Map<string, Plugin>([
        ["p", fakePlugin("p", { permissions: ["runtime"], runtime: { module: "r.mjs", name: "rt", default: true } })],
      ]);
      const merged = mergePluginConfig({}, plugins);
      expect(merged.runtime).toBe("rt");
    });
  });
});
