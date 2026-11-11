// Execution-reliability guards: read-before-write + staleness (FileObservationStore),
// CRLF preservation.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileObservationStore, hashFileContent } from "../src/fsObservation.js";
import { detectLineEnding, editFileTool, applyEdit } from "../src/tools/edit_file.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { readFileTool } from "../src/tools/read_file.js";
import { notebookEditTool } from "../src/tools/notebook_edit.js";
import type { ToolContext } from "../src/tools/types.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cp-exec-rel-"));
}

/** Build a ToolContext backed by a real FileObservationStore. */
function ctxWith(dir: string, store: FileObservationStore): ToolContext {
  return {
    cwd: dir,
    artifact: async () => "art_test",
    readArtifact: async () => "",
    observeFile: (p, s, h) => store.observe(p, s, h),
    checkFileFresh: (p, s, h) => store.checkFresh(p, s, h),
    reobserveFile: (p, s, h) => store.reobserveAfterWrite(p, s, h),
  } as ToolContext;
}

describe("FileObservationStore (read-before-write + staleness)", () => {
  it("allows creating a new file (no prior observation needed)", () => {
    const store = new FileObservationStore();
    expect(store.checkFresh("/x/new.ts", null)).toEqual({ ok: true });
  });

  it("blocks editing an unobserved existing file", () => {
    const store = new FileObservationStore();
    const res = store.checkFresh("/x/a.ts", { mtimeMs: 1, size: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unobserved");
  });

  it("allows editing an observed, unchanged file", () => {
    const store = new FileObservationStore();
    store.observe("/x/a.ts", { mtimeMs: 100, size: 10 });
    expect(store.checkFresh("/x/a.ts", { mtimeMs: 100, size: 10 })).toEqual({ ok: true });
  });

  it("blocks a stale edit (file changed since read)", () => {
    const store = new FileObservationStore();
    store.observe("/x/a.ts", { mtimeMs: 100, size: 10 });
    const res = store.checkFresh("/x/a.ts", { mtimeMs: 200, size: 12 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("stale");
  });

  it("allows a stale-looking edit when the content hash is unchanged (false mtime)", () => {
    const store = new FileObservationStore();
    const hash = hashFileContent(Buffer.from("const x = 1;\n", "utf-8"));
    // Observed with a content hash; mtime later jitters but size stays.
    store.observe("/x/a.ts", { mtimeMs: 100, size: 13 }, hash);
    // mtime moved (would be stale by mtime), but the current content hashes the
    // same → rescued to ok.
    expect(
      store.checkFresh("/x/a.ts", { mtimeMs: 500, size: 13 }, hash),
    ).toEqual({ ok: true });
  });

  it("still blocks when the content hash actually differs", () => {
    const store = new FileObservationStore();
    const oldHash = hashFileContent(Buffer.from("const x = 1;\n", "utf-8"));
    const newHash = hashFileContent(Buffer.from("const x = 2;\n", "utf-8"));
    store.observe("/x/a.ts", { mtimeMs: 100, size: 13 }, oldHash);
    const res = store.checkFresh("/x/a.ts", { mtimeMs: 500, size: 13 }, newHash);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("stale");
  });

  it("keeps the mtime/size decision when no hash was recorded (older observation)", () => {
    const store = new FileObservationStore();
    // Observed without a content hash.
    store.observe("/x/a.ts", { mtimeMs: 100, size: 10 });
    // Even if a current hash is offered, there is nothing to compare against →
    // stale verdict stands.
    const res = store.checkFresh("/x/a.ts", { mtimeMs: 200, size: 10 }, "f:deadbeef");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("stale");
  });
});

describe("hashFileContent", () => {
  it("is stable for identical content and differs for changed content", () => {
    const a = hashFileContent(Buffer.from("hello world", "utf-8"));
    const b = hashFileContent(Buffer.from("hello world", "utf-8"));
    const c = hashFileContent(Buffer.from("hello worlD", "utf-8"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("samples large files (size + head + tail) rather than hashing in full", () => {
    const big = Buffer.alloc(512 * 1024, 0x41); // 512 KiB of 'A'
    const h = hashFileContent(big);
    expect(h.startsWith("s:")).toBe(true);
    // A change only in the middle (between the sampled ends) is not detected —
    // the sampling is an intentional cost/coverage tradeoff for huge files.
    const middleChanged = Buffer.from(big);
    middleChanged[256 * 1024] = 0x42;
    expect(hashFileContent(middleChanged)).toBe(h);
    // A change within the head sample IS detected.
    const headChanged = Buffer.from(big);
    headChanged[0] = 0x42;
    expect(hashFileContent(headChanged)).not.toBe(h);
  });
});

describe("edit_file read-before-write guard (end to end)", () => {
  it("refuses to edit a file never read this session", async () => {
    const dir = tmp();
    const p = join(dir, "a.ts");
    writeFileSync(p, "const x = 1;\n");
    const store = new FileObservationStore();
    const res = await editFileTool.execute(
      { path: "a.ts", search: "const x = 1;", replace: "const x = 2;" },
      ctxWith(dir, store),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not read it in this session/);
    // File untouched.
    expect(readFileSync(p, "utf-8")).toBe("const x = 1;\n");
  });

  it("allows the edit after read_file observed it", async () => {
    const dir = tmp();
    const p = join(dir, "a.ts");
    writeFileSync(p, "const x = 1;\n");
    const store = new FileObservationStore();
    const ctx = ctxWith(dir, store);
    await readFileTool.execute({ path: "a.ts" }, ctx);
    const res = await editFileTool.execute(
      { path: "a.ts", search: "const x = 1;", replace: "const x = 2;" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(readFileSync(p, "utf-8")).toBe("const x = 2;\n");
  });

  it("blocks a stale edit when the file changed after read", async () => {
    const dir = tmp();
    const p = join(dir, "a.ts");
    writeFileSync(p, "const x = 1;\n");
    const store = new FileObservationStore();
    const ctx = ctxWith(dir, store);
    await readFileTool.execute({ path: "a.ts" }, ctx);
    // Simulate an external change (different size + mtime).
    writeFileSync(p, "const x = 1;\nconst y = 9;\n");
    const res = await editFileTool.execute(
      { path: "a.ts", search: "const x = 1;", replace: "const x = 2;" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/changed on disk/);
  });

  it("allows the edit when only mtime moved but content is identical", async () => {
    const dir = tmp();
    const p = join(dir, "a.ts");
    writeFileSync(p, "const x = 1;\n");
    const store = new FileObservationStore();
    const ctx = ctxWith(dir, store);
    await readFileTool.execute({ path: "a.ts" }, ctx);
    // Rewrite identical bytes and bump the mtime far into the future — the
    // mtime gate would flag stale, but the content hash rescues it.
    const future = new Date(Date.now() + 60_000);
    writeFileSync(p, "const x = 1;\n");
    const { utimesSync } = await import("node:fs");
    utimesSync(p, future, future);
    const res = await editFileTool.execute(
      { path: "a.ts", search: "const x = 1;", replace: "const x = 2;" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(readFileSync(p, "utf-8")).toBe("const x = 2;\n");
  });
});

describe("write_file overwrite guard", () => {
  it("allows creating a new file", async () => {
    const dir = tmp();
    const store = new FileObservationStore();
    const res = await writeFileTool.execute(
      { path: "new.ts", content: "x\n" },
      ctxWith(dir, store),
    );
    expect(res.isError).toBeUndefined();
  });

  it("blocks overwriting an existing, unread file", async () => {
    const dir = tmp();
    const p = join(dir, "a.ts");
    writeFileSync(p, "old\n");
    const store = new FileObservationStore();
    const res = await writeFileTool.execute(
      { path: "a.ts", content: "new\n" },
      ctxWith(dir, store),
    );
    expect(res.isError).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("old\n");
  });

  it("allows an overwrite when only mtime moved but content is identical (lazy reader)", async () => {
    const dir = tmp();
    const p = join(dir, "a.ts");
    writeFileSync(p, "old\n");
    const store = new FileObservationStore();
    const ctx = ctxWith(dir, store);
    await readFileTool.execute({ path: "a.ts" }, ctx);
    // Identical bytes, future mtime → mtime gate would flag stale; the lazy
    // content read rescues it and the overwrite proceeds.
    const future = new Date(Date.now() + 60_000);
    writeFileSync(p, "old\n");
    const { utimesSync } = await import("node:fs");
    utimesSync(p, future, future);
    const res = await writeFileTool.execute({ path: "a.ts", content: "new\n" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(readFileSync(p, "utf-8")).toBe("new\n");
  });
});

describe("notebook_edit read-before-write + staleness guard", () => {
  const nb = (cells: number) =>
    JSON.stringify({
      cells: Array.from({ length: cells }, (_, i) => ({
        cell_type: "code",
        id: `c${i}`,
        source: [`x = ${i}\n`],
        metadata: {},
        outputs: [],
        execution_count: null,
      })),
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }) + "\n";

  it("refuses to edit a notebook never read this session (index edits are the most memory-dependent)", async () => {
    const dir = tmp();
    const p = join(dir, "n.ipynb");
    writeFileSync(p, nb(2));
    const store = new FileObservationStore();
    const res = await notebookEditTool.execute(
      { notebook_path: "n.ipynb", cell_index: 0, edit_mode: "replace", new_source: "x = 99" },
      ctxWith(dir, store),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not read it in this session/);
    expect(readFileSync(p, "utf-8")).toBe(nb(2)); // untouched
  });

  it("allows the edit after read_file observed it", async () => {
    const dir = tmp();
    const p = join(dir, "n.ipynb");
    writeFileSync(p, nb(2));
    const store = new FileObservationStore();
    const ctx = ctxWith(dir, store);
    await readFileTool.execute({ path: "n.ipynb" }, ctx);
    const res = await notebookEditTool.execute(
      { notebook_path: "n.ipynb", cell_index: 0, edit_mode: "replace", new_source: "x = 99" },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(readFileSync(p, "utf-8")).toMatch(/x = 99/);
  });

  it("blocks a stale edit when the notebook changed after read", async () => {
    const dir = tmp();
    const p = join(dir, "n.ipynb");
    writeFileSync(p, nb(2));
    const store = new FileObservationStore();
    const ctx = ctxWith(dir, store);
    await readFileTool.execute({ path: "n.ipynb" }, ctx);
    // External change: a cell was inserted/removed, so cell_index now points
    // at a different cell than the one the agent saw.
    writeFileSync(p, nb(3));
    const res = await notebookEditTool.execute(
      { notebook_path: "n.ipynb", cell_index: 0, edit_mode: "delete" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/changed on disk/);
  });

  it("re-observes after its own write so a second edit in the same session is not stale", async () => {
    const dir = tmp();
    const p = join(dir, "n.ipynb");
    writeFileSync(p, nb(2));
    const store = new FileObservationStore();
    const ctx = ctxWith(dir, store);
    await readFileTool.execute({ path: "n.ipynb" }, ctx);
    const first = await notebookEditTool.execute(
      { notebook_path: "n.ipynb", cell_index: 0, edit_mode: "replace", new_source: "x = 11" },
      ctx,
    );
    expect(first.isError).toBeFalsy();
    const second = await notebookEditTool.execute(
      { notebook_path: "n.ipynb", cell_index: 1, edit_mode: "replace", new_source: "x = 22" },
      ctx,
    );
    expect(second.isError).toBeFalsy();
    expect(readFileSync(p, "utf-8")).toMatch(/x = 22/);
  });
});

describe("CRLF preservation (G3)", () => {
  it("detectLineEnding picks the dominant ending", () => {
    expect(detectLineEnding("a\r\nb\r\nc")).toBe("\r\n");
    expect(detectLineEnding("a\nb\nc")).toBe("\n");
  });

  it("edit_file keeps CRLF line endings on write", async () => {
    const dir = tmp();
    const p = join(dir, "crlf.txt");
    writeFileSync(p, "alpha\r\nbeta\r\ngamma\r\n");
    const store = new FileObservationStore();
    const ctx = ctxWith(dir, store);
    await readFileTool.execute({ path: "crlf.txt" }, ctx);
    const res = await editFileTool.execute(
      { path: "crlf.txt", search: "beta", replace: "BETA" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const out = readFileSync(p, "utf-8");
    expect(out).toBe("alpha\r\nBETA\r\ngamma\r\n");
    expect(out.includes("\r\n")).toBe(true);
  });

  it("applyEdit itself normalises to \\n (restore happens in the tool)", () => {
    const r = applyEdit("a\r\nb\r\n", { search: "b", replace: "B" });
    expect(r.ok).toBe(true);
  });
});
