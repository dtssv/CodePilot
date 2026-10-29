// mcp meta-tool: on-demand discovery of external MCP server tools.
//
// When an MCP server exposes many tools, injecting every tool's full JSON
// schema into every request bloats the prompt (a single rich schema can be
// thousands of tokens). To keep the per-turn tool list small, MCP tools are
// hidden from the provider tool list and reached through this one meta-tool:
//
//   - list              → names + one-line descriptions of all MCP tools
//   - describe(name)    → the full input JSON schema for one MCP tool
//   - call(name, args)  → invoke one MCP tool with arguments
//
// The real MCP tools stay in the registry (so `call` can dispatch to them);
// they are simply not advertised directly to the model.

import { z } from "zod";
import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import type { ToolRegistry } from "./types.js";

const schema = z.object({
  action: z
    .enum(["list", "describe", "call", "batch"])
    .describe(
      "`list` (optionally filtered by `query`) the MCP tools, `describe` one tool's schema, " +
        "`call` one tool, or `batch` several tools in parallel in one step.",
    ),
  query: z
    .string()
    .optional()
    .describe("For `list`: keyword(s) to filter tools by name/description (ranked). Omit to list all (bounded)."),
  name: z
    .string()
    .optional()
    .describe("MCP tool name (required for `describe` and `call`). Use a name from `list`."),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arguments object for `call`, matching the tool's `describe` schema."),
  calls: z
    .array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() }))
    .optional()
    .describe(
      "For `batch`: a list of {name, args} to invoke IN PARALLEL in a single step — " +
        "use this instead of many sequential `call`s to avoid round-trips.",
    ),
});

/** Cap on `list` output so a server with hundreds of tools can't flood the
 * turn. When the full list exceeds this, it is truncated with a hint to use
 * `query`. */
const LIST_CHAR_BUDGET = 4000;

/** Rank tools by how well they match a keyword query (simple lexical score:
 * name hits weigh more than description hits). Returns all when query empty. */
function rankTools<T extends { name: string; description: string }>(tools: T[], query?: string): T[] {
  const q = query?.trim().toLowerCase();
  if (!q) return tools;
  const terms = q.split(/\s+/).filter(Boolean);
  const score = (t: T): number => {
    const name = t.name.toLowerCase();
    const desc = t.description.toLowerCase();
    let s = 0;
    for (const term of terms) {
      if (name.includes(term)) s += 3;
      if (desc.includes(term)) s += 1;
    }
    return s;
  };
  return tools
    .map((t) => ({ t, s: score(t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.t);
}

/** Build the `mcp` meta-tool bound to a registry lookup. The registry is read
 * lazily on each call so tools registered after boot (MCP starts async) are
 * visible. */
export function makeMcpMetaTool(getRegistry: () => ToolRegistry): ToolDef<typeof schema> {
  const mcpTools = () => getRegistry().all().filter((t) => t.source === "mcp");

  return {
    name: "mcp",
    description:
      "Access external MCP server tools on demand (they are not listed individually to save context). " +
      "`action:\"list\"` (optionally with `query` to search) to see available MCP tools, " +
      "`action:\"describe\"` + `name` for a tool's input schema, `action:\"call\"` + `name` + `args` to invoke one, " +
      "or `action:\"batch\"` + `calls:[{name,args}]` to invoke several in parallel in one step (prefer over many sequential calls).",
    inputSchema: schema,
    permission: "network",
    async execute(input, ctx: ToolContext): Promise<ToolResult> {
      const tools = mcpTools();
      if (input.action === "list") {
        if (tools.length === 0) return { content: "No MCP tools are available." };
        const ranked = rankTools(
          tools.map((t) => ({ name: t.name, description: t.description.replace(/^\[mcp:[^\]]+\]\s*/, "") })),
          input.query,
        );
        if (ranked.length === 0) {
          return { content: `No MCP tools match "${input.query}". Omit \`query\` to list all.` };
        }
        // Bound the output: fit as many ranked tools as the char budget allows.
        const out: string[] = [];
        let used = 0;
        let shown = 0;
        for (const t of ranked) {
          const line = `- ${t.name}: ${t.description}`;
          if (used + line.length > LIST_CHAR_BUDGET && shown > 0) break;
          out.push(line);
          used += line.length + 1;
          shown += 1;
        }
        const omitted = ranked.length - shown;
        const header = input.query
          ? `MCP tools matching "${input.query}" (${ranked.length}):`
          : `Available MCP tools (${tools.length}):`;
        const footer =
          omitted > 0 ? `\n…and ${omitted} more — narrow with \`action:"list"\` + \`query\`.` : "";
        return { content: `${header}\n${out.join("\n")}${footer}` };
      }
      if (input.action === "batch") {
        const calls = input.calls ?? [];
        if (calls.length === 0) {
          return { content: "`batch` requires a non-empty `calls` array.", isError: true };
        }
        // Run all requested MCP tools in parallel (one step, no round-trips).
        const results = await Promise.all(
          calls.map(async (c, i) => {
            const t = tools.find((x) => x.name === c.name);
            if (!t) return { i, name: c.name, ok: false, out: `unknown MCP tool: ${c.name}` };
            try {
              const r = await t.execute((c.args ?? {}) as never, ctx);
              return { i, name: c.name, ok: !r.isError, out: r.content };
            } catch (err) {
              return { i, name: c.name, ok: false, out: (err as Error).message };
            }
          }),
        );
        const anyError = results.some((r) => !r.ok);
        const body = results
          .map((r) => `### [${r.i}] ${r.name} ${r.ok ? "(ok)" : "(FAILED)"}\n${r.out}`)
          .join("\n\n");
        return { content: body, isError: anyError };
      }
      if (!input.name) {
        return { content: `\`${input.action}\` requires \`name\`. Run action:"list" first.`, isError: true };
      }
      const target = tools.find((t) => t.name === input.name);
      if (!target) {
        return { content: `Unknown MCP tool: ${input.name}. Run action:"list" to see valid names.`, isError: true };
      }
      if (input.action === "describe") {
        const raw = target.mcpMeta?.jsonSchema ?? {};
        return {
          content:
            `${target.name}\n${target.description}\n\nInput schema (JSON):\n` +
            "```json\n" + JSON.stringify(raw, null, 2) + "\n```",
        };
      }
      // action === "call"
      return target.execute((input.args ?? {}) as never, ctx);
    },
  };
}
