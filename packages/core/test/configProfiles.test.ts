// Tests for the profile / bundle / patch config composition system (#28).
//
// Covers:
//   - profile merging (dev/test/prod style profiles)
//   - profile precedence over the base config
//   - --profile-equivalent selection via loadConfigWithSources options
//   - applyConfigPatch JSON merge-patch semantics (deep merge, replace, null-delete)
//   - patch application on top of the final resolved config
//   - bundle export/import roundtrip (config + commands + agents + skills)
//   - bundle validation (version, malformed resources, path traversal)

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  loadConfigWithSources,
  resolveProfile,
  applyConfigPatch,
  validateConfig,
  type ResolvedCodepilotConfig,
} from "../src/config.js";
import {
  exportBundle,
  importBundle,
  serializeBundle,
  parseBundle,
  BUNDLE_VERSION,
  type CodepilotBundle,
} from "../src/bundle.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "profiles-test-"));
}

// ---------------------------------------------------------------------------
// Profile merging
// ---------------------------------------------------------------------------

describe("resolveProfile", () => {
  const base: ResolvedCodepilotConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    permissionMode: "ask",
    maxTurns: 50,
    profiles: {
      dev: { model: "claude-haiku-4-5", permissionMode: "auto-edit" },
      test: { permissionMode: "yolo", maxTurns: 10 },
      prod: { model: "claude-opus-4-1", permissionMode: "ask" },
    },
  };

  it("returns the config unchanged when no profile is active", () => {
    const { profiles: _p, ...rest } = base;
    const out = resolveProfile(rest as ResolvedCodepilotConfig);
    expect(out.model).toBe("claude-sonnet-4-5");
    expect(out.activeProfile).toBeUndefined();
  });

  it("merges the dev profile on top of the base config", () => {
    const out = resolveProfile(base, "dev");
    expect(out.model).toBe("claude-haiku-4-5");
    expect(out.permissionMode).toBe("auto-edit");
    // Untouched base fields survive.
    expect(out.provider).toBe("anthropic");
    expect(out.maxTurns).toBe(50);
    expect(out.activeProfile).toBe("dev");
  });

  it("merges the test profile (yolo + low maxTurns)", () => {
    const out = resolveProfile(base, "test");
    expect(out.permissionMode).toBe("yolo");
    expect(out.maxTurns).toBe(10);
    expect(out.model).toBe("claude-sonnet-4-5");
  });

  it("merges the prod profile", () => {
    const out = resolveProfile(base, "prod");
    expect(out.model).toBe("claude-opus-4-1");
    expect(out.permissionMode).toBe("ask");
  });

  it("uses config.activeProfile when no explicit name is given", () => {
    const out = resolveProfile({ ...base, activeProfile: "test" });
    expect(out.permissionMode).toBe("yolo");
    expect(out.activeProfile).toBe("test");
  });

  it("keeps the profiles map available after resolution", () => {
    const out = resolveProfile(base, "dev");
    expect(Object.keys(out.profiles ?? {})).toEqual(["dev", "test", "prod"]);
  });

  it("throws a descriptive error for an unknown profile", () => {
    expect(() => resolveProfile(base, "staging")).toThrow(
      /Unknown config profile "staging".*dev, test, prod/s
    );
  });

  it("deep-merges nested objects between base and profile", () => {
    const cfg: ResolvedCodepilotConfig = {
      sandbox: { mode: "workspace-write", network: true },
      profiles: {
        locked: { sandbox: { mode: "read-only" } },
      },
    };
    const out = resolveProfile(cfg, "locked");
    expect(out.sandbox?.mode).toBe("read-only");
    // network was not overridden by the profile, base value survives.
    expect(out.sandbox?.network).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Profile precedence over base config (via the layered loader)
// ---------------------------------------------------------------------------

describe("profile precedence in loadConfigWithSources", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
    mkdirSync(join(dir, ".codepilot"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("applies activeProfile from the config file on top of the base keys", async () => {
    writeFileSync(
      join(dir, ".codepilot", "config.json"),
      JSON.stringify({
        model: "base-model",
        permissionMode: "ask",
        profiles: {
          prod: { model: "prod-model", permissionMode: "auto-edit" },
        },
        activeProfile: "prod",
      })
    );
    const { config, sources } = await loadConfigWithSources(dir);
    expect(config.model).toBe("prod-model");
    expect(config.permissionMode).toBe("auto-edit");
    expect(sources.map((s) => s.name)).toContain("profile");
  });

  it("options.profile (--profile flag) wins over activeProfile in the file", async () => {
    writeFileSync(
      join(dir, ".codepilot", "config.json"),
      JSON.stringify({
        profiles: {
          dev: { model: "dev-model" },
          prod: { model: "prod-model" },
        },
        activeProfile: "prod",
      })
    );
    const { config } = await loadConfigWithSources(dir, undefined, {
      profile: "dev",
    });
    expect(config.model).toBe("dev-model");
    expect(config.activeProfile).toBe("dev");
  });

  it("profile wins over caller-supplied explicit overrides", async () => {
    writeFileSync(
      join(dir, ".codepilot", "config.json"),
      JSON.stringify({
        profiles: { prod: { model: "prod-model" } },
      })
    );
    const { config } = await loadConfigWithSources(
      dir,
      { model: "caller-model" },
      { profile: "prod" }
    );
    expect(config.model).toBe("prod-model");
  });

  it("fails loudly when --profile names an unknown profile", async () => {
    writeFileSync(
      join(dir, ".codepilot", "config.json"),
      JSON.stringify({ profiles: { dev: { model: "x" } } })
    );
    await expect(
      loadConfigWithSources(dir, undefined, { profile: "nope" })
    ).rejects.toThrow(/Unknown config profile "nope"/);
  });

  it("schema accepts profiles + activeProfile and round-trips validation", () => {
    const validated = validateConfig({
      profiles: { dev: { model: "x", permissionMode: "yolo" } },
      activeProfile: "dev",
    });
    expect(validated.activeProfile).toBe("dev");
    expect(validated.profiles?.dev?.model).toBe("x");
  });

  it("schema rejects unknown keys inside a profile (strict mode)", () => {
    expect(() =>
      validateConfig({ profiles: { dev: { notAKey: 1 } } })
    ).toThrow(/Invalid CodePilot config/);
  });
});

// ---------------------------------------------------------------------------
// Config patch (JSON merge-patch)
// ---------------------------------------------------------------------------

describe("applyConfigPatch", () => {
  const base: ResolvedCodepilotConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    permissionMode: "ask",
    sandbox: { mode: "workspace-write", network: true, fallback: "deny" },
    autoApprove: ["read_file"],
  };

  it("overrides scalars (the --config-patch headline use case)", () => {
    const out = applyConfigPatch(base, {
      model: "gpt-4o",
      permissionMode: "yolo",
    });
    expect(out.model).toBe("gpt-4o");
    expect(out.permissionMode).toBe("yolo");
    expect(out.provider).toBe("anthropic");
  });

  it("deep-merges nested objects key by key", () => {
    const out = applyConfigPatch(base, { sandbox: { network: false } });
    expect(out.sandbox).toEqual({
      mode: "workspace-write",
      network: false,
      fallback: "deny",
    });
  });

  it("replaces arrays wholesale (no concatenation)", () => {
    const out = applyConfigPatch(base, { autoApprove: ["bash"] });
    expect(out.autoApprove).toEqual(["bash"]);
  });

  it("null deletes a key from the base", () => {
    const out = applyConfigPatch(base, { model: null });
    expect("model" in out).toBe(false);
  });

  it("does not mutate the input", () => {
    const before = JSON.stringify(base);
    applyConfigPatch(base, { model: "gpt-4o", sandbox: { network: false } });
    expect(JSON.stringify(base)).toBe(before);
  });

  it("adds keys that were absent from the base", () => {
    const out = applyConfigPatch(base, { maxTurns: 7 });
    expect(out.maxTurns).toBe(7);
  });
});

describe("patch application in loadConfigWithSources", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
    mkdirSync(join(dir, ".codepilot"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("patch applies on top of the final (profile-resolved) config", async () => {
    writeFileSync(
      join(dir, ".codepilot", "config.json"),
      JSON.stringify({
        model: "base-model",
        profiles: { prod: { model: "prod-model", maxTurns: 99 } },
        activeProfile: "prod",
      })
    );
    const { config, sources } = await loadConfigWithSources(dir, undefined, {
      patch: { model: "patched-model" },
    });
    // Patch beats profile, profile beat base.
    expect(config.model).toBe("patched-model");
    expect(config.maxTurns).toBe(99);
    expect(sources.map((s) => s.name)).toEqual(
      expect.arrayContaining(["defaults", "repo", "profile", "patch"])
    );
  });

  it("an invalid patch value is caught by schema validation", async () => {
    await expect(
      loadConfigWithSources(dir, undefined, {
        patch: { permissionMode: "not-a-mode" },
      })
    ).rejects.toThrow(/Invalid CodePilot config/);
  });
});

// ---------------------------------------------------------------------------
// Bundle export / import roundtrip
// ---------------------------------------------------------------------------

describe("bundle export/import", () => {
  let home: string;
  let project: string;
  beforeEach(() => {
    home = tmp();
    project = tmp();
    mkdirSync(join(home, ".codepilot", "commands"), { recursive: true });
    mkdirSync(join(home, ".codepilot", "agents"), { recursive: true });
    mkdirSync(join(home, ".codepilot", "skills", "pdf"), { recursive: true });
    writeFileSync(join(home, ".codepilot", "commands", "review.md"), "# Review\n\n$ARGUMENTS");
    writeFileSync(join(home, ".codepilot", "agents", "explore.md"), "---\nname: explore\ndescription: Explore code\n---\nBody.");
    writeFileSync(join(home, ".codepilot", "skills", "pdf", "SKILL.md"), "# PDF skill");
    writeFileSync(
      join(home, ".codepilot", "config.json"),
      JSON.stringify({ model: "home-model", maxTurns: 42 })
    );
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("exports resolved config + user resources into a bundle", async () => {
    const bundle = await exportBundle({ cwd: project, homeDir: home });
    expect(bundle.version).toBe(BUNDLE_VERSION);
    expect(bundle.config.model).toBe("home-model");
    expect(bundle.config.maxTurns).toBe(42);
    expect(Object.keys(bundle.commands)).toEqual(["review.md"]);
    expect(Object.keys(bundle.agents)).toEqual(["explore.md"]);
    expect(Object.keys(bundle.skills)).toEqual(["pdf/SKILL.md"]);
  });

  it("roundtrips: export -> serialize -> parse -> import reproduces everything", async () => {
    const bundle = await exportBundle({ cwd: project, homeDir: home });
    const parsed = parseBundle(serializeBundle(bundle));
    expect(parsed).toEqual(bundle);

    // Import into a fresh home and verify the files land correctly.
    const target = tmp();
    try {
      const result = await importBundle(parsed, { homeDir: target });
      expect(result.commands).toBe(1);
      expect(result.agents).toBe(1);
      expect(result.skills).toBe(1);
      expect(result.configPath).toBe(join(target, ".codepilot", "config.json"));

      const writtenConfig = JSON.parse(readFileSync(result.configPath, "utf-8"));
      expect(writtenConfig.model).toBe("home-model");
      expect(readFileSync(join(target, ".codepilot", "commands", "review.md"), "utf-8"))
        .toBe("# Review\n\n$ARGUMENTS");
      expect(readFileSync(join(target, ".codepilot", "agents", "explore.md"), "utf-8"))
        .toContain("name: explore");
      expect(readFileSync(join(target, ".codepilot", "skills", "pdf", "SKILL.md"), "utf-8"))
        .toBe("# PDF skill");

      // The imported config round-trips through schema validation cleanly.
      const validated = validateConfig(writtenConfig);
      expect(validated.model).toBe("home-model");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("project resources are included and take precedence over user ones", async () => {
    mkdirSync(join(project, ".codepilot", "commands"), { recursive: true });
    writeFileSync(join(project, ".codepilot", "commands", "review.md"), "project version");
    writeFileSync(join(project, ".codepilot", "commands", "local-only.md"), "local");
    const bundle = await exportBundle({ cwd: project, homeDir: home });
    expect(bundle.commands["review.md"]).toBe("project version");
    expect(bundle.commands["local-only.md"]).toBe("local");
  });

  it("export honours the profile option", async () => {
    writeFileSync(
      join(home, ".codepilot", "config.json"),
      JSON.stringify({
        model: "base-model",
        profiles: { prod: { model: "prod-model" } },
      })
    );
    const bundle = await exportBundle({ cwd: project, homeDir: home, profile: "prod" });
    expect(bundle.config.model).toBe("prod-model");
  });

  it("import rejects path-traversal resource names", async () => {
    const evil: CodepilotBundle = {
      version: BUNDLE_VERSION,
      config: {},
      commands: { "../../etc/passwd.md": "nope" },
      agents: {},
      skills: {},
    };
    await expect(importBundle(evil, { homeDir: tmp() })).rejects.toThrow(
      /unsafe resource name/
    );
  });

  it("parseBundle rejects unsupported versions and malformed JSON", () => {
    expect(() => parseBundle("{ not json")).toThrow(/not valid JSON/);
    expect(() => parseBundle(JSON.stringify({ version: 99, config: {} }))).toThrow(
      /unsupported version 99/
    );
    expect(() => parseBundle(JSON.stringify({ version: 1, config: [] }))).toThrow(
      /"config" must be an object/
    );
  });

  it("import of an empty bundle still writes a config file", async () => {
    const target = tmp();
    try {
      const result = await importBundle(
        { version: BUNDLE_VERSION, config: { model: "m" }, commands: {}, agents: {}, skills: {} },
        { homeDir: target }
      );
      expect(result.commands + result.agents + result.skills).toBe(0);
      expect(existsSync(result.configPath)).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
