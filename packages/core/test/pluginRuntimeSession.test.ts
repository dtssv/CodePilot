// Plugin runtimes, end to end (ROADMAP-NEXT §4.1 Phase 2):
// manifest on disk → module import → registry → the session actually using it.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";

import { initPluginRuntimes } from "../src/plugins.js";
import { discoverPlugins, loadPluginRuntimes } from "../src/plugins.js";
import { RuntimeRegistry, createRuntimeToolkit, runtimeRegistry } from "../src/runtime.js";
import { createSession } from "../src/session-utils.js";
import { ToolRegistry } from "../src/tools/types.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { PermissionEngine } from "../src/permissions.js";
import type { AgentDeps } from "../src/agent.js";
import type { Event } from "../src/types.js";
import type {
  ChatProvider,
  StreamChatOptions,
  StreamEvent,
} from "../src/providers/types.js";

/** Absolute path to the repo's shipped `plugins/` directory. */
const REPO_PLUGINS = fileURLToPath(new URL("../../../plugins", import.meta.url));

const DEMO_MODULE = `
export default {
  name: "demo-runtime",
  create(deps) {
    return {
      name: "demo-runtime",
      async prompt() {
        return { events: [], hadToolCalls: false, finalText: "from-plugin" };
      },
      cancel() {},
      state() { return "idle"; },
    };
  },
};
`;

let base: string;

function writePlugin(
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): void {
  const dir = join(base, ".codepilot", "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest), "utf-8");
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content, "utf-8");
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "codepilot-plug-sess-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  for (const name of ["demo-runtime", "primer", "broken-runtime"]) {
    runtimeRegistry.unregister(name);
  }
});

describe("initPluginRuntimes", () => {
  it("registers declared runtimes and reports the plugin default", async () => {
    writePlugin(
      "demo",
      {
        name: "demo",
        description: "d",
        version: "1.0.0",
        runtime: { module: "./runtime.mjs", default: true },
      },
      { "runtime.mjs": DEMO_MODULE },
    );
    const reg = new RuntimeRegistry();
    const init = await initPluginRuntimes(base, { registry: reg, userDir: join(base, "none") });
    expect(init.registered.get("demo")).toBe("demo-runtime");
    expect(init.errors.size).toBe(0);
    expect(init.defaultRuntime).toBe("demo-runtime");
    expect(reg.has("demo-runtime")).toBe(true);
  });

  it("does not make a plugin the default when its module failed to load", async () => {
    // Otherwise a broken plugin would turn a load warning into a hard
    // failure on the next prompt ("Unknown agent runtime").
    writePlugin("broken", {
      name: "broken",
      description: "d",
      version: "1.0.0",
      runtime: { module: "./missing.mjs", name: "broken-runtime", default: true },
    });
    const reg = new RuntimeRegistry();
    const init = await initPluginRuntimes(base, { registry: reg, userDir: join(base, "none") });
    expect(init.errors.get("broken")).toMatch(/not found/);
    expect(init.defaultRuntime).toBeUndefined();
    expect(reg.has("broken-runtime")).toBe(false);
  });

  it("flags a plugin default that contradicts explicit config", async () => {
    writePlugin(
      "demo",
      {
        name: "demo",
        description: "d",
        version: "1.0.0",
        runtime: { module: "./runtime.mjs", default: true },
      },
      { "runtime.mjs": DEMO_MODULE },
    );
    await expect(
      initPluginRuntimes(base, {
        registry: new RuntimeRegistry(),
        userDir: join(base, "none"),
        existingRuntime: "something-else",
      }),
    ).rejects.toThrow(/multiple plugins declare a default runtime/);
  });
});

describe("createSession + plugin runtimes", () => {
  it("resolves a runtime that only a plugin provides", async () => {
    writePlugin(
      "demo",
      {
        name: "demo",
        description: "d",
        version: "1.0.0",
        runtime: "./runtime.mjs",
      },
      { "runtime.mjs": DEMO_MODULE },
    );
    const session = await createSession({
      cwd: base,
      model: "mock-large",
      runtime: "demo-runtime",
    });
    expect(session.getRuntimeName()).toBe("demo-runtime");
    expect(session.getRuntime().name).toBe("demo-runtime");
  });

  it("adopts a plugin that declares itself the default runtime", async () => {
    writePlugin(
      "demo",
      {
        name: "demo",
        description: "d",
        version: "1.0.0",
        runtime: { module: "./runtime.mjs", default: true },
      },
      { "runtime.mjs": DEMO_MODULE },
    );
    const session = await createSession({ cwd: base, model: "mock-large" });
    expect(session.getRuntimeName()).toBe("demo-runtime");
  });

  it("lets an explicit runtime option beat the plugin default", async () => {
    writePlugin(
      "demo",
      {
        name: "demo",
        description: "d",
        version: "1.0.0",
        runtime: { module: "./runtime.mjs", default: true },
      },
      { "runtime.mjs": DEMO_MODULE },
    );
    const session = await createSession({
      cwd: base,
      model: "mock-large",
      runtime: "default",
    });
    expect(session.getRuntimeName()).toBe("default");
  });

  it("skips plugin discovery when pluginRuntimes is false", async () => {
    writePlugin(
      "demo",
      {
        name: "demo",
        description: "d",
        version: "1.0.0",
        runtime: { module: "./runtime.mjs", default: true },
      },
      { "runtime.mjs": DEMO_MODULE },
    );
    const session = await createSession({
      cwd: base,
      model: "mock-large",
      pluginRuntimes: false,
    });
    expect(session.getRuntimeName()).toBe("default");
  });

  it("survives a plugin whose runtime module is broken", async () => {
    writePlugin("broken", {
      name: "broken",
      description: "d",
      version: "1.0.0",
      runtime: { module: "./missing.mjs", name: "broken-runtime", default: true },
    });
    const session = await createSession({ cwd: base, model: "mock-large" });
    expect(session.getRuntimeName()).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// The shipped reference plugin
// ---------------------------------------------------------------------------

class MockProvider implements ChatProvider {
  readonly name = "mock";
  defaultModel = "mock-large";
  smallModel = "mock-small";
  calls: StreamChatOptions[] = [];
  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    yield { kind: "text_delta", messageId: "m1", text: "answered" };
    yield { kind: "done", finishReason: "stop" };
  }
}

describe("plugins/runtime-example", () => {
  it("loads from the repo plugins directory and primes the prompt via the toolkit", async () => {
    const plugins = await discoverPlugins(base, {
      projectDir: REPO_PLUGINS,
      userDir: join(base, "none"),
    });
    const reg = new RuntimeRegistry();
    const loaded = await loadPluginRuntimes(plugins, reg);
    expect(loaded.errors.size).toBe(0);
    expect(loaded.registered.get("runtime-example")).toBe("primer");

    const runtime = reg.resolve("primer", { cwd: base, toolkit: createRuntimeToolkit() });
    expect(runtime.name).toBe("primer");
    expect(runtime.state()).toBe("idle");

    // Give it an `ls` tool to prime with, then check the listing reached the
    // model and the delegated answer came back.
    const tools = new ToolRegistry();
    const lsCalls: unknown[] = [];
    tools.register({
      name: "ls",
      description: "list",
      inputSchema: z.object({ path: z.string() }),
      permission: "read" as const,
      async execute(input: { path: string }) {
        lsCalls.push(input);
        return { content: "src/\npackage.json" };
      },
    });
    const provider = new MockProvider();
    const emitted: Event[] = [];
    const deps: AgentDeps = {
      provider,
      tools,
      artifacts: new ArtifactStore(join(base, ".codepilot", "artifacts")),
      permissions: new PermissionEngine({ permissionMode: "yolo" }),
      config: { model: "mock-large" } as never,
      cwd: base,
      onEvent: (e) => void emitted.push(e),
      systemPrompt: { staticPrefix: "STATIC", dynamicSuffix: "", full: "STATIC" },
    };

    const result = await runtime.prompt({ history: [], userText: "what is here?" }, deps);

    expect(lsCalls).toEqual([{ path: "." }]);
    expect(result.finalText).toBe("answered");
    // Listing arrives as runtime context on the user message; the cacheable
    // static prefix is untouched.
    expect(provider.calls[0]?.systemPrompt).toBe("STATIC");
    expect(JSON.stringify(provider.calls[0]?.messages)).toMatch(/workspace_listing/);
    expect(emitted.length).toBeGreaterThan(0);
  });
});
