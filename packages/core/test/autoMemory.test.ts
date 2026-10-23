import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoMemoryDir,
  loadAutoMemoryIndex,
  resolveMemoryTopic,
  sanitizeTopic,
  writeAutoMemoryNote,
} from "../src/autoMemory.js";
import { FileMemorySink } from "../src/memory.js";

describe("resolveMemoryTopic", () => {
  it("maps MEMORY sections to topic files", () => {
    expect(
      resolveMemoryTopic({
        scope: "project",
        section: "Architecture decisions",
        title: "ADR",
        content: "chose X",
      }),
    ).toMatchObject({ topic: "architecture", category: "project" });
    expect(
      resolveMemoryTopic({
        scope: "project",
        section: "Rules",
        title: "lint",
        content: "must use pnpm",
      }).topic,
    ).toBe("standards");
    expect(
      resolveMemoryTopic({
        scope: "project",
        section: "Discovered durable knowledge",
        title: "tests",
        content: "pnpm test",
      }).topic,
    ).toBe("knowledge");
  });

  it("honours explicit topic slug", () => {
    expect(
      resolveMemoryTopic({
        scope: "project",
        title: "t",
        content: "c",
        topic: "Testing Setup!",
      }).topic,
    ).toBe("testing-setup");
  });

  it("sanitizeTopic strips junk", () => {
    expect(sanitizeTopic("Foo/Bar.md")).toBe("foo-bar");
  });
});

describe("writeAutoMemoryNote + index", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("writes topic body and thin index with paths", async () => {
    root = mkdtempSync(join(tmpdir(), "am-"));
    const cwd = mkdtempSync(join(tmpdir(), "am-cwd-"));
    await writeAutoMemoryNote(
      cwd,
      {
        category: "project",
        topic: "architecture",
        summary: "Auth owns users",
        body: "The auth module is the single source of truth for the user table.",
      },
      { enabled: true, rootDir: root },
    );
    const dir = autoMemoryDir(cwd, root);
    expect(existsSync(join(dir, "architecture.md"))).toBe(true);
    const topic = readFileSync(join(dir, "architecture.md"), "utf-8");
    expect(topic).toContain("Auth owns users");
    expect(topic).toContain("single source of truth");
    const index = await loadAutoMemoryIndex(cwd, { enabled: true, rootDir: root });
    expect(index).toBeDefined();
    expect(index).toContain("[project] Auth owns users");
    expect(index).toContain("## Topic files");
    expect(index).toContain(join(dir, "architecture.md"));
    rmSync(cwd, { recursive: true, force: true });
  });

  it("FileMemorySink dual-writes progressive topics", async () => {
    root = mkdtempSync(join(tmpdir(), "am2-"));
    const cwd = mkdtempSync(join(tmpdir(), "am2-cwd-"));
    const sink = new FileMemorySink(cwd, {
      autoMemory: { enabled: true, rootDir: root },
    });
    await sink.write(
      "project",
      "pnpm tests",
      "Run tests with `pnpm test`, not npm test.",
      "Discovered durable knowledge",
    );
    const dir = autoMemoryDir(cwd, root);
    expect(existsSync(join(dir, "knowledge.md"))).toBe(true);
    expect(readFileSync(join(dir, "knowledge.md"), "utf-8")).toContain("pnpm test");
    const index = await loadAutoMemoryIndex(cwd, { enabled: true, rootDir: root });
    expect(index).toContain("pnpm tests");
    rmSync(cwd, { recursive: true, force: true });
  });
});
