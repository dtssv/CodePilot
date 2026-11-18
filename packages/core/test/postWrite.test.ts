// Post-write formatting + diagnostics: the LSP client's push/pull diagnostics
// (against a scripted fake server), project-local TypeScript 7 detection, the
// formatter runner, error de-duplication across writes, provider chaining, and
// the note write_file appends.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LspManager, nativeTypeScriptServer, type LspServerConfig } from "../src/workspace/lsp.js";
import { createPostWrite } from "../src/workspace/postWrite.js";
import { chainDiagnostics, type Diagnostic, type DiagnosticsProvider } from "../src/tools/diagnostics.js";
import { writeFileTool } from "../src/tools/write_file.js";
import type { ToolContext } from "../src/tools/types.js";

const FAKE_SERVER = fileURLToPath(new URL("./fixtures/fake-lsp.cjs", import.meta.url));

const dirs: string[] = [];
const managers: LspManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-postwrite-"));
  dirs.push(d);
  return d;
}

function manager(root: string, mode: "push" | "pull" | "mute"): LspManager {
  const config: LspServerConfig = {
    command: process.execPath,
    args: [FAKE_SERVER, mode],
    languages: ["typescript"],
  };
  const m = new LspManager([config]);
  managers.push(m);
  return m;
}

describe("LspManager diagnostics", () => {
  for (const mode of ["push", "pull"] as const) {
    it(`returns fresh ${mode} diagnostics after each change`, async () => {
      const root = workspace();
      const file = join(root, "a.ts");
      const m = manager(root, mode);
      writeFileSync(file, "ok\nERR one\n");
      const first = await m.diagnostics(root, file, 5000);
      expect(first).toEqual([
        expect.objectContaining({ line: 2, column: 1, severity: "error", message: "bad ERR one", source: "fake", code: 7 }),
      ]);
      writeFileSync(file, "ok\nok\n");
      expect(await m.diagnostics(root, file, 5000)).toEqual([]);
    });
  }

  it("returns null when the server command is not installed", async () => {
    const root = workspace();
    const m = new LspManager([{ command: "no-such-lsp-for-codepilot-test", languages: ["typescript"] }]);
    managers.push(m);
    expect(await m.diagnostics(root, join(root, "a.ts"), 5000)).toBeNull();
  });

  it("returns null for a language with no server", async () => {
    const root = workspace();
    expect(await manager(root, "push").diagnostics(root, join(root, "a.txt"), 5000)).toBeNull();
  });

  it("does not hang shutdown on a server that never answers it", async () => {
    const root = workspace();
    const file = join(root, "a.ts");
    writeFileSync(file, "ok\n");
    const m = manager(root, "mute");
    await m.diagnostics(root, file, 300);
    const t = Date.now();
    await m.stopAll();
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("exposes a provider that resolves relative paths against the root", async () => {
    const root = workspace();
    writeFileSync(join(root, "a.ts"), "ERR\n");
    const p = manager(root, "pull").provider(() => root, 5000);
    expect(await p.forFile("a.ts")).toHaveLength(1);
    expect(await p.forWorkspace()).toEqual([{ path: join(root, "a.ts"), diagnostics: expect.any(Array) }]);
  });
});

describe("nativeTypeScriptServer", () => {
  function tsInstall(version: string): string {
    const root = workspace();
    mkdirSync(join(root, "node_modules", "typescript"), { recursive: true });
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", "typescript", "package.json"), JSON.stringify({ version }));
    writeFileSync(join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"), "");
    return root;
  }

  it("uses `tsc --lsp --stdio` for a project-local TypeScript 7+", () => {
    const root = tsInstall("7.0.2");
    expect(nativeTypeScriptServer(root)).toMatchObject({ args: ["--lsp", "--stdio"] });
    const m = new LspManager();
    expect(m.configFor(join(root, "a.ts"), root)?.config.args).toEqual(["--lsp", "--stdio"]);
  });

  it("keeps typescript-language-server for older TypeScript or custom servers", () => {
    const root = tsInstall("5.9.3");
    expect(nativeTypeScriptServer(root)).toBeNull();
    expect(new LspManager().configFor(join(root, "a.ts"), root)?.config.command).toBe("typescript-language-server");
    const ts7 = tsInstall("7.1.0");
    const custom = new LspManager([{ command: "my-ts", languages: ["typescript"] }]);
    expect(custom.configFor(join(ts7, "a.ts"), ts7)?.config.command).toBe("my-ts");
  });
});

function toolCtx(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { cwd, artifact: async () => "art", readArtifact: async () => "", ...extra } as unknown as ToolContext;
}

const err = (line: number, message: string): Diagnostic => ({ line, column: 1, severity: "error", message });

describe("createPostWrite", () => {
  it("runs matching formatters, reobserves the rewritten file, and says so", async () => {
    const root = workspace();
    const file = join(root, "a.ts");
    writeFileSync(file, "a    b\n");
    const squash = [
      process.execPath,
      "-e",
      "const f=process.argv[1];const fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/ +/g,' '))",
      "$FILE",
    ];
    const reobserved: string[] = [];
    const post = createPostWrite({
      formatters: {
        squash: { command: squash, extensions: [".ts"] },
        other: { command: [process.execPath, "-e", "process.exit(9)"], extensions: [".py"] },
        off: { command: [process.execPath, "-e", "process.exit(9)"], extensions: [".ts"], disabled: true },
      },
    });
    const note = await post([file], toolCtx(root, { reobserveFile: (p) => reobserved.push(p) }));
    expect(readFileSync(file, "utf-8")).toBe("a b\n");
    expect(note).toContain("a.ts was reformatted by squash");
    expect(reobserved).toEqual([file]);
  });

  it("reports a failing formatter without failing the write", async () => {
    const root = workspace();
    const file = join(root, "a.ts");
    writeFileSync(file, "x\n");
    const post = createPostWrite({
      formatters: { broken: { command: [process.execPath, "-e", "console.error('boom');process.exit(2)"], extensions: [".ts"] } },
    });
    expect(await post([file], toolCtx(root))).toContain("formatter broken failed on a.ts: boom");
  });

  it("reports only errors the model has not seen, and re-reports reintroduced ones", async () => {
    const root = workspace();
    const file = join(root, "a.ts");
    writeFileSync(file, "x\n");
    let current: Diagnostic[] = [err(1, "old"), { ...err(2, "just a warning"), severity: "warning" }];
    const post = createPostWrite({ diagnostics: async () => current });
    const ctx = toolCtx(root);

    const first = await post([file], ctx);
    expect(first).toContain("a.ts:1:1 error old");
    expect(first).not.toContain("warning");

    current = [err(1, "old"), err(5, "new")];
    const second = await post([file], ctx);
    expect(second).toContain("a.ts:5:1 error new");
    expect(second).not.toContain("error old");
    expect(second).toContain("plus 1 previously reported error(s) still present");

    current = [];
    expect(await post([file], ctx)).toBe("");

    current = [err(3, "old")];
    expect(await post([file], ctx)).toContain("a.ts:3:1 error old");
  });

  it("stays silent when diagnostics are unavailable or the file is gone", async () => {
    const root = workspace();
    const file = join(root, "a.ts");
    writeFileSync(file, "x\n");
    const post = createPostWrite({ diagnostics: async () => null });
    expect(await post([file], toolCtx(root))).toBe("");
    expect(await post([join(root, "missing.ts")], toolCtx(root))).toBe("");
  });

  it("is appended to the write_file result", async () => {
    const root = workspace();
    const post = createPostWrite({ diagnostics: async () => [err(1, "Type 'string' is not assignable")] });
    const r = await writeFileTool.execute({ path: "b.ts", content: "const x: number = 'a';\n" }, toolCtx(root, { postWrite: post }));
    expect(r.isError).toBeUndefined();
    expect(r.content).toMatch(/^wrote .*b\.ts/);
    expect(r.content).toContain("Language-server errors after this write:\nb.ts:1:1 error Type 'string' is not assignable");
  });
});

describe("chainDiagnostics", () => {
  it("falls through providers that cannot answer", async () => {
    const host: DiagnosticsProvider = { forFile: async () => null, forWorkspace: async () => null };
    const lsp: DiagnosticsProvider = { forFile: async () => [err(1, "from lsp")], forWorkspace: async () => [] };
    const chained = chainDiagnostics(host, lsp)!;
    expect(await chained.forFile("a.ts")).toEqual([err(1, "from lsp")]);
    expect(await chained.forWorkspace()).toEqual([]);
    expect(chainDiagnostics(undefined, lsp)).toBe(lsp);
  });

  it("keeps the host's answer when it has one", async () => {
    const host: DiagnosticsProvider = { forFile: async () => [], forWorkspace: async () => [] };
    const lsp: DiagnosticsProvider = { forFile: async () => [err(1, "x")], forWorkspace: async () => [] };
    expect(await chainDiagnostics(host, lsp)!.forFile("a.ts")).toEqual([]);
  });
});
