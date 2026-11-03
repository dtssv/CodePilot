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

  // Concurrency contract: the in-turn tool barrier treats memory_write as
  // parallel-safe (its permission tier is "read"), so two notes can run at
  // once. The per-path write lock must keep the read-append-write + index
  // rebuild from clobbering — all concurrent notes must survive, and the
  // rebuilt index must list every one.
  it("does not clobber concurrent writes to the same topic", async () => {
    root = mkdtempSync(join(tmpdir(), "am3-"));
    const cwd = mkdtempSync(join(tmpdir(), "am3-cwd-"));
    const n = 8;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        writeAutoMemoryNote(
          cwd,
          {
            category: "project",
            topic: "knowledge",
            summary: `fact number ${i}`,
            body: `body of fact ${i}`,
          },
          { enabled: true, rootDir: root },
        ),
      ),
    );
    const dir = autoMemoryDir(cwd, root);
    const topic = readFileSync(join(dir, "knowledge.md"), "utf-8");
    for (let i = 0; i < n; i++) {
      expect(topic).toContain(`fact number ${i}`);
    }
    const index = await loadAutoMemoryIndex(cwd, { enabled: true, rootDir: root });
    for (let i = 0; i < n; i++) {
      expect(index).toContain(`[project] fact number ${i}`);
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("does not clobber concurrent FileMemorySink writes to MEMORY.md", async () => {
    root = mkdtempSync(join(tmpdir(), "am4-"));
    const cwd = mkdtempSync(join(tmpdir(), "am4-cwd-"));
    const sink = new FileMemorySink(cwd, {
      // Disable the auto-memory mirror so this isolates the MEMORY.md RMW lock.
      autoMemory: false,
    });
    const n = 8;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        sink.write(
          "project",
          `entry ${i}`,
          `content of entry ${i}`,
          "Discovered durable knowledge",
        ),
      ),
    );
    const { projectMemoryPath } = await import("../src/memory.js");
    const text = readFileSync(projectMemoryPath(cwd), "utf-8");
    for (let i = 0; i < n; i++) {
      expect(text).toContain(`entry ${i}`);
    }
    rmSync(cwd, { recursive: true, force: true });
  });
});
