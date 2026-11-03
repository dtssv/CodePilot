// Execution-reliability guards: read-before-write + staleness (FileObservationStore),
// CRLF preservation, and citation grounding (citationGuard).

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileObservationStore } from "../src/fsObservation.js";
import { detectLineEnding, editFileTool, applyEdit } from "../src/tools/edit_file.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { readFileTool } from "../src/tools/read_file.js";
import { notebookEditTool } from "../src/tools/notebook_edit.js";
import {
  checkCitations,
  extractCitations,
  observedPaths,
  buildCitationNotice,
} from "../src/citationGuard.js";
import { isWaitingForUser } from "../src/agent.js";
import type { ToolContext } from "../src/tools/types.js";
import type { Event } from "../src/types.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cp-exec-rel-"));
}

/** Build a ToolContext backed by a real FileObservationStore. */
function ctxWith(dir: string, store: FileObservationStore): ToolContext {
  return {
    cwd: dir,
    artifact: async () => "art_test",
    readArtifact: async () => "",
    observeFile: (p, s) => store.observe(p, s),
    checkFileFresh: (p, s) => store.checkFresh(p, s),
    reobserveFile: (p, s) => store.reobserveAfterWrite(p, s),
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

describe("citationGuard (H5)", () => {
  const readEvt = (path: string): Event => ({
    type: "tool_call",
    id: "t1",
    name: "read_file",
    input: { path },
  });

  it("extracts path:line citations", () => {
    const cites = extractCitations("See src/agent.ts:42 and ./pkg/b.rs:9-20.");
    expect(cites.map((c) => c.path)).toContain("src/agent.ts");
    expect(cites.map((c) => c.path)).toContain("pkg/b.rs");
  });

  it("flags a citation to a file never observed", () => {
    const events = [readEvt("src/agent.ts")];
    const check = checkCitations("src/agent.ts:1 and src/ghost.ts:99 are relevant.", events);
    expect(check.unverified.map((c) => c.path)).toEqual(["src/ghost.ts"]);
  });

  it("clears a citation whose file was read (suffix match)", () => {
    const events = [readEvt("/abs/root/src/agent.ts")];
    const check = checkCitations("src/agent.ts:10 matters.", events);
    expect(check.unverified).toHaveLength(0);
  });

  it("observedPaths collects apply_patch targets", () => {
    const ev: Event = {
      type: "tool_call",
      id: "t2",
      name: "apply_patch",
      input: { patch: "*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch" },
    };
    expect(observedPaths([ev]).has("src/x.ts")).toBe(true);
  });

  it("clears a citation under a grep/glob search root", () => {
    // grep/glob record the search path/pattern; a citation nested under that
    // root counts as plausibly seen (isObserved directory-root branch).
    const globEvt: Event = { type: "tool_call", id: "g1", name: "glob", input: { pattern: "src/**/*.ts" } };
    const grepEvt: Event = { type: "tool_call", id: "g2", name: "grep", input: { path: "packages/core" } };
    const check = checkCitations("src/deep/nested/file.ts:12 and packages/core/agent.ts:40.", [globEvt, grepEvt]);
    expect(check.unverified).toHaveLength(0);
  });

  it("clears a citation by shared basename (relative vs absolute)", () => {
    // Model wrote a bare basename for a file we opened by absolute path.
    const events = [readEvt("/abs/root/pkg/widget.ts")];
    const check = checkCitations("See widget.ts:5 for the bug.", events);
    expect(check.unverified).toHaveLength(0);
  });

  it("buildCitationNotice returns null when nothing unverified", () => {
    expect(buildCitationNotice({ unverified: [] })).toBeNull();
  });

  it("builds a notice listing unverified citations", () => {
    const notice = buildCitationNotice({
      unverified: [{ raw: "src/ghost.ts:99", path: "src/ghost.ts" }],
    });
    expect(notice).toMatch(/src\/ghost\.ts:99/);
    expect(notice).toMatch(/NOT backed by/);
  });

  // Loop gating (agent.ts:976-990): the citation nudge fires only when the
  // model is NOT asking the user a question — a question is not a factual
  // claim, so an unverified path in it must not trigger a retract-or-verify
  // nudge. This models the exact `!isWaitingForUser(trimmed)` guard.
  it("does not nudge when the final text is a question to the user", () => {
    const events = [readEvt("src/agent.ts")];
    const askingText = "Which file should I patch, src/ghost.ts:99 or the other one?";
    const notice = buildCitationNotice(checkCitations(askingText, events));
    // A notice exists (the citation is unverified)…
    expect(notice).not.toBeNull();
    // …but the loop would suppress it because the turn is a question.
    const wouldNudge = notice !== null && !isWaitingForUser(askingText);
    expect(wouldNudge).toBe(false);
  });

  it("nudges on a factual claim with an unverified citation (not a question)", () => {
    const events = [readEvt("src/agent.ts")];
    const claimText = "The bug is in src/ghost.ts:99.";
    const notice = buildCitationNotice(checkCitations(claimText, events));
    const wouldNudge = notice !== null && !isWaitingForUser(claimText);
    expect(wouldNudge).toBe(true);
  });
});
