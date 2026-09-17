// code_mode: execute model-generated TypeScript/JavaScript in a sandboxed vm
// context with access to a curated set of tool APIs (readFile, writeFile,
// editFile, bash, grep, glob, ls). Every call is routed through the normal
// tool permission/sandbox pipeline — nothing bypasses the sandbox.

import { z } from "zod";
import vm from "node:vm";
import type { ToolDef, ToolContext } from "./types.js";
import { readFileTool } from "./read_file.js";
import { writeFileTool } from "./write_file.js";
import { editFileTool } from "./edit_file.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { lsTool } from "./ls.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;

const schema = z.object({
  code: z
    .string()
    .describe(
      "TypeScript/JavaScript code to execute. Use `await` for async API " +
        "calls. The last expression value is returned. Use console.log() " +
        "for intermediate output."
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT)
    .optional()
    .describe(
      `Max wall-clock time in ms (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}).`
    ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a value for display in the tool result. */
function formatValue(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const codeModeTool: ToolDef<typeof schema> = {
  name: "code_mode",
  description:
    "Execute a TypeScript/JavaScript code snippet in a sandboxed environment " +
    "with access to the SDK's tool API. The following async functions are " +
    "available inside the sandbox:\n\n" +
    "  readFile(path)                    → read_file tool\n" +
    "  writeFile(path, content)          → write_file tool\n" +
    "  editFile(path, oldStr, newStr)    → edit_file tool\n" +
    "  bash(command, timeout_ms?)        → bash tool\n" +
    "  grep(pattern, path?)              → grep tool\n" +
    "  glob(pattern)                     → glob tool\n" +
    "  ls(path?)                         → ls tool\n\n" +
    "All calls go through the normal permission/sandbox pipeline. " +
    "console.log / console.error output is captured and returned. " +
    "The value of the last expression (or `return` value at top level) is " +
    "included in the result.\n\n" +
    "When to use: multi-step operations that benefit from control flow " +
    "(loops, conditionals, string manipulation) — e.g. read several files, " +
    "transform content, write results. When NOT to use: single tool calls " +
    "(use the dedicated tools directly).",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    const timeout = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    // -- Build sandboxed API functions that delegate to real tools ----------

    const api = {
      async readFile(path: string) {
        const r = await readFileTool.execute({ path }, ctx);
        if (r.isError) throw new Error(r.content);
        return r.content;
      },
      async writeFile(path: string, content: string) {
        const r = await writeFileTool.execute({ path, content }, ctx);
        if (r.isError) throw new Error(r.content);
        return r.content;
      },
      async editFile(path: string, oldStr: string, newStr: string) {
        const r = await editFileTool.execute(
          { path, search: oldStr, replace: newStr },
          ctx
        );
        if (r.isError) throw new Error(r.content);
        return r.content;
      },
      async bash(command: string, bashTimeout?: number) {
        const r = await bashTool.execute(
          {
            command,
            ...(bashTimeout !== undefined ? { timeout: bashTimeout } : {}),
          },
          ctx
        );
        if (r.isError) throw new Error(r.content);
        return r.content;
      },
      async grep(pattern: string, path?: string) {
        const r = await grepTool.execute(
          { pattern, ...(path !== undefined ? { cwd: path } : {}) },
          ctx
        );
        if (r.isError) throw new Error(r.content);
        return r.content;
      },
      async glob(pattern: string) {
        const r = await globTool.execute({ pattern }, ctx);
        if (r.isError) throw new Error(r.content);
        return r.content;
      },
      async ls(path?: string) {
        const r = await lsTool.execute(
          path !== undefined ? { path } : {},
          ctx
        );
        if (r.isError) throw new Error(r.content);
        return r.content;
      },
    };

    // -- Create the vm sandbox ------------------------------------------------

    const sandbox = Object.create(null) as Record<string, unknown>;
    sandbox.readFile = api.readFile;
    sandbox.writeFile = api.writeFile;
    sandbox.editFile = api.editFile;
    sandbox.bash = api.bash;
    sandbox.grep = api.grep;
    sandbox.glob = api.glob;
    sandbox.ls = api.ls;
    sandbox.console = {
      log(...args: unknown[]) {
        stdoutLines.push(args.map(String).join(" "));
      },
      error(...args: unknown[]) {
        stderrLines.push(args.map(String).join(" "));
      },
      warn(...args: unknown[]) {
        stderrLines.push(args.map(String).join(" "));
      },
    };

    const vmCtx = vm.createContext(sandbox, {
      name: "code_mode",
      codeGeneration: { strings: false, wasm: false },
    });

    // -- Wrap user code in an async IIFE so top-level await works -------------

    const wrapped = `(async () => {\n${input.code}\n})()`;

    // -- Execute with timeout ---------------------------------------------------

    let result: unknown;
    let error: string | undefined;

    try {
      const script = new vm.Script(wrapped, {
        filename: "code_mode.js",
      });
      const promise: Promise<unknown> = script.runInContext(vmCtx, {
        timeout,
        breakOnSigint: false,
      });
      result = await promise;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // -- Assemble result --------------------------------------------------------

    const parts: string[] = [];
    if (stdoutLines.length > 0) {
      parts.push(stdoutLines.join("\n"));
    }
    if (stderrLines.length > 0) {
      parts.push(
        (stdoutLines.length > 0 ? "\n" : "") + stderrLines.join("\n")
      );
    }

    const resultStr = formatValue(result);
    if (resultStr) {
      if (parts.length > 0) parts.push("\n");
      parts.push(resultStr);
    }

    if (error) {
      if (parts.length > 0) parts.push("\n");
      parts.push(`Error: ${error}`);
    }

    const content = parts.join("") || "(no output)";
    return { content, isError: error !== undefined };
  },
};
