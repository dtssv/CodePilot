import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  compileGrepPattern,
  grepTool,
  parseRipgrep,
  resetRgBinaryCache,
  resolveRgBinary,
} from "../src/tools/grep.js";
import { resolveSandbox } from "../src/sandbox/sandbox.js";
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
    // Build a file whose matches total well over the 6KB inline head window.
    const lines = Array.from({ length: 4000 }, (_, i) => `MATCH line ${i} with some padding text to add width`);
    await writeFile(join(dir, "big.txt"), lines.join("\n") + "\n");

    const res = await grepTool.execute({ pattern: "MATCH", maxResults: 10_000, context: 0 }, ctx());
    // Spilled: has an artifactRef, inline content is capped, points to artifact.
    expect(res.artifactRef).toBeTruthy();
    expect(res.content.length).toBeLessThan(10_000);
    expect(res.content).toContain("omitted");
    expect(res.content).not.toMatch(/-\d/); // no negative omitted count
    expect(res.content).toContain(res.artifactRef!);
    // The full match list is retrievable from the artifact and is far larger
    // than the inline head slice.
    const full = artifacts.get(res.artifactRef!)!;
    expect(full.length).toBeGreaterThan(res.content.length);
    expect(full).toContain("big.txt:1:");
    // Many matches captured (far more than fit inline).
    expect(full.split("\n").length).toBeGreaterThan(500);
  });

  it("keeps a mid-size match list inline without a negative omitted marker", async () => {
    // ~5KB of matches: previously gated on ARTIFACT_THRESHOLD=4KB while the
    // head window was 6KB, so omitted went negative.
    const lines = Array.from(
      { length: 80 },
      (_, i) => `hit ${String(i).padStart(3, "0")} ${"pad ".repeat(12)}`,
    );
    await writeFile(join(dir, "mid.txt"), lines.join("\n") + "\n");
    const res = await grepTool.execute({ pattern: "hit ", maxResults: 200, context: 0 }, ctx());
    expect(res.artifactRef).toBeUndefined();
    expect(res.content).not.toContain("omitted");
    expect(res.content.length).toBeGreaterThan(4_000);
    expect(res.content.length).toBeLessThanOrEqual(6_000 + 200); // raw matches, no spill header
  });

  it("announces truncation only when more results exist beyond maxResults", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `needle ${i}`);
    await writeFile(join(dir, "many.txt"), lines.join("\n") + "\n");
    const res = await grepTool.execute(
      { pattern: "needle", maxResults: 10, context: 0 },
      ctx(),
    );
    expect(res.content).toMatch(/truncated at 10; pass offset=10 for more/);
    expect(res.content.split("\n").filter((l) => l.includes("needle")).length).toBe(10);
  });

  it("does not false-report truncation when results exactly equal maxResults", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `needle ${i}`);
    await writeFile(join(dir, "exact.txt"), lines.join("\n") + "\n");
    const res = await grepTool.execute(
      { pattern: "needle", maxResults: 10, context: 0 },
      ctx(),
    );
    expect(res.content).not.toMatch(/truncated at/);
    expect(res.content.split("\n").filter((l) => l.includes("needle")).length).toBe(10);
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

describe("compileGrepPattern", () => {
  it("maps a leading (?i) flag to the JS i flag for walker fallback", () => {
    const r = compileGrepPattern("(?i)vs[\\s-]?code");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.re.flags).toContain("i");
    expect(r.re.test("vs Code")).toBe(true);
    expect(r.forRipgrep.startsWith("(?i)")).toBe(true);
  });

  it("returns a clear isError-style message for truly invalid patterns", () => {
    const r = compileGrepPattern("(abc");
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toMatch(/invalid pattern/i);
    expect(r.error).toContain("(abc");
  });
});

describe("resolveRgBinary", () => {
  afterEach(() => resetRgBinaryCache());

  it("resolves the packaged @vscode/ripgrep binary", async () => {
    resetRgBinaryCache();
    const bin = await resolveRgBinary();
    expect(bin).toBeTruthy();
    // Packaged path contains ripgrep; PATH fallback is the bare name "rg".
    expect(bin === "rg" || bin!.includes("ripgrep") || bin!.endsWith("/rg") || bin!.endsWith("\\rg.exe")).toBe(
      true,
    );
  });
});

describe("grep (?i) end-to-end", () => {
  let dir: string;
  const ctx = (backend?: "walker" | "rg"): ToolContext => ({
    cwd: dir,
    artifact: async () => "art_0",
    readArtifact: async () => "",
    sandbox: resolveSandbox({ mode: "off" }, dir),
    ...(backend ? { config: { grep: { backend } } as never } : {}),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "grep-ci-"));
    await writeFile(join(dir, "a.txt"), "Hello World rocks\nplain\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds case-insensitive matches with (?i) via default rg backend", async () => {
    const res = await grepTool.execute(
      { pattern: "(?i)hello[\\s-]?world|foo|bar", context: 0 },
      ctx(),
    );
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain("a.txt:1");
    expect(res.content).toMatch(/Hello World/i);
  });

  it("finds case-insensitive matches with (?i) via walker fallback", async () => {
    const res = await grepTool.execute(
      { pattern: "(?i)hello[\\s-]?world|foo|bar", context: 0 },
      ctx("walker"),
    );
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain("a.txt:1");
    expect(res.content).toMatch(/Hello World/i);
  });
});

describe("parseRipgrep", () => {
  it("splits a merged context group into one hit per match, like the walker", () => {
    // rg merges the overlapping windows of lines 1 and 3 into one group.
    const out = "a.txt:1:needle one\na.txt-2-plain\na.txt:3:needle two\n--\nb.txt:9:needle\n";
    const hits = parseRipgrep(out, "/base", 1, 50);
    expect(hits.map((h) => `${h.file}:${h.line + 1}`)).toEqual(["a.txt:1", "a.txt:3", "b.txt:9"]);
    expect(hits[0]!.text).toBe("needle one\nplain");
    expect(hits[1]!.text).toBe("plain\nneedle two");
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

  // Packaged @vscode/ripgrep is a dependency; if the platform binary is missing
  // (rare in CI), "rg"/"auto"/default fall back to the walker.
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

  it("defaults to the rg backend when config omits grep.backend", async () => {
    const res = await grepTool.execute({ pattern: "needle" }, ctx());
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

describe("grep output_mode", () => {
  let dir: string;

  const ctx = (): ToolContext => ({
    cwd: dir,
    artifact: async () => "art_x",
    readArtifact: async () => "",
    sandbox: resolveSandbox({ mode: "off" }, dir),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "grep-mode-"));
    resetRgBinaryCache();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("files_with_matches returns unique paths only", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "needle\nneedle\n");
    await writeFile(join(dir, "src/b.ts"), "other\n");
    await writeFile(join(dir, "src/c.ts"), "needle here\n");
    const res = await grepTool.execute(
      { pattern: "needle", output_mode: "files_with_matches" },
      ctx(),
    );
    const lines = res.content.trim().split("\n").sort();
    expect(lines).toEqual(["src/a.ts", "src/c.ts"].sort());
    expect(res.content).not.toMatch(/:\d+:/);
  });

  it("count returns per-file match counts", async () => {
    await writeFile(join(dir, "a.ts"), "foo\nbar\nfoo\n");
    await writeFile(join(dir, "b.ts"), "foo\n");
    const res = await grepTool.execute({ pattern: "foo", output_mode: "count" }, ctx());
    expect(res.content).toMatch(/a\.ts:2/);
    expect(res.content).toMatch(/b\.ts:1/);
  });

  it("literal + caseSensitive:false finds fixed strings ignore-case", async () => {
    await writeFile(join(dir, "a.ts"), "Hello World\n");
    const res = await grepTool.execute(
      { pattern: "hello world", literal: true, caseSensitive: false },
      ctx(),
    );
    expect(res.content).toMatch(/Hello World/);
  });

  it("default content mode is unchanged", async () => {
    await writeFile(join(dir, "a.ts"), "needle\n");
    const res = await grepTool.execute({ pattern: "needle" }, ctx());
    expect(res.content).toMatch(/a\.ts:1:.*needle/);
  });
});
