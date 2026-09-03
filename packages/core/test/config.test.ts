import { describe, expect, it } from "vitest";
import { loadConfig, mergeConfig } from "../src/config.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config", () => {
  it("mergeConfig with empty inputs", () => {
    expect(mergeConfig(undefined, undefined)).toEqual({});
  });
  it("mergeConfig applies override fields", () => {
    const r = mergeConfig(
      { provider: "openai", model: "x" },
      { model: "y", permissionMode: "yolo" }
    );
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("y");
    expect(r.permissionMode).toBe("yolo");
  });
  it("mergeConfig concatenates autoApprove", () => {
    const r = mergeConfig({ autoApprove: ["a"] }, { autoApprove: ["b"] });
    expect(r.autoApprove).toEqual(["a", "b"]);
  });
  it("mergeConfig merges mcpServers", () => {
    const r = mergeConfig(
      { mcpServers: { s1: { command: "x" } } },
      { mcpServers: { s2: { command: "y" } } }
    );
    expect(Object.keys(r.mcpServers!)).toEqual(["s1", "s2"]);
  });
  it("loadConfig reads .codepilot/config.json", async () => {
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
});

