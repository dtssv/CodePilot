import { describe, expect, it } from "vitest";
import {
  DoomLoopDetector,
  DedupCache,
  PATH_REFUSE_THRESHOLD,
  PATH_WARN_THRESHOLD,
  pathKey,
} from "../src/doomLoop.js";

describe("pathKey", () => {
  it("keys read_file by path, ignoring windows", () => {
    expect(pathKey("read_file", { path: "src/a.ts", startLine: 0, maxLines: 50 })).toBe(
      "read_file::path:src/a.ts",
    );
    expect(pathKey("read_file", { path: "./src/a.ts" })).toBe("read_file::path:src/a.ts");
    expect(pathKey("grep", { pattern: "x", path: "src" })).toBeNull();
  });
});

describe("DoomLoopDetector path aggregation", () => {
  it("warns then refuses repeated windowed reads of the same path", () => {
    const d = new DoomLoopDetector();
    for (let i = 0; i < PATH_WARN_THRESHOLD - 1; i++) {
      const r = d.check("read_file", { path: "f.ts", startLine: i * 100, maxLines: 100 });
      expect(r.refuse).toBe(false);
      expect(r.warn).toBe(false);
    }
    const warn = d.check("read_file", {
      path: "f.ts",
      startLine: (PATH_WARN_THRESHOLD - 1) * 100,
      maxLines: 100,
    });
    expect(warn.warn).toBe(true);
    expect(warn.refuse).toBe(false);

    for (let i = PATH_WARN_THRESHOLD; i < PATH_REFUSE_THRESHOLD - 1; i++) {
      const r = d.check("read_file", { path: "f.ts", startLine: i * 100, maxLines: 100 });
      expect(r.refuse).toBe(false);
    }
    const refuse = d.check("read_file", {
      path: "f.ts",
      startLine: (PATH_REFUSE_THRESHOLD - 1) * 100,
      maxLines: 100,
    });
    expect(refuse.refuse).toBe(true);
    expect(refuse.message).toMatch(/read_artifact/);
  });

  it("replays path-cached read_file across different windows", () => {
    const d = new DoomLoopDetector();
    d.recordResult(
      "read_file",
      { path: "big.ts" },
      { content: "full file body ".repeat(20), artifactRef: "art_abc" },
    );
    expect(d.cachedResultKind("read_file", { path: "big.ts", startLine: 10, maxLines: 20 })).toBe(
      "path",
    );
    const hit = d.cachedResult("read_file", { path: "big.ts", startLine: 10, maxLines: 20 });
    expect(hit?.artifactRef).toBe("art_abc");
    expect(hit?.content).toContain("full file body");
  });

  it("clears path cache on mutation", () => {
    const d = new DoomLoopDetector();
    d.check("read_file", { path: "a.ts" });
    d.recordResult("read_file", { path: "a.ts" }, { content: "v1" });
    d.noteMutation();
    expect(d.cachedResult("read_file", { path: "a.ts", startLine: 0 })).toBeUndefined();
  });

  it("slices the cached full read to the requested window", () => {
    const d = new DoomLoopDetector();
 // A full read_file body as the tool emits it: header + numbered lines.
    const body =
      "(5 lines, 40 bytes)\n\n" +
      ["1\talpha", "2\tbeta", "3\tgamma", "4\tdelta", "5\tepsilon"].join("\n");
    d.recordResult("read_file", { path: "big.ts" }, { content: body });

 // Windowed re-read (the post-fold recovery pattern) gets just its window.
    const hit = d.cachedResult("read_file", { path: "big.ts", startLine: 1, maxLines: 2 });
    expect(hit).toBeDefined();
    expect(hit!.content).toContain("showing lines 2-3");
    expect(hit!.content).toContain("2\tbeta");
    expect(hit!.content).toContain("3\tgamma");
    expect(hit!.content).not.toContain("4\tdelta");
    expect(hit!.content).not.toContain("1\talpha");

 // A request with no window args gets the full cached body verbatim.
    const full = d.cachedResult("read_file", { path: "big.ts" });
    expect(full!.content).toBe(body);
  });

  it("serves the whole cache when the window exceeds what was cached", () => {
    const d = new DoomLoopDetector();
    const body = "(3 lines, 12 bytes)\n\n1\ta\n2\tb\n3\tc";
    d.recordResult("read_file", { path: "s.ts" }, { content: body });
    const hit = d.cachedResult("read_file", { path: "s.ts", startLine: 10, maxLines: 5 });
    expect(hit!.content).toBe(body);
  });

  it("never caches fold stubs (would make the blind spot permanent)", () => {
    const d = new DoomLoopDetector();
    const stub =
      "[folded tool_result of read_file (900 chars) — this call already ran and you already saw its output. Do NOT re-call read_file for the same target; work from the summary below or ask the user.]\nsome head";
    d.recordResult("read_file", { path: "f.ts" }, { content: stub });
    expect(d.cachedResult("read_file", { path: "f.ts" })).toBeUndefined();
 // …but a real (non-stub) result is cached and replayed normally.
    d.recordResult("read_file", { path: "f.ts" }, { content: "(1 lines, 6 bytes)\n\n1\tconst" });
    expect(d.cachedResult("read_file", { path: "f.ts" })?.content).toContain("const");
  });

  it("refuses re-asking a question the user already answered (info is in hand)", () => {
    const d = new DoomLoopDetector();
    const q1 = { questions: [{ id: "fire", question: "如果要辞退一个人，选择谁？" }] };
 // First ask is allowed.
    expect(d.check("ask_user_question", q1).refuse).toBe(false);
 // The user answers → mark it answered.
    d.markQuestionsAnswered(q1);
 // A reworded / re-id'd / data-appended repeat of the SAME question is now
 // refused — the information is already in hand, regardless of count.
    const reAsk = d.check("ask_user_question", {
      questions: [{ id: "fire2", question: "如果要辞退一个人，你选择谁？\n\n当前数据：\n• 张三 1000\n• 李四 1091" }],
    });
    expect(reAsk.refuse).toBe(true);
    expect(reAsk.message).toMatch(/already have the user's answer|do not ask it again/i);
  });

  it("allows asking a genuinely DIFFERENT question after one was answered", () => {
    const d = new DoomLoopDetector();
    const q1 = { questions: [{ id: "fire", question: "如果要辞退一个人，选择谁？" }] };
    d.check("ask_user_question", q1);
    d.markQuestionsAnswered(q1);
 // A different question is fine — this isn't a re-ask loop.
    const q2 = d.check("ask_user_question", { questions: [{ id: "raise", question: "给谁加薪？" }] });
    expect(q2.refuse).toBe(false);
  });
});

describe("shared DedupCache across prompts", () => {
  it("a result recorded in one detector is replayed by the next when they share a cache", () => {
    const cache = new DedupCache();
 // Prompt 1: a fresh detector records a read into the shared cache.
    const d1 = new DoomLoopDetector(cache);
    d1.recordResult(
      "read_file",
      { path: "src/big.ts" },
      { content: "(1 lines, 5 bytes)\n\n1\thello", artifactRef: "art_x" },
    );
 // Prompt 2 ("继续"): a brand-new detector — counters reset — but it shares
 // the cache, so the same read is served from cache instead of re-reading.
    const d2 = new DoomLoopDetector(cache);
 // Shared cache → the read is served from cache (the whole point of the
 // fix). Identical input matches exactly; a different window would be
 // path-keyed. Either way it's a hit.
    expect(d2.cachedResultKind("read_file", { path: "src/big.ts" })).not.toBeNull();
    expect(d2.cachedResult("read_file", { path: "src/big.ts" })?.content).toContain("hello");
  });

  it("without a shared cache, a new detector does NOT see the prior read (the old per-run bug)", () => {
    const d1 = new DoomLoopDetector();
    d1.recordResult("read_file", { path: "a.ts" }, { content: "(1 lines)\n\n1\tx" });
    const d2 = new DoomLoopDetector(); // independent cache
    expect(d2.cachedResult("read_file", { path: "a.ts" })).toBeUndefined();
  });

  it("reset() clears counters but keeps the shared cache intact", () => {
    const cache = new DedupCache();
    const d = new DoomLoopDetector(cache);
    d.recordResult("read_file", { path: "k.ts" }, { content: "(1 lines)\n\n1\tv" });
    d.reset();
 // Cache survives reset (persistent across prompts); counters are cleared.
    expect(d.cachedResult("read_file", { path: "k.ts" })?.content).toContain("v");
  });
});
