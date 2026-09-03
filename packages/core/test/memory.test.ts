import { describe, expect, it } from "vitest";
import { summariseMemory, readMemory, FileMemorySink } from "../src/memory.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory", () => {
  it("summariseMemory truncates long content", () => {
    const out = summariseMemory({ project: "x".repeat(10_000) }, 100);
    expect(out.project).toBeDefined();
    expect(out.project!.length).toBeLessThan(10_000);
    expect(out.project).toContain("truncated");
  });

  it("readMemory reads project and user files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-"));
    writeFileSync(join(dir, "CODEPILOT.md"), "project mem", "utf-8");
    const m = await readMemory(dir);
    expect(m.project).toBe("project mem");
    rmSync(dir, { recursive: true, force: true });
  });

  it("FileMemorySink appends a dated block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-"));
    const sink = new FileMemorySink(dir);
    const target = await sink.write("project", "Title", "Body content");
    const text = readFileSync(target, "utf-8");
    expect(text).toContain("## Title");
    expect(text).toContain("Body content");
    rmSync(dir, { recursive: true, force: true });
  });
});
