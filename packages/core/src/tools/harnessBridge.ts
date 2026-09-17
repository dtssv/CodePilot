// harness_bridge: invoke external AI coding harnesses (claude-code, codex,
// or a custom CLI) as sub-agents via subprocess protocol adaptation.
//
// Unlike `task` (which spawns an in-process CodePilot sub-agent), this tool
// delegates to an *external* agent binary: it runs the harness's CLI in
// one-shot/non-interactive mode, passes the prompt as an argument, captures
// stdout/stderr, and returns the harness's final output.
//
// Security posture (mirrors the bash tool):
//   - The subprocess command is wrapped in the session's OS sandbox
//     (seatbelt / bwrap / wsl-bwrap) via wrapCommand, so the harness runs
//     under the same write/network restrictions as the parent's bash.
//   - stdin is never piped ("ignore") — harnesses cannot hang waiting for
//     interactive input.
//   - Wall-clock timeout (default 2 min, max 10 min) enforced with SIGTERM.
//   - Combined output is truncated at 100 KB.

import { z } from "zod";
import { spawn } from "node:child_process";
import type { ToolDef } from "./types.js";
import { wrapCommand, resolveSandbox } from "../sandbox.js";

/** Hard cap on combined stdout+stderr returned to the model. */
const MAX_OUTPUT_CHARS = 100 * 1024; // 100 KB
/** Safety cap on buffered output; the child is killed beyond this. */
const SOFT_CAP_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT_MS = 120_000; // 2 min
const MAX_TIMEOUT_MS = 600_000; // 10 min

export const HARNESS_KINDS = ["claude-code", "codex", "custom"] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

const schema = z.object({
  harness: z
    .enum(HARNESS_KINDS)
    .describe(
      "Which external harness to invoke: \"claude-code\" (claude CLI), " +
        "\"codex\" (codex CLI), or \"custom\" (your own command)."
    ),
  prompt: z
    .string()
    .describe("The self-contained objective to hand to the external harness."),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the harness (default: session cwd)."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Max wall-clock time in ms (default 120000, max 600000)."),
  custom_command: z
    .string()
    .optional()
    .describe("Required when harness is \"custom\": the CLI command to run (e.g. \"my-agent\")."),
  custom_args: z
    .array(z.string())
    .optional()
    .describe("Additional arguments for a custom harness, inserted before the prompt."),
});

/** Shell-quote a single argument for `/bin/sh -c` (single-quote style). */
export function shellQuoteArg(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the shell command line for a harness invocation. Returned as a
 * single string because the sandbox wrapper (wrapCommand) operates on
 * shell command strings, exactly like the bash tool.
 */
export function buildHarnessCommand(input: {
  harness: HarnessKind;
  prompt: string;
  custom_command?: string;
  custom_args?: string[];
}): { ok: true; command: string } | { ok: false; error: string } {
  const prompt = shellQuoteArg(input.prompt);
  switch (input.harness) {
    case "claude-code":
      // One-shot print mode with a JSON envelope; we extract `.result`.
      return { ok: true, command: `claude -p --output-format json ${prompt}` };
    case "codex":
      // Non-interactive exec mode; final answer on stdout.
      return { ok: true, command: `codex exec ${prompt}` };
    case "custom": {
      const cmd = input.custom_command?.trim();
      if (!cmd) {
        return {
          ok: false,
          error: 'harness "custom" requires `custom_command` (the CLI to run).',
        };
      }
      const extras = (input.custom_args ?? []).map(shellQuoteArg);
      return {
        ok: true,
        command: [cmd, ...extras, prompt].join(" "),
      };
    }
    default:
      return { ok: false, error: `unknown harness: ${String(input.harness)}` };
  }
}

/**
 * Extract the model-facing output from a harness's stdout. claude-code's
 * `--output-format json` envelope is parsed for its `result` field; codex
 * and custom harnesses return raw text. Parse failures degrade gracefully
 * to the raw text.
 */
export function extractHarnessOutput(harness: HarnessKind, stdout: string): string {
  if (harness === "claude-code") {
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      if (typeof parsed.result === "string") return parsed.result;
      if (parsed.is_error === true) {
        return `claude-code reported an error: ${stdout.slice(0, 2_000)}`;
      }
    } catch {
      /* not JSON — fall through to raw text */
    }
  }
  return stdout;
}

interface RunHarnessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/** Spawn the harness with no stdin, piped output, timeout + abort wiring. */
function runHarnessCommand(
  cmd: string,
  opts: { cwd: string; timeout: number; signal?: AbortSignal }
): Promise<RunHarnessResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"], // no stdin: prevent interactive hangs
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, opts.timeout);

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let total = 0;
    const onChunk = (b: Buffer, sink: Buffer[]) => {
      total += b.length;
      if (total > SOFT_CAP_BYTES) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        return;
      }
      sink.push(b);
    };
    child.stdout.on("data", (b: Buffer) => onChunk(b, outChunks));
    child.stderr.on("data", (b: Buffer) => onChunk(b, errChunks));

    const done = (result: RunHarnessResult) => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.on("error", (err) => {
      // e.g. ENOENT when the harness CLI is not installed / not in PATH.
      done({
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: err.message,
        code: 1,
        signal: null,
        timedOut: false,
      });
    });
    child.on("close", (code, signal) => {
      done({
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        code,
        signal: signal as NodeJS.Signals | null,
        timedOut,
      });
    });
  });
}

export const harnessBridgeTool: ToolDef<typeof schema> = {
  name: "harness_bridge",
  description:
    "Invoke an external AI coding harness (claude-code, codex, or a custom CLI) " +
    "as a sub-agent. The harness runs as a sandboxed subprocess in one-shot mode, " +
    "receives your prompt, and its final output is returned to you.\n\n" +
    "When to use: delegating a self-contained task to a different agent runtime " +
    "(e.g. a second opinion from claude-code, or a codex-specific capability), or " +
    "bridging to an in-house harness via harness=\"custom\".\n" +
    "When NOT to use: work you can do yourself with the built-in tools, or tasks " +
    "that need interactive back-and-forth (the subprocess gets no stdin).\n\n" +
    "Built-in harnesses: \"claude-code\" runs `claude -p --output-format json` " +
    "(requires the `claude` CLI in PATH) and returns the JSON envelope's `result` " +
    "field; \"codex\" runs `codex exec` (requires the `codex` CLI in PATH) and " +
    "returns stdout. \"custom\" runs `custom_command custom_args... <prompt>` and " +
    "returns stdout. Output is truncated at 100KB; the default timeout is 2 " +
    "minutes (max 10). The subprocess inherits this session's OS sandbox " +
    "restrictions (write access confined to the workspace).",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    const built = buildHarnessCommand(input);
    if (!built.ok) {
      return { content: built.error, isError: true };
    }
    const cwd = input.cwd ?? ctx.cwd;
    const timeout = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    // Sandbox parity with bash: wrap the harness command in the session's
    // OS sandbox policy (no persistent shell — one-shot subprocess).
    const policy = ctx.sandbox ?? resolveSandbox(undefined, cwd);
    const wrapped = wrapCommand(built.command, policy);

    const r = await runHarnessCommand(wrapped.command, {
      cwd,
      timeout,
      signal: ctx.signal,
    });

    if (r.timedOut) {
      return {
        content:
          `harness_bridge: ${input.harness} timed out after ${timeout}ms ` +
          `(pid killed). Partial output:\n${truncate(r.stdout + (r.stderr ? "\n" + r.stderr : ""))}`,
        isError: true,
      };
    }

    // Spawn-level failure (e.g. CLI not found) surfaces via exit 127 from
    // sh, or a child "error" event message in stderr.
    const spawnFailed =
      r.stderr.includes("ENOENT") || r.stderr.includes("command not found") || r.code === 127;

    let output = extractHarnessOutput(input.harness, r.stdout);
    if (r.stderr.length > 0) {
      output += (output.length > 0 ? "\n" : "") + `[stderr]\n${r.stderr}`;
    }
    if (wrapped.warning) {
      output = wrapped.warning + "\n" + output;
    }
    if (r.code !== 0) {
      output = `[exit ${r.code ?? "?"}]\n${output}`;
    }
    output = truncate(output);
    if (output.trim().length === 0) {
      output = "(harness produced no output)";
    }

    return {
      content: output,
      isError: r.code !== 0 || spawnFailed,
    };
  },
};

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return (
    s.slice(0, MAX_OUTPUT_CHARS) +
    `\n\n[... output truncated at ${MAX_OUTPUT_CHARS.toLocaleString()} chars (${s.length.toLocaleString()} total) ...]`
  );
}
