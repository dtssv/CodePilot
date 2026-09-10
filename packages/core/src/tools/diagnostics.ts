// diagnostics: surface LSP / language-server diagnostics (errors, warnings,
// hints) to the agent. Core has no LSP client of its own; instead the host
// (VSCode, IDEA, or a future core-side LSP) registers a DiagnosticsProvider
// that returns per-file diagnostics on demand.
//
// This mirrors opencode's `diagnostics` tool: it lets the agent verify its
// edits by reading the language server's verdict (type errors, unused
// imports, lint failures) without needing to run a full build.

import { z } from "zod";
import type { ToolDef } from "./types.js";

export interface Diagnostic {
  /** 1-based line where the diagnostic starts. */
  line: number;
  /** 1-based column where the diagnostic starts. */
  column?: number;
  /** 1-based end line (inclusive). */
  endLine?: number;
  /** 1-based end column. */
  endColumn?: number;
  severity: "error" | "warning" | "info" | "hint";
  /** Human-readable message. */
  message: string;
  /** Source identifier (e.g. "typescript", "eslint", "rust-analyzer"). */
  source?: string;
  /** Diagnostic code, if the source provides one. */
  code?: string | number;
}

export interface DiagnosticsProvider {
  /** Return diagnostics for a single file. Empty array if clean. */
  forFile(path: string): Promise<Diagnostic[]>;
  /** Return all diagnostics in the workspace (capped by the provider). */
  forWorkspace(): Promise<{ path: string; diagnostics: Diagnostic[] }[]>;
}

const schema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      "File path to fetch diagnostics for. Omit to fetch workspace-wide " +
        "diagnostics (may be capped by the host)."
    ),
  severity: z
    .enum(["error", "warning", "info", "hint"])
    .optional()
    .describe(
      "Filter to a minimum severity. `error` (default) returns errors only; " +
        "`warning` returns warnings + errors; etc."
    ),
});

export const diagnosticsTool: ToolDef<typeof schema> & {
  provider?: DiagnosticsProvider;
} = {
  name: "diagnostics",
  description:
    "Fetch LSP / language-server diagnostics (type errors, lint failures, " +
    "unused imports) for a file or the whole workspace. Use this AFTER " +
    "editing to verify the change type-checks — it is far cheaper than a " +
    "full build and pinpoints the exact line.\n\n" +
    "Pass `path` for a single file; omit it for workspace-wide diagnostics " +
    "(the host may cap the result count). `severity` filters: `error` " +
    "(default) shows only errors; `warning` adds warnings; `info`/`hint` " +
    "return everything.\n\n" +
    "When the result is empty, the file is clean. When non-empty, each " +
    "entry shows `path:line:col severity [source] message`. Fix the errors " +
    "before declaring the task done.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    if (!diagnosticsTool.provider && !ctx.diagnosticsProvider) {
      return {
        content:
          "diagnostics are not available in this host — the IDE/LSP is not " +
          "connected. Use `bash` to run the type-checker / linter directly " +
          "(e.g. `tsc --noEmit`, `eslint .`).",
        isError: false,
      };
    }
    const provider = ctx.diagnosticsProvider ?? diagnosticsTool.provider!;
    const minSeverity = input.severity ?? "error";
    const order = { error: 0, warning: 1, info: 2, hint: 3 } as const;

    const format = (path: string, d: Diagnostic): string => {
      const loc = `${path}:${d.line}${d.column ? ":" + d.column : ""}`;
      const src = d.source ? ` [${d.source}${d.code !== undefined ? ":" + d.code : ""}]` : "";
      return `${loc} ${d.severity}${src} ${d.message}`;
    };

    try {
      if (input.path) {
        const all = await provider.forFile(input.path);
        const filtered = all.filter((d) => order[d.severity] <= order[minSeverity]);
        if (filtered.length === 0) {
          return { content: `no ${minSeverity}+ diagnostics in ${input.path}` };
        }
        const filePath = input.path;
        return {
          content: filtered
            .map((d) => format(filePath, d))
            .sort()
            .join("\n"),
        };
      }
      const groups = await provider.forWorkspace();
      const lines: string[] = [];
      let total = 0;
      for (const g of groups) {
        const filtered = g.diagnostics.filter(
          (d) => order[d.severity] <= order[minSeverity]
        );
        if (filtered.length === 0) continue;
        for (const d of filtered) lines.push(format(g.path, d));
        total += filtered.length;
      }
      if (lines.length === 0) {
        return { content: `no ${minSeverity}+ diagnostics in workspace` };
      }
      return { content: `${total} ${minSeverity}+ diagnostic(s):\n${lines.join("\n")}` };
    } catch (err) {
      return {
        content: `failed to fetch diagnostics: ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
