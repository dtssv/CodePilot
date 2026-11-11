// Tests for the diagnostics tool: it formats a host DiagnosticsProvider's
// output, filters by severity, caps the output so a large result can't flood
// the turn, and fails soft (non-error guidance) when no provider is connected.

import { describe, expect, it } from "vitest";
import { diagnosticsTool } from "../src/tools/diagnostics.js";
import type { Diagnostic, DiagnosticsProvider } from "../src/tools/diagnostics.js";
import type { ToolContext } from "../src/tools/types.js";

function ctx(provider?: DiagnosticsProvider): ToolContext {
  return {
    cwd: "/work",
    artifact: async () => "art",
    readArtifact: async () => "",
    ...(provider ? { diagnosticsProvider: provider } : {}),
  } as unknown as ToolContext;
}

function diag(partial: Partial<Diagnostic> & { line: number; message: string }): Diagnostic {
  return { severity: "error", ...partial };
}

describe("diagnostics tool", () => {
  it("returns non-error guidance when no provider is connected", async () => {
    const r = await diagnosticsTool.execute({}, ctx());
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/not available/);
    expect(r.content).toMatch(/bash/);
  });

  it("formats per-file diagnostics and defaults to error severity", async () => {
    const provider: DiagnosticsProvider = {
      forFile: async () => [
        diag({ line: 10, column: 5, message: "Type error", source: "typescript", code: 2322 }),
        diag({ line: 3, severity: "warning", message: "unused" }),
      ],
      forWorkspace: async () => [],
    };
    const r = await diagnosticsTool.execute({ path: "a.ts" }, ctx(provider));
    expect(r.isError).toBeUndefined();
    // Error shown; warning filtered out by the default error-only severity.
    expect(r.content).toContain("a.ts:10:5 error [typescript:2322] Type error");
    expect(r.content).not.toContain("unused");
  });

  it("includes warnings when severity is lowered", async () => {
    const provider: DiagnosticsProvider = {
      forFile: async () => [diag({ line: 3, severity: "warning", message: "unused" })],
      forWorkspace: async () => [],
    };
    const r = await diagnosticsTool.execute({ path: "a.ts", severity: "warning" }, ctx(provider));
    expect(r.content).toContain("unused");
  });

  it("reports a clean file", async () => {
    const provider: DiagnosticsProvider = {
      forFile: async () => [],
      forWorkspace: async () => [],
    };
    const r = await diagnosticsTool.execute({ path: "clean.ts" }, ctx(provider));
    expect(r.content).toMatch(/no error\+ diagnostics in clean\.ts/);
  });

  it("caps a huge per-file result and notes the omission", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      diag({ line: i + 1, message: `err ${i}` }),
    );
    const provider: DiagnosticsProvider = {
      forFile: async () => many,
      forWorkspace: async () => [],
    };
    const r = await diagnosticsTool.execute({ path: "big.ts" }, ctx(provider));
    const bodyLines = r.content.split("\n").filter((l) => l.startsWith("big.ts:"));
    expect(bodyLines.length).toBe(100);
    expect(r.content).toMatch(/and 150 more/);
  });

  it("aggregates workspace diagnostics and caps files/entries", async () => {
    const files = Array.from({ length: 80 }, (_, f) => ({
      path: `f${f}.ts`,
      diagnostics: [diag({ line: 1, message: `e${f}` })],
    }));
    const provider: DiagnosticsProvider = {
      forFile: async () => [],
      forWorkspace: async () => files,
    };
    const r = await diagnosticsTool.execute({}, ctx(provider));
    const shown = r.content.split("\n").filter((l) => /^f\d+\.ts:/.test(l));
    // Capped at the max-files bound (50), not all 80.
    expect(shown.length).toBe(50);
    expect(r.content).toMatch(/output capped/);
  });

  it("reports an empty workspace", async () => {
    const provider: DiagnosticsProvider = {
      forFile: async () => [],
      forWorkspace: async () => [{ path: "a.ts", diagnostics: [] }],
    };
    const r = await diagnosticsTool.execute({}, ctx(provider));
    expect(r.content).toMatch(/no error\+ diagnostics in workspace/);
  });

  it("surfaces a provider throw as a tool error", async () => {
    const provider: DiagnosticsProvider = {
      forFile: async () => {
        throw new Error("LSP down");
      },
      forWorkspace: async () => [],
    };
    const r = await diagnosticsTool.execute({ path: "a.ts" }, ctx(provider));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/LSP down/);
  });
});
