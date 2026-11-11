// Query-time progressive memory recall: select relevant topic files for a
// query and inject their truncated bodies. Fail-soft and hard-capped.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recallRelevantMemories,
  RECALL_TOTAL_CHARS,
} from "../src/memoryRecall.js";
import { autoMemoryDir } from "../src/autoMemory.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";

/** A small-model stub that "selects" by echoing a fixed JSON array of paths. */
function selectorProvider(reply: string): ChatProvider {
  return {
    name: "mock",
    defaultModel: "mock",
    smallModel: "mock",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { kind: "text_delta", messageId: "m1", text: reply };
      yield { kind: "done", finishReason: "stop" };
    },
  };
}

function seedMemory(root: string, cwd: string, files: Record<string, string>): string {
  const dir = autoMemoryDir(cwd, root);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf-8");
  }
  return dir;
}

describe("recallRelevantMemories", () => {
  let root: string;
  const cwd = "/repo/project";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("returns a block with the selected topic body for a relevant query", async () => {
    root = mkdtempSync(join(tmpdir(), "recall-"));
    const dir = seedMemory(root, cwd, {
      "testing.md": "- [project] run tests with `pnpm test`\nAlways run the core suite before committing.",
      "style.md": "- [project] 2-space indent",
      "overview.md": "- [project] a web app",
      "deploy.md": "- [project] ship via CI",
      "api.md": "- [project] REST under /v1",
      "db.md": "- [project] postgres",
    });
    // 6 files > default recallMax 5 → the model selects. Point it at testing.md.
    const provider = selectorProvider(JSON.stringify([join(dir, "testing.md")]));
    const block = await recallRelevantMemories({
      provider,
      cwd,
      query: "what are the testing conventions here?",
      rootDir: root,
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("<relevant_memories>");
    expect(block!).toContain("pnpm test");
    expect(block!).toContain(join(dir, "testing.md"));
    // Non-selected topics are not injected.
    expect(block!).not.toContain("postgres");
  });

  it("attaches all when few candidates, skipping the model call", async () => {
    root = mkdtempSync(join(tmpdir(), "recall-"));
    seedMemory(root, cwd, {
      "testing.md": "- [project] tests via pnpm test",
      "style.md": "- [project] 2-space indent",
    });
    // Provider that would THROW if called — proves the model path is skipped.
    const provider: ChatProvider = {
      name: "mock",
      defaultModel: "mock",
      smallModel: "mock",
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error("model should not be called with few candidates");
      },
    };
    const block = await recallRelevantMemories({
      provider,
      cwd,
      query: "anything",
      rootDir: root,
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("pnpm test");
    expect(block!).toContain("2-space indent");
  });

  it("skips topic files already read this session", async () => {
    root = mkdtempSync(join(tmpdir(), "recall-"));
    const dir = seedMemory(root, cwd, {
      "testing.md": "- [project] tests via pnpm test",
      "style.md": "- [project] 2-space indent",
    });
    const block = await recallRelevantMemories({
      provider: selectorProvider("[]"),
      cwd,
      query: "testing?",
      rootDir: root,
      alreadyRead: new Set([join(dir, "testing.md")]),
    });
    // testing.md was already read → excluded; only style.md remains (<= max → attached).
    expect(block).not.toBeNull();
    expect(block!).not.toContain("pnpm test");
    expect(block!).toContain("2-space indent");
  });

  it("enforces the total character cap across selected files", async () => {
    root = mkdtempSync(join(tmpdir(), "recall-"));
    const big = "X".repeat(5000);
    seedMemory(root, cwd, {
      "a.md": big,
      "b.md": big,
      "c.md": big,
    });
    const block = await recallRelevantMemories({
      provider: selectorProvider("[]"),
      cwd,
      query: "load everything",
      rootDir: root,
      recallMax: 3,
    });
    expect(block).not.toBeNull();
    // Whole block stays within the total cap (+ small framing overhead).
    expect(block!.length).toBeLessThan(RECALL_TOTAL_CHARS + 500);
  });

  it("returns null when there are no topic files", async () => {
    root = mkdtempSync(join(tmpdir(), "recall-"));
    const block = await recallRelevantMemories({
      provider: selectorProvider("[]"),
      cwd,
      query: "anything",
      rootDir: root,
    });
    expect(block).toBeNull();
  });

  it("returns null for an empty query", async () => {
    root = mkdtempSync(join(tmpdir(), "recall-"));
    seedMemory(root, cwd, { "testing.md": "- [project] tests" });
    const block = await recallRelevantMemories({
      provider: selectorProvider("[]"),
      cwd,
      query: "   ",
      rootDir: root,
    });
    expect(block).toBeNull();
  });

  it("is fail-soft when the selector errors", async () => {
    root = mkdtempSync(join(tmpdir(), "recall-"));
    seedMemory(root, cwd, {
      "a.md": "- [project] one",
      "b.md": "- [project] two",
      "c.md": "- [project] three",
      "d.md": "- [project] four",
      "e.md": "- [project] five",
      "f.md": "- [project] six",
    });
    const provider: ChatProvider = {
      name: "mock",
      defaultModel: "mock",
      smallModel: "mock",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { kind: "error", message: "boom" };
      },
    };
    // 6 candidates > max 5 → selector runs, errors → returns [] → null block.
    const block = await recallRelevantMemories({
      provider,
      cwd,
      query: "pick something",
      rootDir: root,
    });
    expect(block).toBeNull();
  });
});
