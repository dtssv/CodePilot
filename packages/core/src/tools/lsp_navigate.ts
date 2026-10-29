// lsp_navigate: precise symbol navigation via a language server
// (go-to-definition / find-references / hover). Lets the agent jump to the
// exact definition or every use of a symbol in a large repo instead of
// grepping and guessing. Fail-soft: when no LSP server is configured/installed
// for the file's language, it returns a clear message (and the model should
// fall back to grep).

import { z } from "zod";
import type { ToolDef, ToolContext } from "./types.js";
import { parseLocations, type LspManager } from "../lsp.js";

const schema = z.object({
  action: z
    .enum(["definition", "references", "hover"])
    .describe(
      "`definition` jumps to where the symbol is declared; `references` lists " +
        "every use; `hover` returns the type/signature/doc at the position.",
    ),
  path: z.string().min(1).describe("Workspace-relative or absolute file path containing the symbol."),
  line: z
    .number()
    .int()
    .min(1)
    .describe("1-based line of the symbol (as shown by read_file / grep)."),
  column: z
    .number()
    .int()
    .min(1)
    .describe("1-based column of the symbol on that line (point at the identifier)."),
});

/** Build the tool bound to a per-session LSP manager + workspace root. */
export function makeLspNavigateTool(
  getManager: () => LspManager | null,
  getRoot: () => string,
): ToolDef<typeof schema> {
  return {
    name: "lsp_navigate",
    description:
      "Navigate code precisely with a language server: go-to-definition, " +
      "find-references, or hover (type/signature). Prefer this over grep when " +
      "you have an exact file + line/column for a symbol — it follows imports " +
      "and resolves overloads. Provide 1-based `line`/`column` pointing at the " +
      "identifier. If no language server is available for the file, it says so; " +
      "then fall back to grep. Built-in support: TypeScript/JavaScript; other " +
      "languages require an `lsp.servers` config entry.",
    inputSchema: schema,
    permission: "read",
    async execute(input, ctx: ToolContext) {
      const mgr = getManager();
      if (!mgr) {
        return {
          content: "LSP navigation is not available in this session.",
          isError: true,
        };
      }
      const abs = resolvePath(ctx.cwd, input.path);
      // LSP positions are 0-based; the tool's inputs are 1-based (matching
      // read_file / grep output) — convert here.
      const pos = { line: input.line - 1, character: input.column - 1 };
      const r = await mgr.navigate(input.action, getRoot(), abs, pos);
      if (!r.ok) {
        return {
          content:
            `lsp_navigate (${input.action}) unavailable: ${r.reason}. ` +
            `Fall back to grep/read_file for this file.`,
          isError: true,
        };
      }
      if (input.action === "hover") {
        const text = renderHover(r.result);
        return { content: text || "(no hover info at this position)" };
      }
      const locs = parseLocations(r.result);
      if (locs.length === 0) {
        return {
          content:
            input.action === "definition"
              ? "No definition found at that position (check the line/column point at the identifier)."
              : "No references found at that position.",
        };
      }
      const header =
        input.action === "definition"
          ? `Definition (${locs.length}):`
          : `References (${locs.length}):`;
      const body = locs.map((l) => `  ${l.path}:${l.line}:${l.column}`).join("\n");
      return { content: `${header}\n${body}` };
    },
  };
}

function resolvePath(cwd: string, p: string): string {
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return p;
  return `${cwd.replace(/[\\/]+$/, "")}/${p}`;
}

/** LSP Hover.contents is markup | string | string[] | {language,value}. */
function renderHover(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const contents = (result as { contents?: unknown }).contents;
  const one = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const o = v as { value?: unknown };
      if (typeof o.value === "string") return o.value;
    }
    return "";
  };
  if (Array.isArray(contents)) return contents.map(one).filter(Boolean).join("\n\n");
  return one(contents);
}
