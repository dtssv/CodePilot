import { describe, expect, it } from "vitest";
import { buildSubagentToolRegistry, narrowSubagentTools } from "../src/tools/subagentTools.js";

describe("buildSubagentToolRegistry", () => {
  it("gives explore sub-agents read + network research tools (incl. web_fetch)", () => {
    const names = new Set(buildSubagentToolRegistry("explore").all().map((t) => t.name));
    // Read-only inspection.
    for (const n of ["read_file", "read_image", "glob", "grep", "ls", "read_artifact"]) {
      expect(names.has(n)).toBe(true);
    }
    // Network research — the whole point of an explore agent.
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("web_search")).toBe(true);
    // No write/execute surface for explore.
    for (const n of ["write_file", "edit_file", "apply_patch", "bash", "task_board"]) {
      expect(names.has(n)).toBe(false);
    }
  });

  it("gives worker sub-agents the write/execute surface on top", () => {
    const names = new Set(buildSubagentToolRegistry("worker").all().map((t) => t.name));
    for (const n of ["write_file", "edit_file", "apply_patch", "bash", "task_board"]) {
      expect(names.has(n)).toBe(true);
    }
    // Workers keep research tools too.
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("web_search")).toBe(true);
  });

  it("gives plan sub-agents the explore read-only surface (no write/bash/task_board)", () => {
    const names = new Set(buildSubagentToolRegistry("plan").all().map((t) => t.name));
    for (const n of ["read_file", "glob", "grep", "ls", "read_artifact"]) {
      expect(names.has(n)).toBe(true);
    }
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("web_search")).toBe(true);
    for (const n of ["write_file", "edit_file", "apply_patch", "bash", "task_board"]) {
      expect(names.has(n)).toBe(false);
    }
  });

  it("never exposes plan/goal/memory_write/task to sub-agents", () => {
    for (const type of ["explore", "plan", "worker"] as const) {
      const names = new Set(buildSubagentToolRegistry(type).all().map((t) => t.name));
      for (const n of ["plan", "goal", "memory_write", "task"]) {
        expect(names.has(n)).toBe(false);
      }
    }
  });

  it("includes read-only lsp_navigate for every type when a manager is wired", () => {
    const lsp = { getManager: () => null, getCwd: () => "/work" };
    for (const type of ["explore", "plan", "worker"] as const) {
      const names = new Set(buildSubagentToolRegistry(type, lsp).all().map((t) => t.name));
      expect(names.has("lsp_navigate")).toBe(true);
      // The host-backed diagnostics tool is never granted to sub-agents.
      expect(names.has("diagnostics")).toBe(false);
    }
  });

  it("omits lsp_navigate when no language-server manager is wired", () => {
    for (const type of ["explore", "plan", "worker"] as const) {
      const names = new Set(buildSubagentToolRegistry(type).all().map((t) => t.name));
      expect(names.has("lsp_navigate")).toBe(false);
    }
  });

  it("narrowSubagentTools drops out-of-pool names without failing", () => {
    const pool = buildSubagentToolRegistry("explore");
    const { registry, dropped } = narrowSubagentTools(pool, [
      "bash",
      "read_file",
      "grep",
    ]);
    expect(dropped).toEqual(["bash"]);
    const names = new Set(registry.names());
    expect(names.has("read_file")).toBe(true);
    expect(names.has("grep")).toBe(true);
    expect(names.has("bash")).toBe(false);
  });

  it("narrowSubagentTools falls back to the full pool when every name is out-of-pool", () => {
    const pool = buildSubagentToolRegistry("explore");
    const { registry, dropped } = narrowSubagentTools(pool, ["bash", "write_file"]);
    expect(dropped).toEqual(["bash", "write_file"]);
    expect(registry.names().sort()).toEqual(pool.names().sort());
  });

  it("narrowSubagentTools keeps a worker subset when names are in-pool", () => {
    const pool = buildSubagentToolRegistry("worker");
    const { registry, dropped } = narrowSubagentTools(pool, ["bash", "read_file"]);
    expect(dropped).toEqual([]);
    expect(new Set(registry.names())).toEqual(new Set(["bash", "read_file"]));
  });
});
