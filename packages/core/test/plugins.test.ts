import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverPlugins,
  pluginResourcePaths,
  mergePluginConfig,
  installPlugin,
  uninstallPlugin,
  searchMarketplace,
  derivePluginName,
  type Plugin,
  type PluginManifest,
  type MarketplaceEntry,
} from "../src/plugins.js";

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
});
