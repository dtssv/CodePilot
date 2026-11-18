import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoMemoryDir,
  INDEX_BULLET_MAX_CHARS,
  loadAutoMemoryIndex,
  loadAutoMemoryPromptStub,
  MEMORY_SUMMARY_NAME,
  NOTES_DIRNAME,
  resolveMemoryTopic,
  sanitizeTopic,
  truncateIndexBullet,
  writeAdHocMemoryNote,
  writeAutoMemoryNote,
} from "../src/memory/autoMemory.js";
import { FileMemorySink } from "../src/memory/memory.js";
import { readdirSync } from "node:fs";

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

  it("clamps free-form topic slugs onto the fixed taxonomy", () => {
    expect(
      resolveMemoryTopic({
        scope: "project",
        title: "t",
        content: "c",
        topic: "Testing Setup!",
      }).topic,
    ).toBe("knowledge");
    expect(
      resolveMemoryTopic({
        scope: "project",
        title: "t",
        content: "c",
        topic: "architecture",
      }).topic,
    ).toBe("architecture");
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

  it("truncates long index bullets to a one-line hook", async () => {
    root = mkdtempSync(join(tmpdir(), "am-long-"));
    const cwd = mkdtempSync(join(tmpdir(), "am-long-cwd-"));
    const long = "x".repeat(INDEX_BULLET_MAX_CHARS + 80);
    await writeAutoMemoryNote(
      cwd,
      {
        category: "project",
        topic: "knowledge",
        summary: long,
        body: "full body stays intact",
      },
      { enabled: true, rootDir: root },
    );
    const dir = autoMemoryDir(cwd, root);
    const index = await loadAutoMemoryIndex(cwd, { enabled: true, rootDir: root });
    expect(index).toBeDefined();
    const bullet = index!.split(/\r?\n/).find((l) => l.startsWith("- [project]"));
    expect(bullet).toBeDefined();
    // Hook + category/date wrappers stay bounded; raw long summary must not appear.
    expect(bullet!.length).toBeLessThan(INDEX_BULLET_MAX_CHARS + 40);
    expect(index).not.toContain(long);
    expect(readFileSync(join(dir, "knowledge.md"), "utf-8")).toContain("full body stays intact");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("prompt stub advertises dir + counts without dumping the handbook", async () => {
    root = mkdtempSync(join(tmpdir(), "am-stub-"));
    const cwd = mkdtempSync(join(tmpdir(), "am-stub-cwd-"));
    await writeAutoMemoryNote(
      cwd,
      {
        category: "project",
        topic: "architecture",
        summary: "Auth owns users",
        body: "details that must not flood the stub",
      },
      { enabled: true, rootDir: root },
    );
    const dir = autoMemoryDir(cwd, root);
    expect(existsSync(join(dir, MEMORY_SUMMARY_NAME))).toBe(true);
    const stub = await loadAutoMemoryPromptStub(cwd, { enabled: true, rootDir: root });
    expect(stub).toBeDefined();
    expect(stub).toContain(`dir: \`${dir}\``);
    expect(stub).toMatch(/topics: 1\//);
    expect(stub).toMatch(/pending_notes: 0\//);
    expect(stub).not.toContain("details that must not flood the stub");
    expect(stub).not.toContain("## Topics");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("truncateIndexBullet clamps to the hook budget", () => {
    expect(truncateIndexBullet("short")).toBe("short");
    expect(truncateIndexBullet("x".repeat(200)).length).toBe(INDEX_BULLET_MAX_CHARS);
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
    expect(index).toContain("## Topics");
    expect(index).toContain(`_Directory: \`${dir}\``);
    // Thin index: topic basenames only — no absolute-path dump.
    expect(index).toContain("- architecture");
    expect(index).not.toContain(join(dir, "architecture.md"));
    rmSync(cwd, { recursive: true, force: true });
  });

  it("FileMemorySink dual-writes into the capped notes inbox", async () => {
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
    const notesDir = join(dir, NOTES_DIRNAME);
    expect(existsSync(notesDir)).toBe(true);
    const notes = readdirSync(notesDir).filter((f) => f.endsWith(".md"));
    expect(notes.length).toBe(1);
    expect(readFileSync(join(notesDir, notes[0]!), "utf-8")).toContain("pnpm test");
    expect(existsSync(join(dir, "knowledge.md"))).toBe(false);
    const index = await loadAutoMemoryIndex(cwd, { enabled: true, rootDir: root });
    expect(index).toContain("pnpm tests");
    expect(index).toContain("## Pending notes");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writeAdHocMemoryNote clamps custom topics and prunes the inbox", async () => {
    root = mkdtempSync(join(tmpdir(), "am-adhoc-"));
    const cwd = mkdtempSync(join(tmpdir(), "am-adhoc-cwd-"));
    const id = await writeAdHocMemoryNote(
      cwd,
      {
        category: "project",
        topic: "custom-slug",
        summary: "remember this",
        body: "body",
      },
      { enabled: true, rootDir: root },
    );
    expect(id).toBeTruthy();
    const dir = autoMemoryDir(cwd, root);
    const noteText = readFileSync(
      join(dir, NOTES_DIRNAME, readdirSync(join(dir, NOTES_DIRNAME))[0]!),
      "utf-8",
    );
    expect(noteText).toContain("topic: knowledge");
    expect(existsSync(join(dir, "custom-slug.md"))).toBe(false);
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
    const { projectMemoryPath } = await import("../src/memory/memory.js");
    const text = readFileSync(projectMemoryPath(cwd), "utf-8");
    for (let i = 0; i < n; i++) {
      expect(text).toContain(`entry ${i}`);
    }
    rmSync(cwd, { recursive: true, force: true });
  });
});
