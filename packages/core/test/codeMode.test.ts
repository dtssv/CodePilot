// Tests for code_mode: sandboxed JS execution with tool API access.

import { describe, it, expect } from "vitest";
import { codeModeTool } from "../src/tools/code_mode.js";
import type { ToolContext } from "../src/tools/types.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSandbox } from "../src/sandbox.js";

/** macOS /var → /private/var symlink trips the sandbox realpath check; resolve first. */
function realTmpdir(): string {
  return realpathSync(tmpdir());
}

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    signal: undefined,
    sandbox: resolveSandbox({ mode: "workspace-write" }, cwd),
    async artifact() {
      return "art_x";
    },
    async readArtifact() {
      return "";
    },
  };
}

describe("code_mode", () => {
  it("executes simple arithmetic and returns the result", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute({ code: "return 1 + 2;" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("3");
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures console.log output", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'console.log("hello", "world");' },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("hello world");
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures console.error output", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'console.error("oops");' },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("oops");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns console output plus result value", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'console.log("log-line");\nreturn "ret-val";' },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("log-line");
    expect(r.content).toContain("ret-val");
    rmSync(dir, { recursive: true, force: true });
  });

  it("supports top-level await", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: "const x = await Promise.resolve(42);\nreturn x;" },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("42");
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Tool API access
  // -----------------------------------------------------------------------

  it("writeFile then readFile round-trip through the API", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      {
        code: [
          'await writeFile("out.txt", "hello from code_mode");',
          'const content = await readFile("out.txt");',
          "return content;",
        ].join("\n"),
      },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("hello from code_mode");
    // Verify it hit disk
    expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe(
      "hello from code_mode"
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("editFile modifies a file on disk", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    writeFileSync(join(dir, "f.txt"), "foo bar baz\n", "utf-8");
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'await editFile("f.txt", "bar", "qux");' },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("foo qux baz\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("ls lists directory contents", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    writeFileSync(join(dir, "a.txt"), "", "utf-8");
    writeFileSync(join(dir, "b.txt"), "", "utf-8");
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: "return await ls();" },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("a.txt");
    expect(r.content).toContain("b.txt");
    rmSync(dir, { recursive: true, force: true });
  });

  it("grep finds matching lines", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    writeFileSync(join(dir, "g.txt"), "alpha\nbeta\ngamma\n", "utf-8");
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'return await grep("beta");' },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("beta");
    rmSync(dir, { recursive: true, force: true });
  });

  it("glob finds matching files", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    writeFileSync(join(dir, "x.ts"), "", "utf-8");
    writeFileSync(join(dir, "y.js"), "", "utf-8");
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'return await glob("*.ts");' },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("x.ts");
    expect(r.content).not.toContain("y.js");
    rmSync(dir, { recursive: true, force: true });
  });

  it("bash executes a command", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'return await bash("echo hi");' },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("hi");
    rmSync(dir, { recursive: true, force: true });
  });

  it("multi-step: read → transform → write", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    writeFileSync(join(dir, "in.txt"), "hello world\nfoo bar\n", "utf-8");
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      {
        code: [
          // readFile returns cat -n formatted output; extract raw text from it
          'const raw = await readFile("in.txt");',
          // Strip the header line and line-number prefixes to get raw content
          'const body = raw.split("\\n").slice(2).map(l => l.replace(/^\\s*\\d+\\t/, "")).join("\\n");',
          "const upper = body.toUpperCase();",
          'await writeFile("out.txt", upper);',
          'return "done";',
        ].join("\n"),
      },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("done");
    const written = readFileSync(join(dir, "out.txt"), "utf-8");
    expect(written).toContain("HELLO WORLD");
    expect(written).toContain("FOO BAR");
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Security
  // -----------------------------------------------------------------------

  it("has no access to process", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: "return typeof process;" },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("undefined");
    rmSync(dir, { recursive: true, force: true });
  });

  it("has no access to require", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: "return typeof require;" },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("undefined");
    rmSync(dir, { recursive: true, force: true });
  });

  it("has no access to fetch", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: "return typeof fetch;" },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("undefined");
    rmSync(dir, { recursive: true, force: true });
  });

  it("has no access to global/globalThis builtins beyond sandbox", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      {
        code: [
          "return [",
          '  typeof global,',
          '  typeof process,',
          '  typeof require,',
          '  typeof fetch,',
          '  typeof Buffer,',
          '  typeof setTimeout,',
          '  typeof setInterval,',
          '  typeof __dirname,',
          '  typeof __filename,',
          '  typeof module,',
          '  typeof exports,',
          "].join(',');",
        ].join("\n"),
      },
      ctx
    );
    expect(r.isError).toBeFalsy();
    // All should be undefined — none of these Node globals are exposed
    const parts = r.content.split(",");
    for (const p of parts) {
      expect(p).toBe("undefined");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it("reports a thrown error", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'throw new Error("boom");' },
      ctx
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("boom");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a rejected promise", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'await Promise.reject(new Error("async-fail"));' },
      ctx
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("async-fail");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports syntax errors", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: "const x = {;" },
      ctx
    );
    expect(r.isError).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("readFile on missing file returns error via API", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'await readFile("nonexistent.txt");' },
      ctx
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("ENOENT");
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Sandbox enforcement through the API
  // -----------------------------------------------------------------------

  it("writeFile outside the workspace is blocked by sandbox", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'await writeFile("/etc/evil.txt", "hacked");' },
      ctx
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/sandbox|outside the writable roots/i);
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Timeout
  // -----------------------------------------------------------------------

  it("enforces timeout on long-running code", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      {
        code: "while(true) {}",
        timeout_ms: 500,
      },
      ctx
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/timed? ?out|Script execution/i);
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Return value formatting
  // -----------------------------------------------------------------------

  it("returns objects as formatted JSON", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      { code: 'return { a: 1, b: "two" };' },
      ctx
    );
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content);
    expect(parsed).toEqual({ a: 1, b: "two" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined as (no output) when nothing else printed", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute({ code: "let x = 5;" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("(no output)");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loops and string manipulation work", async () => {
    const dir = mkdtempSync(join(realTmpdir(), "cm-"));
    const ctx = makeCtx(dir);
    const r = await codeModeTool.execute(
      {
        code: [
          "const lines = [];",
          "for (let i = 0; i < 5; i++) lines.push(`line-${i}`);",
          "return lines.join('\\n');",
        ].join("\n"),
      },
      ctx
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(
      "line-0\nline-1\nline-2\nline-3\nline-4"
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
