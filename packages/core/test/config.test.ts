import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  loadConfigWithSources,
  mergeConfig,
  validateConfig,
  interpolateEnv,
  useProvider,
  resolveModelAlias,
  DEFAULT_CONFIG,
} from "../src/config.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("mergeConfig (legacy compat)", () => {
  it("handles empty inputs", () => {
    expect(mergeConfig(undefined, undefined)).toEqual({});
  });
  it("applies override fields", () => {
    const r = mergeConfig(
      { provider: "openai", model: "x" },
      { model: "y", permissionMode: "yolo" }
    );
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("y");
    expect(r.permissionMode).toBe("yolo");
  });
  it("concatenates autoApprove", () => {
    const r = mergeConfig({ autoApprove: ["a"] }, { autoApprove: ["b"] });
    expect(r.autoApprove).toEqual(["a", "b"]);
  });
  it("merges mcpServers", () => {
    const r = mergeConfig(
      { mcpServers: { s1: { command: "x" } } },
      { mcpServers: { s2: { command: "y" } } }
    );
    expect(Object.keys(r.mcpServers!)).toEqual(["s1", "s2"]);
  });
});

describe("loadConfig (legacy compat)", () => {
  it("reads .codepilot/config.json from cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    mkdirSync(join(dir, ".codepilot"), { recursive: true });
    writeFileSync(
      join(dir, ".codepilot/config.json"),
      JSON.stringify({ provider: "openai", model: "z" }),
      "utf-8"
    );
    const cfg = await loadConfig(dir);
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("z");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a valid config when no files exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const cfg = await loadConfig(dir);
    expect(cfg.permissionMode).toBe("ask");
    expect(cfg.agentMode).toBe("agent");
    expect(cfg.contextWindow).toBe(120_000);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("interpolateEnv", () => {
  it("expands ${ENV}", () => {
    process.env.TEST_FOO_BAR = "secret";
    expect(interpolateEnv({ apiKey: "${TEST_FOO_BAR}" })).toEqual({
      apiKey: "secret",
    });
    delete process.env.TEST_FOO_BAR;
  });

  it("expands ${ENV:-default}", () => {
    delete process.env.TEST_FOO_DEFAULT;
    expect(interpolateEnv({ baseURL: "${TEST_FOO_DEFAULT:-https://x.test/v1}" })).toEqual({
      baseURL: "https://x.test/v1",
    });
  });

  it("prefers env over default when both are set", () => {
    process.env.TEST_FOO_PREF = "real";
    expect(
      interpolateEnv({ baseURL: "${TEST_FOO_PREF:-fallback}" })
    ).toEqual({ baseURL: "real" });
    delete process.env.TEST_FOO_PREF;
  });

  it("walks nested objects and arrays", () => {
    process.env.TEST_NESTED = "n";
    const out = interpolateEnv({
      autoApprove: ["${TEST_NESTED}"],
      mcpServers: { s: { command: "${TEST_NESTED}" } },
    });
    expect(out).toEqual({
      autoApprove: ["n"],
      mcpServers: { s: { command: "n" } },
    });
    delete process.env.TEST_NESTED;
  });

  it("leaves non-strings alone", () => {
    expect(interpolateEnv({ maxTokens: 1234, enabled: true, x: null })).toEqual({
      maxTokens: 1234,
      enabled: true,
      x: null,
    });
  });
});

describe("validateConfig", () => {
  it("accepts a minimal valid config", () => {
    const r = validateConfig({ provider: "openai" });
    expect(r.provider).toBe("openai");
  });

  it("rejects unknown top-level keys with a readable path", () => {
    let err: Error | undefined;
    try {
      validateConfig({ unknownKey: 1 });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/Invalid CodePilot config/);
    expect(err!.message).toMatch(/unknownKey/);
  });

  it("rejects bad permissionMode values with field path", () => {
    let err: Error | undefined;
    try {
      validateConfig({ permissionMode: "lol" });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/permissionMode/);
  });

  it("rejects non-URL baseURL", () => {
    expect(() => validateConfig({ baseURL: "not-a-url" })).toThrow(
      /baseURL/
    );
  });

  it("rejects negative maxTokens", () => {
    expect(() => validateConfig({ maxTokens: -1 })).toThrow(/maxTokens/);
  });

  it("rejects malformed mcpServers", () => {
    expect(() =>
      validateConfig({ mcpServers: { bad: { args: ["x"] } } })
    ).toThrow(/mcpServers\.bad\.command/);
  });
});

describe("loadConfigWithSources layered merge", () => {
  it("applies defaults < env < caller when no files exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-merge-"));
    process.env.CODEPILOT_MODEL = "from-env";
    process.env.CODEPILOT_API_KEY = "env-key";
    try {
      const result = await loadConfigWithSources(dir, {
        provider: "openai",
        model: "from-caller",
      });
      const names = result.sources.map((s) => s.name);
      // user/repo are skipped when their files are absent.
      expect(names).toEqual(["defaults", "env", "caller"]);
      // provider from caller
      expect(result.config.provider).toBe("openai");
      // model from caller (overrides env)
      expect(result.config.model).toBe("from-caller");
      // apiKey from env (caller didn't set)
      expect(result.config.apiKey).toBe("env-key");
      // permissionMode from defaults
      expect(result.config.permissionMode).toBe("ask");
    } finally {
      delete process.env.CODEPILOT_MODEL;
      delete process.env.CODEPILOT_API_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes the repo layer when .codepilot/config.json exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-merge-"));
    mkdirSync(join(dir, ".codepilot"), { recursive: true });
    writeFileSync(
      join(dir, ".codepilot/config.json"),
      JSON.stringify({ model: "from-repo" }),
      "utf-8"
    );
    try {
      const result = await loadConfigWithSources(dir);
      const names = result.sources.map((s) => s.name);
      expect(names).toContain("repo");
      expect(result.config.model).toBe("from-repo");
      const repoLayer = result.sources.find((s) => s.name === "repo");
      expect(repoLayer!.source).toBe(join(dir, ".codepilot/config.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads user-level config when HOME points at a temp dir", async () => {
    // setup.ts redirected HOME to a temp dir at module load. We can't
    // easily change HOME mid-test, so we exercise the loader with a
    // freshly-created user file under that HOME.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const userPath = path.join(process.env.HOME!, ".codepilot", "config.json");
    await fs.mkdir(path.dirname(userPath), { recursive: true });
    const original = await fs
      .readFile(userPath, "utf-8")
      .catch(() => undefined as string | undefined);
    await fs.writeFile(
      userPath,
      JSON.stringify({ permissionMode: "auto-edit" }),
      "utf-8"
    );
    const dir = mkdtempSync(join(tmpdir(), "cfg-user-"));
    try {
      const result = await loadConfigWithSources(dir);
      expect(result.config.permissionMode).toBe("auto-edit");
      const userLayer = result.sources.find((s) => s.name === "user");
      expect(userLayer).toBeDefined();
      expect(userLayer!.source).toBe(userPath);
    } finally {
      if (original !== undefined) {
        await fs.writeFile(userPath, original, "utf-8");
      } else {
        await fs.rm(userPath, { force: true });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env interpolation happens before validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-interp-"));
    mkdirSync(join(dir, ".codepilot"), { recursive: true });
    writeFileSync(
      join(dir, ".codepilot/config.json"),
      JSON.stringify({ apiKey: "${TEST_INTERP_KEY:-fallback-key}" }),
      "utf-8"
    );
    delete process.env.TEST_INTERP_KEY;
    try {
      const cfg = await loadConfig(dir);
      expect(cfg.apiKey).toBe("fallback-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("useProvider", () => {
  it("switches to a named preset", () => {
    const cfg = {
      providers: {
        work: { provider: "openai" as const, baseURL: "https://x.test", apiKey: "k", model: "gpt-x" },
        home: { provider: "anthropic" as const, model: "claude-x" },
      },
    } as const;
    const r = useProvider(cfg as any, "work");
    expect(r.provider).toBe("openai");
    expect(r.baseURL).toBe("https://x.test");
    expect(r.apiKey).toBe("k");
    expect(r.model).toBe("gpt-x");
  });
  it("throws on unknown preset", () => {
    expect(() => useProvider({} as any, "ghost")).toThrow(/Unknown provider preset/);
  });
});

describe("resolveModelAlias", () => {
  it("resolves an alias to its target", () => {
    const cfg = { model: "fast", models: { aliases: { fast: "gpt-5-mini" } } } as any;
    expect(resolveModelAlias(cfg)).toBe("gpt-5-mini");
  });
  it("returns the value as-is when no alias matches", () => {
    const cfg = { model: "claude-x" } as any;
    expect(resolveModelAlias(cfg)).toBe("claude-x");
  });
  it("returns undefined when no model is set", () => {
    expect(resolveModelAlias({} as any)).toBeUndefined();
  });
});

describe("DEFAULT_CONFIG", () => {
  it("exposes a frozen, sensible default", () => {
    expect(DEFAULT_CONFIG.permissionMode).toBe("ask");
    expect(DEFAULT_CONFIG.agentMode).toBe("agent");
    expect(DEFAULT_CONFIG.contextWindow).toBe(120_000);
  });
});
