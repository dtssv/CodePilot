// code_mode: run model-generated plain JavaScript (no transpile, so TS-only
// syntax fails) against a curated tool API (readFile/writeFile/editFile/bash/
// grep/glob/ls). Each delegated call still enforces the OS sandbox + path
// guard, but bypasses the permission engine and hooks — that is why the tool
// is execute-tier and only available in `agent` mode.

import { z } from "zod";
import vm from "node:vm";
import { spawn } from "node:child_process";
import type { ToolDef, ToolContext, ToolRegistry, ToolResult } from "./types.js";
import { zodToJsonSchema } from "./types.js";
import { spillHeadTail } from "./_shared.js";
import { readFileTool } from "./read_file.js";
import { writeFileTool } from "./write_file.js";
import { editFileTool } from "./edit_file.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { lsTool } from "./ls.js";
import { isDeferredWireTool } from "./wirePolicy.js";
import { filterToolsByMode } from "./modes.js";
import { resolveSandbox, wrapCommand, modelShellEnv } from "../sandbox/sandbox.js";

/** Cap on `tools.search` output so huge MCP catalogs can't flood the turn. */
const TOOLS_SEARCH_CHAR_BUDGET = 4000;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;

const schema = z.object({
  code: z
    .string()
    .describe(
      "JavaScript code to execute (run as plain JS with no transpile — do not " +
        "use TypeScript-only syntax such as type annotations). Use `await` for " +
        "async API calls. The last expression value is returned. Use " +
        "console.log() for intermediate output."
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

/** Curated helpers + optional deferred `tools` namespace. Helpers skip
 * permission prompts; `tools.call` uses the permissioned leaf path. */
type CodeModeApi = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  editFile(path: string, oldStr: string, newStr: string): Promise<string>;
  bash(command: string, bashTimeout?: number): Promise<string>;
  grep(pattern: string, path?: string): Promise<string>;
  glob(pattern: string): Promise<string>;
  ls(path?: string): Promise<string>;
  tools?: {
    search(query?: string): Promise<string>;
    describe(name: string): Promise<string>;
    call(name: string, args?: Record<string, unknown>): Promise<string>;
  };
};

function rankDeferred(
  tools: Array<{ name: string; description: string }>,
  query?: string,
): Array<{ name: string; description: string }> {
  const q = query?.trim().toLowerCase();
  if (!q) return tools;
  const terms = q.split(/\s+/).filter(Boolean);
  const score = (t: { name: string; description: string }): number => {
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

function buildDeferredToolsApi(
  ctx: ToolContext,
  getRegistry: () => ToolRegistry,
): NonNullable<CodeModeApi["tools"]> {
  const deferred = () => getRegistry().all().filter(isDeferredWireTool);

  return {
    async search(query?: string) {
      const tools = deferred();
      if (tools.length === 0) return "No deferred tools are available.";
      const ranked = rankDeferred(
        tools.map((t) => ({
          name: t.name,
          description: t.description.replace(/^\[mcp:[^\]]+\]\s*/, ""),
        })),
        query,
      );
      if (ranked.length === 0) {
        return `No deferred tools match "${query}". Omit the query to list all.`;
      }
      const out: string[] = [];
      let used = 0;
      let shown = 0;
      for (const t of ranked) {
        const line = `- ${t.name}: ${t.description}`;
        if (used + line.length > TOOLS_SEARCH_CHAR_BUDGET && shown > 0) break;
        out.push(line);
        used += line.length + 1;
        shown += 1;
      }
      const omitted = ranked.length - shown;
      const header = query
        ? `Deferred tools matching "${query}" (${ranked.length}):`
        : `Deferred tools (${tools.length}):`;
      const footer =
        omitted > 0
          ? `\n…and ${omitted} more — narrow with tools.search(query).`
          : "";
      return `${header}\n${out.join("\n")}${footer}`;
    },
    async describe(name: string) {
      const tool = deferred().find((t) => t.name === name);
      if (!tool) {
        return `Unknown deferred tool: ${name}. Use tools.search() first.`;
      }
      const raw =
        tool.mcpMeta?.jsonSchema && typeof tool.mcpMeta.jsonSchema === "object"
          ? tool.mcpMeta.jsonSchema
          : zodToJsonSchema(tool.inputSchema);
      return (
        `${tool.name}\n${tool.description}\n\nInput schema (JSON):\n` +
        "```json\n" +
        JSON.stringify(raw, null, 2) +
        "\n```"
      );
    },
    async call(name: string, args?: Record<string, unknown>) {
      const tool = deferred().find((t) => t.name === name);
      if (!tool) {
        throw new Error(
          `Unknown deferred tool: ${name}. Use tools.search() / tools.describe() first.`,
        );
      }
      let r: ToolResult;
      if (ctx.callDeferredTool) {
        r = await ctx.callDeferredTool(name, args ?? {});
      } else {
        // Minimal / test contexts: mode gate + direct execute (no permission UI).
        const mode = ctx.agentMode ?? "agent";
        if (filterToolsByMode([tool], mode).length === 0) {
          throw new Error(`tool ${name} is not allowed in ${mode} mode`);
        }
        r = await tool.execute((args ?? {}) as never, ctx);
      }
      if (r.isError) throw new Error(r.content);
      return r.content;
    },
  };
}

function buildApi(
  ctx: ToolContext,
  getRegistry?: () => ToolRegistry,
): CodeModeApi {
  const api: CodeModeApi = {
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
      const r = await lsTool.execute(path !== undefined ? { path } : {}, ctx);
      if (r.isError) throw new Error(r.content);
      return r.content;
    },
  };
  if (getRegistry) {
    api.tools = buildDeferredToolsApi(ctx, getRegistry);
  }
  return api;
}

/** Curated helper names — IPC + vm globals. */
const API_METHODS = [
  "readFile",
  "writeFile",
  "editFile",
  "bash",
  "grep",
  "glob",
  "ls",
] as const satisfies ReadonlyArray<keyof CodeModeApi>;


/** The common outcome of either runtime: the final expression value (or
 * undefined), captured console output, and an error message if the code threw
 * or the runtime failed. */
interface RunOutcome {
  result: unknown;
  stdoutLines: string[];
  stderrLines: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Runtime: in-process vm (default)
// ---------------------------------------------------------------------------

async function runInVm(
  code: string,
  timeout: number,
  api: CodeModeApi,
): Promise<RunOutcome> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const sandbox = Object.create(null) as Record<string, unknown>;
  for (const name of API_METHODS) sandbox[name] = api[name];
  if (api.tools) sandbox.tools = api.tools;
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

  // Wrap user code in an async IIFE so top-level await works.
  const wrapped = `(async () => {\n${code}\n})()`;

  let result: unknown;
  let error: string | undefined;
  try {
    const script = new vm.Script(wrapped, { filename: "code_mode.js" });
    const promise: Promise<unknown> = script.runInContext(vmCtx, {
      timeout,
      breakOnSigint: false,
    });
    result = await promise;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return { result, stdoutLines, stderrLines, ...(error !== undefined ? { error } : {}) };
}

// ---------------------------------------------------------------------------
// Runtime: subprocess (opt-in, OS-sandboxed)
// ---------------------------------------------------------------------------

// The runner executed inside the child Node process. It reads the user code
// from a file (argv[2]), exposes the same API surface as the vm runtime, and
// talks to the parent over a tiny line-delimited JSON protocol on stdio:
//   child → parent (stdout):
//     {"t":"call","id":N,"fn":"readFile","args":[...]}  request a tool call
//     {"t":"log","stream":"out"|"err","text":"..."}      console output
//     {"t":"done","ok":true,"result":<json>}             final value
//     {"t":"done","ok":false,"error":"..."}              threw
//   parent → child (stdin):
//     {"t":"reply","id":N,"ok":true,"value":<json>}      tool call result
//     {"t":"reply","id":N,"ok":false,"error":"..."}      tool call failed
// Each API method serialises a `call`, parks a promise keyed by id, and
// resolves when the matching `reply` arrives — reproducing the in-process
// async contract (string result, thrown Error on isError) over IPC.
const RUNNER_SOURCE = `
"use strict";
const fs = require("node:fs");
const API = ${JSON.stringify(API_METHODS)};
const HAS_TOOLS = process.argv[3] === "1";
const userCode = fs.readFileSync(process.argv[2], "utf-8");

let seq = 0;
const pending = new Map();
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function callParent(fn, args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: "call", id, fn, args });
  });
}

// Drain line-delimited replies from stdin.
let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.t === "reply") {
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error || "tool call failed"));
    }
  }
});

const sandbox = { console: {
  log: (...a) => send({ t: "log", stream: "out", text: a.map(String).join(" ") }),
  error: (...a) => send({ t: "log", stream: "err", text: a.map(String).join(" ") }),
  warn: (...a) => send({ t: "log", stream: "err", text: a.map(String).join(" ") }),
} };
for (const fn of API) sandbox[fn] = (...args) => callParent(fn, args);
if (HAS_TOOLS) {
  sandbox.tools = {
    search: (query) => callParent("tools_search", [query]),
    describe: (name) => callParent("tools_describe", [name]),
    call: (name, args) => callParent("tools_call", [name, args]),
  };
}

(async () => {
  const names = Object.keys(sandbox);
  const vals = names.map((n) => sandbox[n]);
  try {
    const body = "return (async () => {\\n" + userCode + "\\n})();";
    const runner = new Function(...names, body);
    const result = await runner(...vals);
    let json;
    try { json = result === undefined ? undefined : JSON.parse(JSON.stringify(result)); }
    catch { json = String(result); }
    send({ t: "done", ok: true, result: json });
  } catch (err) {
    send({ t: "done", ok: false, error: err && err.message ? err.message : String(err) });
  }
})();
`;

async function runInSubprocess(
  code: string,
  timeout: number,
  api: CodeModeApi,
  ctx: ToolContext,
): Promise<RunOutcome> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  // Stage the runner + the user code in a temp dir. Reads are always permitted
  // by the sandbox (`/ ro`), so the child can read its own script.
  const base = ctx.scratchDir ?? os.tmpdir();
  const dir = await fs.mkdtemp(path.join(base, "codemode-"));
  const runnerPath = path.join(dir, "runner.cjs");
  const codePath = path.join(dir, "user.js");
  await fs.writeFile(runnerPath, RUNNER_SOURCE, "utf-8");
  await fs.writeFile(codePath, code, "utf-8");

  const nodeBin = process.execPath;
  const hasTools = api.tools ? "1" : "0";
  const inner = `${shellQuoteArg(nodeBin)} ${shellQuoteArg(runnerPath)} ${shellQuoteArg(codePath)} ${hasTools}`;
  const policy = ctx.sandbox ?? resolveSandbox(undefined, ctx.cwd);
  const wrapped = wrapCommand(inner, policy);

  const isWin = process.platform === "win32";
  const shell =
    wrapped.shell ?? (isWin ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh");
  const shellArgs = wrapped.shellArgs ?? (isWin ? ["/d", "/s", "/c"] : ["-c"]);

  let result: unknown;
  let error: string | undefined;

  await new Promise<void>((resolve) => {
    const child = spawn(shell, [...shellArgs, wrapped.command], {
      cwd: ctx.cwd,
      env: modelShellEnv(process.env, ctx.config?.shellEnv),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let settled = false;
    let outBuf = "";
    let errBuf = "";
    let done = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      resolve();
    };

    const reply = (obj: unknown): void => {
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch {
        /* child gone */
      }
    };

    const handleMessage = async (msg: Record<string, unknown>): Promise<void> => {
      if (msg.t === "log") {
        const text = String(msg.text ?? "");
        if (msg.stream === "err") stderrLines.push(text);
        else stdoutLines.push(text);
        return;
      }
      if (msg.t === "call") {
        const id = msg.id;
        const fn = String(msg.fn);
        const args = Array.isArray(msg.args) ? msg.args : [];
        try {
          let value: unknown;
          if ((API_METHODS as ReadonlyArray<string>).includes(fn)) {
            value = await (api[fn as keyof CodeModeApi] as (
              ...a: unknown[]
            ) => Promise<unknown>)(...args);
          } else if (fn === "tools_search" && api.tools) {
            value = await api.tools.search(
              typeof args[0] === "string" ? args[0] : undefined,
            );
          } else if (fn === "tools_describe" && api.tools) {
            value = await api.tools.describe(String(args[0] ?? ""));
          } else if (fn === "tools_call" && api.tools) {
            value = await api.tools.call(
              String(args[0] ?? ""),
              (args[1] as Record<string, unknown> | undefined) ?? {},
            );
          } else {
            reply({ t: "reply", id, ok: false, error: `unknown API ${fn}` });
            return;
          }
          reply({ t: "reply", id, ok: true, value });
        } catch (err) {
          reply({
            t: "reply",
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      if (msg.t === "done") {
        done = true;
        if (msg.ok) result = msg.result;
        else error = String(msg.error ?? "code_mode subprocess failed");
        finish();
      }
    };

    const drain = (chunk: string): void => {
      outBuf += chunk;
      let nl: number;
      while ((nl = outBuf.indexOf("\n")) >= 0) {
        const line = outBuf.slice(0, nl);
        outBuf = outBuf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          // Non-protocol stdout (e.g. a native warning) — surface as output.
          stdoutLines.push(line);
          continue;
        }
        void handleMessage(msg);
      }
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", drain);
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      errBuf += chunk;
    });

    child.on("error", (err) => {
      if (!done) error = err instanceof Error ? err.message : String(err);
      finish();
    });
    child.on("close", () => {
      // If the child exited without a `done` frame, surface any stderr as the
      // error (e.g. the sandbox refused to launch the runner).
      if (!done && error === undefined) {
        error = errBuf.trim() || "code_mode subprocess exited without a result";
      } else if (errBuf.trim()) {
        for (const l of errBuf.trimEnd().split("\n")) stderrLines.push(l);
      }
      finish();
    });

    const terminate = (): void => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    };
    const onAbort = (): void => {
      if (!done) error = "aborted";
      terminate();
    };
    const timer = setTimeout(() => {
      if (!done) error = `code_mode timed out after ${timeout}ms`;
      terminate();
    }, timeout);
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort);
    }
  });

  // Best-effort cleanup of the staged temp dir.
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }

  return {
    result,
    stdoutLines,
    stderrLines,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Minimal POSIX single-quote escaping for a single argv token embedded in the
 * `sh -c` command string the sandbox wrap runs. */
function shellQuoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const CODE_MODE_DESCRIPTION =
  "Run plain JavaScript (no TypeScript) in a sandbox with async helpers: " +
  "readFile, writeFile, editFile, bash, grep, glob, ls, and tools.search/describe/call " +
  "for deferred (off-wire) tools such as MCP. " +
  "OS sandbox/path guard still apply; curated helpers have no per-call permission prompts " +
  "(agent mode only); tools.call uses the normal permission path. " +
  "Use for multi-step control flow; prefer dedicated tools for a single direct call. " +
  "Large output spills to an artifact (read_artifact).";

function assembleCodeModeResult(
  outcome: RunOutcome,
  codeHint: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { result, stdoutLines, stderrLines, error } = outcome;
  const parts: string[] = [];
  if (stdoutLines.length > 0) parts.push(stdoutLines.join("\n"));
  if (stderrLines.length > 0) {
    parts.push((stdoutLines.length > 0 ? "\n" : "") + stderrLines.join("\n"));
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
  return spillHeadTail(ctx, content, `code_mode:${codeHint}`).then((spilled) => ({
    content: spilled.content,
    isError: error !== undefined,
    artifactRef: spilled.artifactRef,
  }));
}

/**
 * Build a `code_mode` tool bound to a live registry so deferred tools are
 * reachable via `tools.search` / `tools.describe` / `tools.call`.
 */
export function makeCodeModeTool(
  getRegistry?: () => ToolRegistry,
): ToolDef<typeof schema> {
  return {
    name: "code_mode",
    description: CODE_MODE_DESCRIPTION,
    inputSchema: schema,
    permission: "execute",
    async execute(input, ctx) {
      const timeout = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
      const api = buildApi(ctx, getRegistry);
      const runtime = ctx.config?.codeMode?.runtime ?? "vm";
      const outcome =
        runtime === "subprocess"
          ? await runInSubprocess(input.code, timeout, api, ctx)
          : await runInVm(input.code, timeout, api);
      return assembleCodeModeResult(outcome, input.code.slice(0, 80), ctx);
    },
  };
}

/** Default singleton (no registry → no `tools.*` deferred API). Prefer
 * {@link makeCodeModeTool} at session register time. */
export const codeModeTool: ToolDef<typeof schema> = makeCodeModeTool();
