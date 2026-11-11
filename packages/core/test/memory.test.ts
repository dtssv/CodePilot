import { describe, expect, it } from "vitest";
import { summariseMemory, readMemory, FileMemorySink, projectMemoryPath, readLayeredProjectMemory } from "../src/memory.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
    const sink = new FileMemorySink(dir, { autoMemory: false });
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

  it("spills long MEMORY.md bodies to a short blurb", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-spill-"));
    const sink = new FileMemorySink(dir, { autoMemory: false });
    const long = "x".repeat(800);
    const target = await sink.write("project", "Long", long, "Project context");
    const text = readFileSync(target, "utf-8");
    expect(text).toContain("progressive memory");
    expect(text.length).toBeLessThan(long.length);
    rmSync(target, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("readLayeredProjectMemory", () => {
  function initRepo(dir: string): void {
    execFileSync("git", ["init", "-q"], { cwd: dir });
  }

  it("reads a CLAUDE.md-only repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-claude-"));
    initRepo(dir);
    writeFileSync(join(dir, "CLAUDE.md"), "claude convention", "utf-8");
    const out = await readLayeredProjectMemory(dir);
    expect(out).toContain("claude convention");
    rmSync(dir, { recursive: true, force: true });
  });

  it("AGENTS.override.md shadows AGENTS.md in the same dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-override-"));
    initRepo(dir);
    writeFileSync(join(dir, "AGENTS.md"), "formal rules", "utf-8");
    writeFileSync(join(dir, "AGENTS.override.md"), "override rules", "utf-8");
    const out = await readLayeredProjectMemory(dir);
    expect(out).toContain("override rules");
    expect(out).toContain("formal rules");
    // Override is listed first (higher precedence).
    expect(out!.indexOf("override rules")).toBeLessThan(out!.indexOf("formal rules"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedups identical content across candidate names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-dedup-"));
    initRepo(dir);
    const shared = "same exact body";
    writeFileSync(join(dir, "AGENTS.md"), shared, "utf-8");
    writeFileSync(join(dir, "CLAUDE.md"), shared, "utf-8");
    const out = await readLayeredProjectMemory(dir);
    const occurrences = out!.split("same exact body").length - 1;
    expect(occurrences).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stops at the git toplevel by default and does not read parent dirs", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mem-parent-"));
    const repo = join(parent, "repo");
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeFileSync(join(parent, "AGENTS.md"), "parent-outside-repo", "utf-8");
    writeFileSync(join(repo, "AGENTS.md"), "repo-root", "utf-8");
    const out = await readLayeredProjectMemory(repo);
    expect(out).toContain("repo-root");
    expect(out).not.toContain("parent-outside-repo");
    rmSync(parent, { recursive: true, force: true });
  });

  it("walkToHome:true reads parent dirs above the git root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mem-walkhome-"));
    const repo = join(parent, "repo");
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeFileSync(join(parent, "AGENTS.md"), "parent-above-root", "utf-8");
    writeFileSync(join(repo, "AGENTS.md"), "repo-root", "utf-8");
    const out = await readLayeredProjectMemory(repo, { walkToHome: true });
    expect(out).toContain("repo-root");
    expect(out).toContain("parent-above-root");
    rmSync(parent, { recursive: true, force: true });
  });
});
