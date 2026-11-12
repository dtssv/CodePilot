// harness_bridge: run an external agent CLI as a sandboxed one-shot subprocess,
// pass the prompt, and return its final output. Unlike `task` (in-process
// sub-agent), this spawns another binary. Security: wrapped in the session's
// OS sandbox (same as bash), no stdin (no interactive hangs), wall-clock
// timeout (default 2 min, max 10 min), output truncated at 100 KB.

import { z } from "zod";
import { spawn } from "node:child_process";
import type { ToolDef } from "./types.js";
import { wrapCommand, resolveSandbox } from "../sandbox.js";
import { runCodexAppServerTurn } from "./harnessCodexProto.js";

/** Hard cap on combined stdout+stderr returned to the model. */
const MAX_OUTPUT_CHARS = 100 * 1024; // 100 KB
/** Safety cap on buffered output; the child is killed beyond this. */
const SOFT_CAP_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT_MS = 120_000; // 2 min
const MAX_TIMEOUT_MS = 600_000; // 10 min

export const HARNESS_KINDS = ["claude-code", "codex", "custom"] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

/** Env key-name substrings that mark a value as secret-looking. Matched
 * case-insensitively against the whole key. Deliberately broad: a spawned
 * external harness should not inherit the parent's credentials by default. */
const SECRET_KEY_PATTERNS = [
  "KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "CRED",
  "AUTH",
  "SESSION",
  "PRIVATE",
  "PASSPHRASE",
  "SIGNATURE",
  "APIKEY",
  "ACCESS_KEY",
] as const;

export interface ChildEnvScrubOptions {
  /** Master switch. Default true → secret-looking keys are removed. */
  scrubSecrets?: boolean;
  /** Exact key names to keep despite matching a secret pattern. */
  envKeep?: string[];
  /** Exact key names to force-remove in addition to the patterns. */
  envScrub?: string[];
}

/** Whether an env key name looks like a secret. */
export function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_KEY_PATTERNS.some((p) => upper.includes(p));
}

/** Build the child env for a spawned harness. By default secret-looking keys
 * are dropped so the child can't read the parent's credentials; `envKeep`
 * adds keys back, `envScrub` removes more. `scrubSecrets:false` inherits all. */
export function scrubChildEnv(
  base: NodeJS.ProcessEnv,
  opts: ChildEnvScrubOptions = {},
): NodeJS.ProcessEnv {
  if (opts.scrubSecrets === false) return { ...base };
  const keep = new Set(opts.envKeep ?? []);
  const forceScrub = new Set(opts.envScrub ?? []);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (forceScrub.has(key)) continue;
    if (keep.has(key)) {
      out[key] = value;
      continue;
    }
    if (isSecretEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

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
  backend: z
    .enum(["cli", "protocol"])
    .optional()
    .describe(
      "Transport for the harness. \"cli\" (default) runs the one-shot CLI and " +
        "returns its output. \"protocol\" drives the harness's official protocol " +
        "(currently only \"codex\" via its app-server) for a structured final " +
        "answer; it is only honoured when enabled in config and falls back to " +
        "\"cli\" otherwise.",
    ),
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

/** Extract model-facing output from harness stdout. claude-code's JSON
 * envelope is parsed for its `result` field; codex and custom harnesses
 * return raw text. Parse failures fall back to raw text. */
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
  opts: { cwd: string; timeout: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
): Promise<RunHarnessResult> {
  return new Promise((resolve) => {
    // detached so we can kill the whole process group (sh -c sleep … leaves
    // grandchildren that otherwise keep stdout open and hang `close`).
    // Windows has no POSIX /bin/sh; use cmd.exe like the bash tool does.
    const isWin = process.platform === "win32";
    const shell = isWin ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh";
    const shellArgs = isWin ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
    const child = spawn(shell, shellArgs, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"], // no stdin: prevent interactive hangs
      detached: true,
    });
    let timedOut = false;
    let settled = false;
    const killTree = (sig: NodeJS.Signals) => {
      // Process-group kill is Unix-only (`-pid`); Windows falls back to child.kill.
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, sig);
        } catch {
 /* ignore — group may already be gone */
        }
      }
      try {
        child.kill(sig);
      } catch {
 /* ignore */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      // Escalate: some CI hosts leave `sleep` / stubborn children alive after SIGTERM.
      setTimeout(() => {
        killTree("SIGKILL");
        // Guarantee the Promise settles even if `close` never fires.
        setTimeout(() => {
          done({
            stdout: Buffer.concat(outChunks).toString("utf-8"),
            stderr: Buffer.concat(errChunks).toString("utf-8"),
            code: null,
            signal: "SIGKILL",
            timedOut: true,
          });
        }, 500).unref?.();
      }, 1_000).unref?.();
    }, opts.timeout);

    const onAbort = () => {
      killTree("SIGTERM");
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
        killTree("SIGTERM");
        return;
      }
      sink.push(b);
    };
    child.stdout?.on("data", (b: Buffer) => onChunk(b, outChunks));
    child.stderr?.on("data", (b: Buffer) => onChunk(b, errChunks));

    const done = (result: RunHarnessResult) => {
      if (settled) return;
      settled = true;
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
    "(e.g. a second opinion from another CLI harness), or " +
    "bridging to an in-house harness via harness=\"custom\".\n" +
    "When NOT to use: work you can do yourself with the built-in tools, or tasks " +
    "that need interactive back-and-forth (the subprocess gets no stdin).\n\n" +
    "Built-in harnesses: \"claude-code\" runs `claude -p --output-format json` " +
    "(requires the `claude` CLI in PATH) and returns the JSON envelope's `result` " +
    "field; \"codex\" runs `codex exec` (requires the `codex` CLI in PATH) and " +
    "returns stdout. \"custom\" runs `custom_command custom_args... <prompt>` and " +
    "returns stdout. Output is truncated at 100KB; the default timeout is 2 " +
    "minutes (max 10). The subprocess inherits this session's OS sandbox " +
    "restrictions (write access confined to the workspace).\n" +
    "Backend: by default the CLI is scraped. Set backend=\"protocol\" with " +
    "harness=\"codex\" to drive its app-server protocol for a structured final " +
    "answer; this is only honoured when enabled in config and otherwise falls " +
    "back to the CLI.",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    // Recursion guard, shared in spirit with `task`: invoking an external
    // harness is still delegation, and the harness may itself recurse (another
    // CodePilot/claude/codex that fans out further). Without this, a sub-agent
    // already at the max `task` nesting depth could sidestep the fork-bomb brake
    // by shelling out to a harness instead. Refuse past the same `subagentMaxDepth`.
    const currentDepth = ctx.subagentDepth ?? 0;
    const maxDepth = ctx.config?.subagentMaxDepth ?? 3;
    if (currentDepth >= maxDepth) {
      return {
        content:
          `Refused: harness_bridge at sub-agent depth ${currentDepth} would exceed the ` +
          `max delegation depth ${maxDepth}. A sub-agent this deep must do the work ` +
          `itself rather than delegate to an external harness.`,
        isError: true,
      };
    }
    const cwd = input.cwd ?? ctx.cwd;
    const timeout = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    // Official-protocol backend (opt-in). Only `codex` ships one here, and only
    // when config allows it; otherwise we fall through to the CLI path. The
    // model asks for it via `backend: "protocol"`.
    const bridgeCfg = ctx.config?.harnessBridge;
    // Scrub secret-looking env keys from the child's environment by default so
    // the spawned harness can't read the parent's credentials. Shared by both
    // backends; overlay via config (scrubSecrets / envKeep / envScrub).
    const childEnv = scrubChildEnv(process.env, {
      scrubSecrets: bridgeCfg?.scrubSecrets,
      envKeep: bridgeCfg?.envKeep,
      envScrub: bridgeCfg?.envScrub,
    });
    if (input.backend === "protocol") {
      if (input.harness === "codex" && bridgeCfg?.allowProtocol) {
        const res = await runCodexAppServerTurn(input.prompt, {
          command: bridgeCfg.codexAppServerCommand,
          cwd,
          env: childEnv,
          timeoutMs: timeout,
          signal: ctx.signal,
        });
        if (res.timedOut) {
          return {
            content: `harness_bridge: codex app-server timed out after ${timeout}ms.`,
            isError: true,
          };
        }
        if (!res.ok || res.finalText.length === 0) {
          // Fall back to the CLI path rather than failing outright — the
          // protocol backend is best-effort and the CLI is the safety net.
          const note =
            res.diagnostics.length > 0
              ? `[protocol backend unavailable: ${res.diagnostics.join("; ")}; using CLI]\n`
              : "[protocol backend produced no answer; using CLI]\n";
          const cli = await runCliHarness(input, cwd, timeout, ctx, childEnv);
          return { ...cli, content: note + cli.content };
        }
        return { content: res.finalText, isError: false };
      }
      // Protocol requested but not available → transparent CLI fallback.
    }

    const cli = await runCliHarness(input, cwd, timeout, ctx, childEnv);
    return cli;
  },
};

/** Run the external harness through its one-shot CLI (the default and the
 * fallback). Extracted so both the direct path and the protocol-fallback path
 * share one implementation. */
async function runCliHarness(
  input: { harness: HarnessKind; prompt: string; custom_command?: string; custom_args?: string[] },
  cwd: string,
  timeout: number,
  ctx: Parameters<NonNullable<typeof harnessBridgeTool.execute>>[1],
  childEnv?: NodeJS.ProcessEnv,
): Promise<{ content: string; isError: boolean }> {
    const built = buildHarnessCommand(input);
    if (!built.ok) {
      return { content: built.error, isError: true };
    }

 // Sandbox parity with bash: wrap the harness command in the session's
 // OS sandbox policy (no persistent shell — one-shot subprocess).
    const policy = ctx.sandbox ?? resolveSandbox(undefined, cwd);
    const wrapped = wrapCommand(built.command, policy);

    const r = await runHarnessCommand(wrapped.command, {
      cwd,
      timeout,
      signal: ctx.signal,
      env: childEnv,
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
    const failed = r.code !== 0 || spawnFailed;

    let output = extractHarnessOutput(input.harness, r.stdout);
    // Result contract: on SUCCESS the model sees only the harness's final
    // output — stderr is the harness's own diagnostics/log noise and is NOT
    // merged in. On FAILURE, stderr is the safe diagnostic needed to explain
    // the error, so it is included (behind an [exit] marker).
    if (failed && r.stderr.length > 0) {
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
      isError: failed,
    };
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return (
    s.slice(0, MAX_OUTPUT_CHARS) +
    `\n\n[... output truncated at ${MAX_OUTPUT_CHARS.toLocaleString()} chars (${s.length.toLocaleString()} total) ...]`
  );
}
