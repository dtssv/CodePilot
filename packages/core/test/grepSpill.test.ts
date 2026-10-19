import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { grepTool } from "../src/tools/grep.js";
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
