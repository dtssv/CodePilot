// bash tool: run shell commands with timeout, output truncation, artifact spill.

import { z } from "zod";
import { spawn } from "node:child_process";
import type { ToolDef } from "./types.js";

const MAX_OUTPUT_CHARS = 30_000;
const ARTIFACT_THRESHOLD = 8_000;

const schema = z.object({
  command: z.string().describe("Shell command to execute (run via /bin/sh -c)."),
  timeout: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Max wall-clock time in ms (default 60_000)."),
  cwd: z.string().optional().describe("Override working directory."),
});

export const bashTool: ToolDef<typeof schema> = {
  name: "bash",
  description:
    "Execute a shell command in the project working directory via `/bin/sh -c`. " +
    "Use for anything you would type at a terminal: running tests, build commands, " +
    "git queries, package-manager invocations, ad-hoc inspection (`ls`, `wc -l`, `head`). " +
    "Do NOT use for reading files — prefer `read_file` / `grep` / `glob` (no shell, no escaping). " +
    "Do NOT use for edits — prefer `edit_file` (search/replace). " +
    "Output above 8 KB is spilled to an artifact; the tool result returns the head and a `ref`. " +
    "Commands have a default 60s timeout (configurable up to 10 min) and a 5MB output cap. " +
    "Dangerous commands (`rm -rf /`, `git push --force`, `git reset --hard`, drop-table, " +
    "raw disk writes, etc.) require explicit user authorisation — when in doubt, do not run " +
    "them; describe what you would run instead. The command runs with the user's full environment.",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    const timeout = input.timeout ?? 60_000;
    const cwd = input.cwd ?? ctx.cwd;
    const result = await runCommand(input.command, { cwd, timeout, signal: ctx.signal });
    let content = result.stdout;
    if (result.stderr.length > 0) {
      content += (content.length > 0 ? "\n" : "") + result.stderr;
    }
    if (result.code !== 0) {
      content = `[exit ${result.code}]\n${content}`;
    }
    let artifactRef: string | undefined;
    let truncated = false;
    if (content.length > ARTIFACT_THRESHOLD) {
      truncated = true;
      artifactRef = await ctx.artifact(content, `bash:${input.command.slice(0, 80)}`);
      content =
        content.slice(0, MAX_OUTPUT_CHARS) +
        `\n\n[truncated; full output saved to artifact ${artifactRef}]`;
    }
    return {
      content: truncated ? content : content,
      isError: result.code !== 0 && result.signal !== "SIGTERM",
      artifactRef,
    };
  },
};

interface RunOpts {
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function runCommand(cmd: string, opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, opts.timeout);

    const onAbort = () => {
      killed = true;
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
    let totalOut = 0;
    const SOFT_CAP = 5 * 1024 * 1024; // 5 MB safety cap
    child.stdout.on("data", (b: Buffer) => {
      totalOut += b.length;
      if (totalOut > SOFT_CAP) {
        killed = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        return;
      }
      outChunks.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      totalOut += b.length;
      if (totalOut > SOFT_CAP) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        return;
      }
      errChunks.push(b);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: err.message,
        code: 1,
        signal: null,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        code: killed && code === null ? null : code,
        signal: signal as NodeJS.Signals | null,
      });
    });
  });
}
