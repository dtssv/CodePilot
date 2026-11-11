import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { grepTool, parseRipgrep } from "../src/tools/grep.js";
import { resolveSandbox } from "../src/sandbox.js";
import type { ToolContext } from "../src/tools/types.js";

describe("grep tool large-output spill", () => {
  let dir: string;
  let artifacts: Map<string, string>;

  const ctx = (): ToolContext => ({
    cwd: dir,
    artifact: async (blob: string | Uint8Array) => {
      const ref = `art_${artifacts.size}`;
      artifacts.set(ref, String(blob));
      return ref;
    },
    readArtifact: async (ref: string) => artifacts.get(ref) ?? "",
    sandbox: resolveSandbox({ mode: "off" }, dir),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "grep-"));
    artifacts = new Map();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns matches inline when small", async () => {
    await writeFile(join(dir, "a.txt"), "needle here\nother line\nneedle again\n");
    const res = await grepTool.execute({ pattern: "needle", maxResults: 100 }, ctx());
    expect(res.content).toContain("a.txt:1");
    expect(res.content).toContain("a.txt:3");
    expect(res.artifactRef).toBeUndefined();
  });

  it("spills a huge match list to an artifact and keeps only a head slice inline", async () => {
 // Build a file whose matches total well over the 8KB inline threshold.
    const lines = Array.from({ length: 4000 }, (_, i) => `MATCH line ${i} with some padding text to add width`);
    await writeFile(join(dir, "big.txt"), lines.join("\n") + "\n");

    const res = await grepTool.execute({ pattern: "MATCH", maxResults: 10_000, context: 0 }, ctx());
 // Spilled: has an artifactRef, inline content is capped, points to artifact.
    expect(res.artifactRef).toBeTruthy();
    expect(res.content.length).toBeLessThan(10_000);
    expect(res.content).toContain("omitted");
    expect(res.content).toContain(res.artifactRef!);
 // The full match list is retrievable from the artifact and is far larger
 // than the inline head slice.
    const full = artifacts.get(res.artifactRef!)!;
    expect(full.length).toBeGreaterThan(res.content.length);
    expect(full).toContain("big.txt:1:");
 // Many matches captured (far more than fit inline).
    expect(full.split("\n").length).toBeGreaterThan(500);
  });
});

describe("grep tool include / path", () => {
  let dir: string;
  const ctx = (): ToolContext => ({
    cwd: dir,
    artifact: async () => "art_0",
    readArtifact: async () => "",
    sandbox: resolveSandbox({ mode: "off" }, dir),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "grep-inc-"));
    await mkdir(join(dir, "packages", "a", "src"), { recursive: true });
    await writeFile(join(dir, "packages", "a", "src", "server.ts"), "export function subscribe() {}\n");
    await writeFile(join(dir, "packages", "a", "src", "view.tsx"), "subscribe in tsx\n");
    await writeFile(join(dir, "packages", "a", "src", "notes.md"), "subscribe in md\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("matches a slash-less include against the file name at any depth", async () => {
    const res = await grepTool.execute({ pattern: "subscribe", include: "*.ts" }, ctx());
    expect(res.content).toContain("server.ts:1");
    expect(res.content).not.toContain("notes.md");
  });

  it("expands brace alternatives", async () => {
    const res = await grepTool.execute({ pattern: "subscribe", include: "*.{ts,tsx}" }, ctx());
    expect(res.content).toContain("server.ts");
    expect(res.content).toContain("view.tsx");
    expect(res.content).not.toContain("notes.md");
  });

  it("accepts `path` as a directory or a single file", async () => {
    const inDir = await grepTool.execute({ pattern: "subscribe", path: "packages/a/src", include: "*.md" }, ctx());
    expect(inDir.content).toContain("notes.md:1");
    const inFile = await grepTool.execute({ pattern: "subscribe", path: "packages/a/src/server.ts" }, ctx());
    expect(inFile.content).toContain("server.ts:1");
  });
});

describe("grep backend selection", () => {
  let dir: string;
  const ctx = (backend?: "walker" | "rg" | "auto"): ToolContext => ({
    cwd: dir,
    artifact: async () => "art_0",
    readArtifact: async () => "",
    sandbox: resolveSandbox({ mode: "off" }, dir),
    ...(backend ? { config: { grep: { backend } } as never } : {}),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "grep-be-"));
    await writeFile(join(dir, "a.txt"), "needle one\nplain\nneedle two\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // rg may or may not be installed in CI. "auto"/"rg" fall back to the walker
  // when rg is absent or errors, so the results must be correct either way.
  it("returns matches under the walker backend", async () => {
    const res = await grepTool.execute({ pattern: "needle" }, ctx("walker"));
    expect(res.content).toContain("a.txt:1");
    expect(res.content).toContain("a.txt:3");
  });

  it("returns matches under the auto backend (rg or walker fallback)", async () => {
    const res = await grepTool.execute({ pattern: "needle" }, ctx("auto"));
    expect(res.content).toContain("a.txt:1");
    expect(res.content).toContain("a.txt:3");
  });

  it("returns matches under the rg backend (rg or walker fallback)", async () => {
    const res = await grepTool.execute({ pattern: "needle" }, ctx("rg"));
    expect(res.content).toContain("a.txt:1");
    expect(res.content).toContain("a.txt:3");
  });
});

describe("parseRipgrep", () => {
  it("parses match lines into base-relative hits", () => {
    const out = "src/a.ts:10:const x = 1;\nsrc/b.ts:3:const y = 2;\n";
    const hits = parseRipgrep(out, "/work", 0, 100);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ file: "src/a.ts", line: 9, text: "const x = 1;" });
    expect(hits[1]).toMatchObject({ file: "src/b.ts", line: 2, text: "const y = 2;" });
  });

  it("collapses a context group (match + surrounding ctx lines) into one hit", () => {
    // rg --context output: context lines use `-`, match lines use `:`, groups
    // split by `--`.
    const out =
      "f.ts-9-before\nf.ts:10:MATCH here\nf.ts-11-after\n--\ng.ts:2:other MATCH\n";
    const hits = parseRipgrep(out, "/work", 1, 100);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.file).toBe("f.ts");
    expect(hits[0]!.line).toBe(9); // the match line (10) → 0-based 9
    expect(hits[0]!.text).toContain("before");
    expect(hits[0]!.text).toContain("MATCH here");
    expect(hits[0]!.text).toContain("after");
    expect(hits[1]).toMatchObject({ file: "g.ts", line: 1 });
  });

  it("strips the base prefix from absolute rg paths", () => {
    const hits = parseRipgrep("/work/src/a.ts:1:hi\n", "/work", 0, 100);
    expect(hits[0]!.file).toBe("src/a.ts");
  });

  it("respects the cap", () => {
    const out = Array.from({ length: 50 }, (_, i) => `f.ts:${i + 1}:m${i}`).join("\n");
    const hits = parseRipgrep(out, "/work", 0, 10);
    expect(hits).toHaveLength(10);
  });
});
