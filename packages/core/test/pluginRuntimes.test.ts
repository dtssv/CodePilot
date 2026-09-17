import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverPlugins,
  mergePluginConfig,
  loadPluginRuntimes,
} from "../src/plugins.js";
import { RuntimeRegistry, type AgentRuntime } from "../src/runtime.js";

let base: string;
let projPlugins: string;
let userPlugins: string;

function writePlugin(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {}
) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest), "utf-8");
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content, "utf-8");
  }
  return dir;
}

const FACTORY_MODULE = `
export default {
  name: "demo-runtime",
  create(deps) {
    return {
      name: "demo-runtime",
      async prompt() { return { events: [], hadToolCalls: false, finalText: "rt:" + deps.cwd }; },
      cancel() {},
      state() { return "idle"; },
    };
  },
};
`;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "codepilot-plug-rt-"));
  projPlugins = join(base, ".codepilot", "plugins");
  userPlugins = join(base, ".codepilot-user", "plugins");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("loadPluginRuntimes", () => {
  it("loads and registers a factory from a plugin module", async () => {
    writePlugin(projPlugins, "myplugin", {
      name: "myplugin",
      description: "d",
      version: "1.0.0",
      runtime: "./runtime.mjs",
    }, { "runtime.mjs": FACTORY_MODULE });

    const plugins = await discoverPlugins(base, {
      projectDir: projPlugins,
      userDir: userPlugins,
    });
    const reg = new RuntimeRegistry();
    const result = await loadPluginRuntimes(plugins, reg);
    expect(result.errors.size).toBe(0);
    expect(result.registered.get("myplugin")).toBe("demo-runtime");
    expect(reg.has("demo-runtime")).toBe(true);

    const rt = reg.resolve("demo-runtime", { cwd: "/tmp/x" });
    expect(rt.name).toBe("demo-runtime");
    const out = await rt.prompt({ history: [], userText: "hi" }, {} as never);
    expect(out.finalText).toBe("rt:/tmp/x");
  });

  it("supports object form with name override", async () => {
    writePlugin(projPlugins, "p2", {
      name: "p2",
      description: "d",
      version: "1.0.0",
      runtime: { module: "./rt.mjs", name: "custom-name" },
    }, { "rt.mjs": FACTORY_MODULE });

    const plugins = await discoverPlugins(base, {
      projectDir: projPlugins,
      userDir: userPlugins,
    });
    const reg = new RuntimeRegistry();
    const result = await loadPluginRuntimes(plugins, reg);
    expect(result.registered.get("p2")).toBe("custom-name");
    expect(reg.has("custom-name")).toBe(true);
    // The factory's original name is NOT registered when overridden.
    expect(reg.has("demo-runtime")).toBe(false);
  });

  it("collects errors for missing modules without aborting others", async () => {
    writePlugin(projPlugins, "bad", {
      name: "bad",
      description: "d",
      version: "1.0.0",
      runtime: "./missing.mjs",
    });
    writePlugin(projPlugins, "good", {
      name: "good",
      description: "d",
      version: "1.0.0",
      runtime: "./runtime.mjs",
    }, { "runtime.mjs": FACTORY_MODULE });

    const plugins = await discoverPlugins(base, {
      projectDir: projPlugins,
      userDir: userPlugins,
    });
    const reg = new RuntimeRegistry();
    const result = await loadPluginRuntimes(plugins, reg);
    expect(result.errors.get("bad")).toMatch(/runtime module not found/);
    expect(result.registered.get("good")).toBe("demo-runtime");
  });

  it("rejects modules without a factory export", async () => {
    writePlugin(projPlugins, "nofac", {
      name: "nofac",
      description: "d",
      version: "1.0.0",
      runtime: "./rt.mjs",
    }, { "rt.mjs": "export const unrelated = 1;\n" });

    const plugins = await discoverPlugins(base, {
      projectDir: projPlugins,
      userDir: userPlugins,
    });
    const reg = new RuntimeRegistry();
    const result = await loadPluginRuntimes(plugins, reg);
    expect(result.errors.get("nofac")).toMatch(/RuntimeFactory/);
    expect(result.registered.size).toBe(0);
  });

  it("rejects factories without create()", async () => {
    writePlugin(projPlugins, "nocreate", {
      name: "nocreate",
      description: "d",
      version: "1.0.0",
      runtime: "./rt.mjs",
    }, { "rt.mjs": "export default { name: 'x' };\n" });

    const plugins = await discoverPlugins(base, {
      projectDir: projPlugins,
      userDir: userPlugins,
    });
    const reg = new RuntimeRegistry();
    const result = await loadPluginRuntimes(plugins, reg);
    expect(result.errors.get("nocreate")).toMatch(/create/);
  });

  it("accepts named factory exports", async () => {
    writePlugin(projPlugins, "named", {
      name: "named",
      description: "d",
      version: "1.0.0",
      runtime: "./rt.mjs",
    }, {
      "rt.mjs": `export const runtimeFactory = { name: "named-rt", create: () => ({
        name: "named-rt",
        async prompt() { return { events: [], hadToolCalls: false, finalText: "" }; },
        cancel() {},
        state() { return "idle"; },
      }) };\n`,
    });

    const plugins = await discoverPlugins(base, {
      projectDir: projPlugins,
      userDir: userPlugins,
    });
    const reg = new RuntimeRegistry();
    const result = await loadPluginRuntimes(plugins, reg);
    expect(result.errors.size).toBe(0);
    expect(result.registered.get("named")).toBe("named-rt");
  });
});

describe("mergePluginConfig runtime default", () => {
  it("sets config.runtime when a plugin declares default: true", async () => {
    writePlugin(projPlugins, "defrt", {
      name: "defrt",
      description: "d",
      version: "1.0.0",
      runtime: { module: "./rt.mjs", name: "def-rt", default: true },
    }, { "rt.mjs": FACTORY_MODULE });

    const plugins = await discoverPlugins(base, {
      projectDir: projPlugins,
      userDir: userPlugins,
    });
    const merged = mergePluginConfig({}, plugins) as { runtime?: string };
    expect(merged.runtime).toBe("def-rt");
  });

  it("leaves config.runtime untouched for non-default runtimes", async () => {
    writePlugin(projPlugins, "plain", {
      name: "plain",
      description: "d",
      version: "1.0.0",
      runtime: "./rt.mjs",
    }, { "rt.mjs": FACTORY_MODULE });

    const plugins = await discoverPlugins(base, {
      projectDir: projPlugins,
      userDir: userPlugins,
    });
    const merged = mergePluginConfig({}, plugins) as { runtime?: string };
    expect(merged.runtime).toBeUndefined();
  });

  it("throws when two plugins both declare a default runtime", async () => {
    writePlugin(projPlugins, "a", {
      name: "a", description: "d", version: "1.0.0",
      runtime: { module: "./rt.mjs", default: true },
    }, { "rt.mjs": FACTORY_MODULE });
    writePlugin(projPlugins, "b", {
      name: "b", description: "d", version: "1.0.0",
      runtime: { module: "./rt.mjs", default: true },
    }, { "rt.mjs": FACTORY_MODULE });

    const plugins = await discoverPlugins(base, {
      projectDir: projPlugins,
      userDir: userPlugins,
    });
    expect(() => mergePluginConfig({}, plugins)).toThrow(/multiple plugins/);
  });

  it("throws when config already sets runtime and a plugin defaults", async () => {
    writePlugin(projPlugins, "c", {
      name: "c", description: "d", version: "1.0.0",
      runtime: { module: "./rt.mjs", default: true },
    }, { "rt.mjs": FACTORY_MODULE });

    const plugins = await discoverPlugins(base, {
      projectDir: projPlugins,
      userDir: userPlugins,
    });
    expect(() => mergePluginConfig({ runtime: "other" }, plugins)).toThrow(/multiple plugins/);
  });
});
