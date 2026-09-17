import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  toSourceArray,
  fromSourceArray,
  readNotebook,
  serializeNotebook,
  notebookEditTool,
  type Notebook,
  type NotebookCell,
} from "../src/tools/notebook_edit.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(cwd: string) {
  return {
    cwd,
    signal: undefined,
    async artifact() {
      return "art_x";
    },
    async readArtifact() {
      return "";
    },
  };
}

function makeNotebook(cells: Partial<NotebookCell>[] = []): Notebook {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "python3" } },
    cells: cells.map((c, i) => ({
      cell_type: "code",
      id: `cell-${i}`,
      source: [],
      metadata: {},
      outputs: [],
      execution_count: null,
      ...c,
    })),
  };
}

// ---------------------------------------------------------------------------
// toSourceArray / fromSourceArray
// ---------------------------------------------------------------------------

describe("toSourceArray / fromSourceArray", () => {
  it("empty string roundtrips", () => {
    const arr = toSourceArray("");
    expect(arr).toEqual([]);
    expect(fromSourceArray(arr)).toBe("");
  });

  it("single line without trailing newline roundtrips", () => {
    const arr = toSourceArray("hello");
    expect(arr).toEqual(["hello"]);
    expect(fromSourceArray(arr)).toBe("hello");
  });

  it("single line with trailing newline roundtrips", () => {
    const arr = toSourceArray("hello\n");
    expect(arr).toEqual(["hello\n", ""]);
    expect(fromSourceArray(arr)).toBe("hello\n");
  });

  it("multi-line roundtrips", () => {
    const text = "line one\nline two\nline three";
    const arr = toSourceArray(text);
    expect(arr).toEqual(["line one\n", "line two\n", "line three"]);
    expect(fromSourceArray(arr)).toBe(text);
  });

  it("multi-line with trailing newline roundtrips", () => {
    const text = "a\nb\n";
    const arr = toSourceArray(text);
    expect(arr).toEqual(["a\n", "b\n", ""]);
    expect(fromSourceArray(arr)).toBe(text);
  });

  it("preserves blank lines", () => {
    const text = "a\n\nb";
    const arr = toSourceArray(text);
    expect(arr).toEqual(["a\n", "\n", "b"]);
    expect(fromSourceArray(arr)).toBe(text);
  });

  it("fromSourceArray joins array verbatim", () => {
    expect(fromSourceArray(["x\n", "y"])).toBe("x\ny");
    expect(fromSourceArray([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// readNotebook
// ---------------------------------------------------------------------------

describe("readNotebook", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nb-read-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a valid notebook", async () => {
    const nb = makeNotebook([
      { cell_type: "code", source: ["print(1)\n"], id: "abc" },
      { cell_type: "markdown", source: ["# Title"], id: "def" },
    ]);
    const file = join(dir, "test.ipynb");
    writeFileSync(file, JSON.stringify(nb), "utf-8");

    const parsed = await readNotebook(file);
    expect(parsed.cells).toHaveLength(2);
    expect(parsed.cells[0]!.cell_type).toBe("code");
    expect(parsed.cells[1]!.cell_type).toBe("markdown");
    expect(parsed.nbformat).toBe(4);
  });

  it("throws on invalid JSON", async () => {
    const file = join(dir, "bad.ipynb");
    writeFileSync(file, "this is not json{{{", "utf-8");
    await expect(readNotebook(file)).rejects.toThrow();
  });

  it("throws when cells array is missing", async () => {
    const file = join(dir, "nocells.ipynb");
    writeFileSync(file, JSON.stringify({ nbformat: 4, metadata: {} }), "utf-8");
    await expect(readNotebook(file)).rejects.toThrow(/cells/);
  });

  it("throws when cells is not an array", async () => {
    const file = join(dir, "badcells.ipynb");
    writeFileSync(
      file,
      JSON.stringify({ nbformat: 4, metadata: {}, cells: "nope" }),
      "utf-8"
    );
    await expect(readNotebook(file)).rejects.toThrow(/cells/);
  });

  it("throws on missing file", async () => {
    await expect(readNotebook(join(dir, "ghost.ipynb"))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// serializeNotebook
// ---------------------------------------------------------------------------

describe("serializeNotebook", () => {
  it("roundtrips through JSON.parse", () => {
    const nb = makeNotebook([
      { cell_type: "code", source: ["x = 1\n"], id: "c1" },
    ]);
    const text = serializeNotebook(nb);
    const parsed = JSON.parse(text) as Notebook;
    expect(parsed.cells).toHaveLength(1);
    expect(parsed.cells[0]!.id).toBe("c1");
    expect(parsed.nbformat).toBe(4);
    expect(parsed.metadata).toEqual({ kernelspec: { name: "python3" } });
  });

  it("ends with a trailing newline", () => {
    const nb = makeNotebook([]);
    const text = serializeNotebook(nb);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("serializes an empty notebook", () => {
    const nb = makeNotebook([]);
    const text = serializeNotebook(nb);
    expect(JSON.parse(text).cells).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// notebookEditTool.execute
// ---------------------------------------------------------------------------

describe("notebookEditTool.execute", () => {
  let dir: string;
  let file: string;

  function writeNb(nb: Notebook) {
    writeFileSync(file, serializeNotebook(nb), "utf-8");
  }

  function readNb(): Notebook {
    return JSON.parse(readFileSync(file, "utf-8")) as Notebook;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nb-edit-"));
    file = join(dir, "test.ipynb");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ----- replace mode -----

  it("replace mode changes the cell source", async () => {
    writeNb(
      makeNotebook([
        { cell_type: "code", source: ["old = 1\n"], id: "c0" },
        { cell_type: "markdown", source: ["# Keep\n"], id: "c1" },
      ])
    );
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 0, edit_mode: "replace", new_source: "new = 2" },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Replaced cell 0/);

    const nb = readNb();
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[0]!.source).toEqual(["new = 2"]);
    expect(nb.cells[0]!.id).toBe("c0"); // ID preserved
    expect(nb.cells[1]!.source).toEqual(["# Keep\n"]); // other cell untouched
  });

  it("replace mode keeps the cell type when cell_type is omitted", async () => {
    writeNb(
      makeNotebook([
        { cell_type: "markdown", source: ["old\n"], id: "c0" },
      ])
    );
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 0, edit_mode: "replace", new_source: "new" },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    const nb = readNb();
    expect(nb.cells[0]!.cell_type).toBe("markdown");
    expect(nb.cells[0]!.source).toEqual(["new"]);
  });

  it("replace mode changes the cell type and strips code-only fields", async () => {
    writeNb(
      makeNotebook([
        {
          cell_type: "code",
          source: ["print(1)\n"],
          id: "c0",
          outputs: [{ output_type: "stream", text: "1\n" }],
          execution_count: 3,
        },
      ])
    );
    const r = await notebookEditTool.execute(
      {
        notebook_path: file,
        cell_index: 0,
        edit_mode: "replace",
        cell_type: "markdown",
        new_source: "# heading",
      },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/changed type code → markdown/);

    const nb = readNb();
    expect(nb.cells[0]!.cell_type).toBe("markdown");
    expect(nb.cells[0]!.source).toEqual(["# heading"]);
    expect(nb.cells[0]!.outputs).toBeUndefined();
    expect(nb.cells[0]!.execution_count).toBeUndefined();
  });

  it("replace mode adds code-only fields when changing to code", async () => {
    writeNb(
      makeNotebook([
        { cell_type: "markdown", source: ["# t\n"], id: "c0" },
      ])
    );
    // remove outputs/execution_count from the markdown cell on disk
    const onDisk = readNb();
    delete onDisk.cells[0]!.outputs;
    delete onDisk.cells[0]!.execution_count;
    writeNb(onDisk);

    const r = await notebookEditTool.execute(
      {
        notebook_path: file,
        cell_index: 0,
        edit_mode: "replace",
        cell_type: "code",
        new_source: "x = 1",
      },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    const nb = readNb();
    expect(nb.cells[0]!.cell_type).toBe("code");
    expect(nb.cells[0]!.outputs).toEqual([]);
    expect(nb.cells[0]!.execution_count).toBeNull();
  });

  it("replace mode defaults when edit_mode is omitted", async () => {
    writeNb(
      makeNotebook([{ cell_type: "code", source: ["old\n"], id: "c0" }])
    );
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 0, new_source: "replaced" },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    expect(readNb().cells[0]!.source).toEqual(["replaced"]);
  });

  it("replace mode handles multi-line source", async () => {
    writeNb(
      makeNotebook([{ cell_type: "code", source: ["old\n"], id: "c0" }])
    );
    const src = "line1\nline2\nline3";
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 0, edit_mode: "replace", new_source: src },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    expect(readNb().cells[0]!.source).toEqual(toSourceArray(src));
  });

  // ----- insert mode -----

  it("insert mode inserts at the beginning", async () => {
    writeNb(
      makeNotebook([
        { cell_type: "code", source: ["a\n"], id: "c0" },
        { cell_type: "code", source: ["b\n"], id: "c1" },
      ])
    );
    const r = await notebookEditTool.execute(
      {
        notebook_path: file,
        cell_index: 0,
        edit_mode: "insert",
        new_source: "first",
        cell_type: "markdown",
      },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Inserted markdown cell at index 0/);

    const nb = readNb();
    expect(nb.cells).toHaveLength(3);
    expect(nb.cells[0]!.cell_type).toBe("markdown");
    expect(nb.cells[0]!.source).toEqual(["first"]);
    expect(nb.cells[0]!.id).toBeTruthy();
    expect(nb.cells[0]!.id).not.toBe("c0");
    // Markdown cells should not have outputs
    expect(nb.cells[0]!.outputs).toBeUndefined();
    expect(nb.cells[1]!.id).toBe("c0");
    expect(nb.cells[2]!.id).toBe("c1");
  });

  it("insert mode inserts in the middle", async () => {
    writeNb(
      makeNotebook([
        { cell_type: "code", source: ["a\n"], id: "c0" },
        { cell_type: "code", source: ["b\n"], id: "c1" },
      ])
    );
    const r = await notebookEditTool.execute(
      {
        notebook_path: file,
        cell_index: 1,
        edit_mode: "insert",
        new_source: "middle",
      },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();

    const nb = readNb();
    expect(nb.cells).toHaveLength(3);
    expect(nb.cells[0]!.id).toBe("c0");
    expect(nb.cells[1]!.source).toEqual(["middle"]);
    expect(nb.cells[1]!.cell_type).toBe("code"); // defaults to code
    // New code cells get outputs and execution_count
    expect(nb.cells[1]!.outputs).toEqual([]);
    expect(nb.cells[1]!.execution_count).toBeNull();
    expect(nb.cells[2]!.id).toBe("c1");
  });

  it("insert mode appends at the end (cell_index = length)", async () => {
    writeNb(
      makeNotebook([
        { cell_type: "code", source: ["a\n"], id: "c0" },
        { cell_type: "code", source: ["b\n"], id: "c1" },
      ])
    );
    const r = await notebookEditTool.execute(
      {
        notebook_path: file,
        cell_index: 2,
        edit_mode: "insert",
        new_source: "last",
      },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();

    const nb = readNb();
    expect(nb.cells).toHaveLength(3);
    expect(nb.cells[0]!.id).toBe("c0");
    expect(nb.cells[1]!.id).toBe("c1");
    expect(nb.cells[2]!.source).toEqual(["last"]);
  });

  it("insert mode appends when cell_index is omitted", async () => {
    writeNb(
      makeNotebook([{ cell_type: "code", source: ["a\n"], id: "c0" }])
    );
    const r = await notebookEditTool.execute(
      { notebook_path: file, edit_mode: "insert", new_source: "appended" },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();

    const nb = readNb();
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[1]!.source).toEqual(["appended"]);
  });

  it("insert mode into an empty notebook", async () => {
    writeNb(makeNotebook([]));
    const r = await notebookEditTool.execute(
      {
        notebook_path: file,
        cell_index: 0,
        edit_mode: "insert",
        new_source: "x = 1",
        cell_type: "code",
      },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();

    const nb = readNb();
    expect(nb.cells).toHaveLength(1);
    expect(nb.cells[0]!.source).toEqual(["x = 1"]);
    expect(nb.cells[0]!.outputs).toEqual([]);
    expect(nb.cells[0]!.execution_count).toBeNull();
  });

  // ----- delete mode -----

  it("delete mode removes the cell at the index", async () => {
    writeNb(
      makeNotebook([
        { cell_type: "code", source: ["a\n"], id: "c0" },
        { cell_type: "markdown", source: ["b\n"], id: "c1" },
        { cell_type: "code", source: ["c\n"], id: "c2" },
      ])
    );
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 1, edit_mode: "delete", new_source: "" },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Deleted cell 1/);
    expect(r.content).toMatch(/markdown/);

    const nb = readNb();
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[0]!.id).toBe("c0");
    expect(nb.cells[1]!.id).toBe("c2");
  });

  it("delete mode removes the first cell", async () => {
    writeNb(
      makeNotebook([
        { cell_type: "code", source: ["a\n"], id: "c0" },
        { cell_type: "code", source: ["b\n"], id: "c1" },
      ])
    );
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 0, edit_mode: "delete", new_source: "" },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    const nb = readNb();
    expect(nb.cells).toHaveLength(1);
    expect(nb.cells[0]!.id).toBe("c1");
  });

  it("delete mode removes the last cell", async () => {
    writeNb(
      makeNotebook([
        { cell_type: "code", source: ["a\n"], id: "c0" },
        { cell_type: "code", source: ["b\n"], id: "c1" },
      ])
    );
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 1, edit_mode: "delete", new_source: "" },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    const nb = readNb();
    expect(nb.cells).toHaveLength(1);
    expect(nb.cells[0]!.id).toBe("c0");
  });

  // ----- out-of-range errors -----

  it("replace mode errors on out-of-range cell_index", async () => {
    writeNb(makeNotebook([{ cell_type: "code", source: ["a\n"], id: "c0" }]));
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 5, edit_mode: "replace", new_source: "x" },
      makeCtx(dir)
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/out of range/);
  });

  it("replace mode errors when cell_index is missing", async () => {
    writeNb(makeNotebook([{ cell_type: "code", source: ["a\n"], id: "c0" }]));
    const r = await notebookEditTool.execute(
      { notebook_path: file, edit_mode: "replace", new_source: "x" },
      makeCtx(dir)
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/out of range/);
  });

  it("delete mode errors on out-of-range cell_index", async () => {
    writeNb(makeNotebook([{ cell_type: "code", source: ["a\n"], id: "c0" }]));
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 1, edit_mode: "delete", new_source: "" },
      makeCtx(dir)
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/out of range/);
  });

  it("delete mode errors on empty notebook", async () => {
    writeNb(makeNotebook([]));
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 0, edit_mode: "delete", new_source: "" },
      makeCtx(dir)
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/out of range/);
  });

  it("insert mode errors when cell_index exceeds length", async () => {
    writeNb(makeNotebook([{ cell_type: "code", source: ["a\n"], id: "c0" }]));
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 5, edit_mode: "insert", new_source: "x" },
      makeCtx(dir)
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/out of range for insert/);
  });

  it("replace mode errors on negative cell_index handled by schema, but raw call also errors", async () => {
    writeNb(makeNotebook([{ cell_type: "code", source: ["a\n"], id: "c0" }]));
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: -1, edit_mode: "replace", new_source: "x" },
      makeCtx(dir)
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/out of range/);
  });

  // ----- file-level errors -----

  it("returns isError for a missing notebook file", async () => {
    const r = await notebookEditTool.execute(
      {
        notebook_path: join(dir, "nope.ipynb"),
        cell_index: 0,
        edit_mode: "replace",
        new_source: "x",
      },
      makeCtx(dir)
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Failed to read notebook/);
  });

  it("returns isError for invalid JSON", async () => {
    writeFileSync(file, "{{{{ not json", "utf-8");
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 0, edit_mode: "replace", new_source: "x" },
      makeCtx(dir)
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Failed to read notebook/);
  });

  it("returns isError for notebook with missing cells array", async () => {
    writeFileSync(file, JSON.stringify({ nbformat: 4 }), "utf-8");
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 0, edit_mode: "replace", new_source: "x" },
      makeCtx(dir)
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Failed to read notebook/);
  });

  // ----- misc -----

  it("resolves relative paths against ctx.cwd", async () => {
    writeNb(makeNotebook([{ cell_type: "code", source: ["a\n"], id: "c0" }]));
    const r = await notebookEditTool.execute(
      { notebook_path: "test.ipynb", cell_index: 0, edit_mode: "replace", new_source: "rel" },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    expect(readNb().cells[0]!.source).toEqual(["rel"]);
  });

  it("preserves cell IDs of untouched cells after edit", async () => {
    writeNb(
      makeNotebook([
        { cell_type: "code", source: ["a\n"], id: "keep-a" },
        { cell_type: "code", source: ["b\n"], id: "keep-b" },
        { cell_type: "code", source: ["c\n"], id: "keep-c" },
      ])
    );
    const r = await notebookEditTool.execute(
      { notebook_path: file, cell_index: 1, edit_mode: "replace", new_source: "B" },
      makeCtx(dir)
    );
    expect(r.isError).toBeFalsy();
    const nb = readNb();
    expect(nb.cells[0]!.id).toBe("keep-a");
    expect(nb.cells[1]!.id).toBe("keep-b");
    expect(nb.cells[2]!.id).toBe("keep-c");
  });

  it("written file ends with a trailing newline", async () => {
    writeNb(makeNotebook([{ cell_type: "code", source: ["a\n"], id: "c0" }]));
    await notebookEditTool.execute(
      { notebook_path: file, cell_index: 0, edit_mode: "replace", new_source: "x" },
      makeCtx(dir)
    );
    const raw = readFileSync(file, "utf-8");
    expect(raw.endsWith("}\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe("notebookEditTool metadata", () => {
  it("has write permission", () => {
    expect(notebookEditTool.permission).toBe("write");
  });

  it("is named notebook_edit", () => {
    expect(notebookEditTool.name).toBe("notebook_edit");
  });
});
