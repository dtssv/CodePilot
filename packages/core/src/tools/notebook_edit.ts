// notebook_edit: edit Jupyter notebook (.ipynb) cells.
//
// Jupyter notebooks are JSON files with a `cells` array. This tool lets the
// agent manipulate individual cells by index — replace the source, change
// the cell type, insert a new cell, or delete one — without rewriting the
// entire file. This mirrors claude-code's NotebookEdit tool.
//
// The notebook is read, the requested mutation is applied to the in-memory
// cell array, and the full JSON is written back atomically. Cell IDs are
// preserved for existing cells; new cells get a generated ID.

import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, isAbsolute } from "node:path";
import type { ToolDef } from "./types.js";

// ---------------------------------------------------------------------------
// Notebook JSON types (minimal subset of nbformat v4)
// ---------------------------------------------------------------------------

interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  id: string;
  source: string[];
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const schema = z.object({
  notebook_path: z
    .string()
    .describe("Absolute or cwd-relative path to the .ipynb file."),
  cell_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Index of the cell to edit or replace (0-based). Required for " +
        "'replace' and 'delete' modes. For 'insert' mode, this is the index " +
        "BEFORE which the new cell is inserted (use cell_index = N to append " +
        "after the last cell)."
    ),
  cell_type: z
    .enum(["code", "markdown", "raw"])
    .optional()
    .describe(
      "Cell type for 'insert' and 'replace' modes. For 'replace', omit to " +
        "keep the existing cell type. For 'insert', defaults to 'code'."
    ),
  edit_mode: z
    .enum(["insert", "replace", "delete"])
    .default("replace")
    .describe(
      "'replace' (default): replace the source of the cell at cell_index. " +
        "'insert': insert a new cell before cell_index. " +
        "'delete': delete the cell at cell_index."
    ),
  new_source: z
    .string()
    .describe(
      "The new source content for the cell. For 'replace' and 'insert', " +
        "this is the full cell source (multi-line strings are fine). For " +
        "'delete', this is ignored."
    ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a path against the tool context's cwd. */
function resolvePath(p: string, cwd: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

/** Read and parse a .ipynb file. Throws on missing/invalid JSON. */
async function readNotebook(path: string): Promise<Notebook> {
  const text = await readFile(path, "utf-8");
  const nb = JSON.parse(text) as Notebook;
  if (!Array.isArray(nb.cells)) {
    throw new Error("invalid notebook: missing or non-array 'cells' field");
  }
  return nb;
}

/** Serialize a notebook back to JSON with a trailing newline. */
function serializeNotebook(nb: Notebook): string {
  return JSON.stringify(nb, null, 1) + "\n";
}

/** Split a string into the source-array format Jupyter uses (array of
 *  lines, each line includes its trailing newline except possibly the last). */
function toSourceArray(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // Jupyter stores source as an array where every element except the last
  // includes a trailing newline.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i < lines.length - 1) out.push(lines[i]! + "\n");
    else out.push(lines[i]!); // last line, no trailing newline
  }
  return out;
}

/** Join a Jupyter source array back into a single string. */
function fromSourceArray(src: string[]): string {
  return src.join("");
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const notebookEditTool: ToolDef<typeof schema> = {
  name: "notebook_edit",
  description:
    "Edit a Jupyter notebook (.ipynb) cell by index. Supports three modes:\n" +
    "  - 'replace' (default): replace the source of an existing cell.\n" +
    "  - 'insert': insert a new cell before the given index.\n" +
    "  - 'delete': delete the cell at the given index.\n\n" +
    "When to use: editing Jupyter notebooks — adding code cells, updating " +
    "markdown explanations, removing obsolete cells. The notebook's JSON " +
    "structure (cell IDs, metadata, outputs) is preserved; only the targeted " +
    "cell is affected.\n" +
    "When NOT to use: for regular source files, use `edit_file` or `write_file`. " +
    "For reading a notebook, use `read_file` (it returns the raw JSON; you can " +
    "parse the cells array yourself).\n\n" +
    "The `new_source` is the full cell content. Cell types: 'code' (executable), " +
    "'markdown' (rich text), 'raw' (literal/nbconvert).",
  inputSchema: schema,
  permission: "write",
  async execute(input, ctx) {
    const path = resolvePath(input.notebook_path, ctx.cwd);
    let nb: Notebook;
    try {
      nb = await readNotebook(path);
    } catch (err) {
      return {
        content: `Failed to read notebook: ${(err as Error).message}`,
        isError: true,
      };
    }

    const mode = input.edit_mode ?? "replace";
    const idx = input.cell_index;
    let resultMsg: string;
    let mutated = false;

    if (mode === "delete") {
      if (idx === undefined || idx < 0 || idx >= nb.cells.length) {
        return { content: `cell_index ${idx} out of range (notebook has ${nb.cells.length} cells)`, isError: true };
      }
      const removed = nb.cells.splice(idx, 1)[0]!;
      mutated = true;
      resultMsg = `Deleted cell ${idx} (type: ${removed.cell_type}, ${removed.source.length} source line(s)). Notebook now has ${nb.cells.length} cell(s).`;
    } else if (mode === "insert") {
      const insertAt = idx ?? nb.cells.length;
      if (insertAt < 0 || insertAt > nb.cells.length) {
        return { content: `cell_index ${insertAt} out of range for insert (notebook has ${nb.cells.length} cells, valid insert range 0..${nb.cells.length})`, isError: true };
      }
      const newCell: NotebookCell = {
        cell_type: input.cell_type ?? "code",
        id: randomUUID(),
        source: toSourceArray(input.new_source),
        metadata: {},
      };
      if (newCell.cell_type === "code") {
        newCell.outputs = [];
        newCell.execution_count = null;
      }
      nb.cells.splice(insertAt, 0, newCell);
      mutated = true;
      resultMsg = `Inserted ${newCell.cell_type} cell at index ${insertAt} (id: ${newCell.id}). Notebook now has ${nb.cells.length} cell(s).`;
    } else {
      // mode === "replace"
      if (idx === undefined || idx < 0 || idx >= nb.cells.length) {
        return { content: `cell_index ${idx} out of range (notebook has ${nb.cells.length} cells)`, isError: true };
      }
      const cell = nb.cells[idx]!;
      const oldType = cell.cell_type;
      if (input.cell_type) {
        cell.cell_type = input.cell_type;
        if (input.cell_type === "code" && !cell.outputs) {
          cell.outputs = [];
          cell.execution_count = null;
        } else if (input.cell_type !== "code") {
          delete cell.outputs;
          delete cell.execution_count;
        }
      }
      const oldLen = cell.source.length;
      cell.source = toSourceArray(input.new_source);
      const typeChanged = oldType !== cell.cell_type;
      mutated = true;
      resultMsg =
        `Replaced cell ${idx} source (${oldLen} → ${cell.source.length} line(s))` +
        (typeChanged ? `, changed type ${oldType} → ${cell.cell_type}` : "") +
        `. Notebook has ${nb.cells.length} cell(s).`;
    }

    if (mutated) {
      try {
        await writeFile(path, serializeNotebook(nb), "utf-8");
      } catch (err) {
        return { content: `Cell edited in memory but failed to write notebook: ${(err as Error).message}`, isError: true };
      }
    }
    return { content: resultMsg };
  },
};

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { toSourceArray, fromSourceArray, readNotebook, serializeNotebook };
export type { Notebook, NotebookCell };
