import { describe, expect, it } from "vitest";
import { summariseMemory, readMemory, FileMemorySink, projectMemoryPath } from "../src/memory.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

describe("memory", () => {
  it("summariseMemory truncates long content", () => {
    const out = summariseMemory({ project: "x".repeat(10_000) }, 100);
    expect(out.project).toBeDefined();
    expect(out.project!.length).toBeLessThan(10_000);
    expect(out.project).toContain("truncated");
  });

  it("readMemory reads project-state MEMORY.md (not cwd)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-"));
    const path = projectMemoryPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "project mem", "utf-8");
    writeFileSync(join(dir, "CODEPILOT.md"), "should not be primary", "utf-8");
    const m = await readMemory(dir);
    expect(m.project).toBe("project mem");
    rmSync(path, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("FileMemorySink writes under ~/.codepilot/projects/<hash>/", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-"));
    const sink = new FileMemorySink(dir);
    const target = await sink.write("project", "Title", "Body content");
    expect(target).toBe(projectMemoryPath(dir));
    expect(target.includes(".codepilot/projects/")).toBe(true);
    expect(target.endsWith("MEMORY.md")).toBe(true);
    const text = readFileSync(target, "utf-8");
    expect(text).toContain("Title");
    expect(text).toContain("Body content");
    rmSync(target, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});
