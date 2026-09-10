// Tests for the upgraded file tools: read_file line numbers + binary
// detection, edit_file multi-edit transactionality, write_file guards.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileTool } from "../src/tools/read_file.js";
import { editFileTool } from "../src/tools/edit_file.js";
import { writeFileTool } from "../src/tools/write_file.js";
import { resolveSandbox } from "../src/sandbox.js";
import type { ToolContext } from "../src/tools/types.js";

let dir: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: dir,
    artifact: async () => "art_deadbeef",
    readArtifact: async () => "",
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cptools-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("read_file", () => {
  it("renders cat -n style line numbers", async () => {
    await writeFile(join(dir, "a.txt"), "hello\nworld\n");
    const r = await readFileTool.execute({ path: "a.txt" }, ctx());
    expect(r.content).toContain("(2 lines");
    expect(r.content).toContain("     1\thello");
    expect(r.content).toContain("     2\tworld");
  });

  it("windows into files with startLine/maxLines", async () => {
    await writeFile(join(dir, "b.txt"), "l1\nl2\nl3\nl4\n");
    const r = await readFileTool.execute({ path: "b.txt", startLine: 1, maxLines: 2 }, ctx());
    expect(r.content).toContain("showing lines 2-3");
    expect(r.content).toContain("     2\tl2");
    expect(r.content).not.toContain("l1\t");
  });

  it("detects binary files and refuses to dump them", async () => {
    await writeFile(join(dir, "bin.dat"), Buffer.from([0x50, 0x4b, 0x00, 0x00, 0x01]));
    const r = await readFileTool.execute({ path: "bin.dat" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/binary file/);
  });

  it("reports empty files", async () => {
    await writeFile(join(dir, "empty.txt"), "");
    const r = await readFileTool.execute({ path: "empty.txt" }, ctx());
    expect(r.content).toMatch(/empty file/);
  });

  it("truncates very long lines inline", async () => {
    await writeFile(join(dir, "long.txt"), "x".repeat(5000) + "\n");
    const r = await readFileTool.execute({ path: "long.txt" }, ctx());
    expect(r.content).toContain("chars truncated");
    expect(r.content.length).toBeLessThan(4000);
  });

  it("sandbox guard blocks writes outside cwd (write_file) and reads of secrets", async () => {
    const sandboxed = ctx({ sandbox: resolveSandbox({ mode: "workspace-write" }, dir) });
    const w = await writeFileTool.execute({ path: "/etc/cptest-evil", content: "x" }, sandboxed);
    expect(w.isError).toBe(true);
    expect(w.content).toMatch(/sandbox/);
    const r = await readFileTool.execute(
      { path: join(process.env.HOME ?? "~", ".ssh", "id_rsa") },
      sandboxed
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/sensitive path/);
  });
});

describe("edit_file multi-edit", () => {
  it("applies several edits atomically", async () => {
    await writeFile(join(dir, "m.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const r = await editFileTool.execute(
      {
        path: "m.ts",
        edits: [
          { search: "const a = 1;", replace: "const a = 10;" },
          { search: "const c = 3;", replace: "const c = 30;" },
        ],
      },
      ctx()
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/applied 2 edit\(s\)/);
    const after = await readFile(join(dir, "m.ts"), "utf-8");
    expect(after).toContain("const a = 10;");
    expect(after).toContain("const b = 2;");
    expect(after).toContain("const c = 30;");
  });

  it("rolls back everything when one edit fails", async () => {
    const original = "const a = 1;\nconst b = 2;\n";
    await writeFile(join(dir, "t.ts"), original);
    const r = await editFileTool.execute(
      {
        path: "t.ts",
        edits: [
          { search: "const a = 1;", replace: "const a = 99;" },
          { search: "DOES NOT EXIST", replace: "x" },
        ],
      },
      ctx()
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/edit #2/);
    expect(r.content).toMatch(/No changes were written/);
    expect(await readFile(join(dir, "t.ts"), "utf-8")).toBe(original);
  });

  it("single-edit mode still works (back-compat)", async () => {
    await writeFile(join(dir, "s.ts"), "foo\nbar\n");
    const r = await editFileTool.execute({ path: "s.ts", search: "bar", replace: "baz" }, ctx());
    expect(r.isError).toBeFalsy();
    expect(await readFile(join(dir, "s.ts"), "utf-8")).toContain("baz");
  });

  it("reports line-count delta", async () => {
    await writeFile(join(dir, "d.ts"), "a\nb\n");
    const r = await editFileTool.execute(
      { path: "d.ts", search: "b", replace: "b\nc\nd" },
      ctx()
    );
    expect(r.content).toMatch(/\+2 lines/);
  });

  it("sandbox blocks edits outside the workspace", async () => {
    const sandboxed = ctx({ sandbox: resolveSandbox({ mode: "workspace-write" }, dir) });
    const r = await editFileTool.execute(
      { path: "/etc/hosts", search: "127.0.0.1", replace: "0.0.0.0" },
      sandboxed
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/sandbox/);
  });
});
