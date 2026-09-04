// bash tool: run shell commands — foreground (with timeout, truncation and
// artifact spill) or background (detached job, polled via bash_output).
//
// Commands are wrapped in the OS sandbox (sandbox-exec / bwrap / wsl-bwrap)
// according to the session's sandbox policy; see ../sandbox.js. Dangerous
// commands are force-asked by the permission engine before reaching here.

import { z } from "zod";
import { spawn } from "node:child_process";
import type { ToolDef } from "./types.js";
import { wrapCommand, resolveSandbox } from "../sandbox.js";
import { spawnBackgroundJob } from "./bashJobs.js";

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
    .describe("Max wall-clock time in ms (default 60_000). Ignored for background jobs."),
  cwd: z.string().optional().describe("Override working directory."),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run detached and return immediately with a job id. Use for long-running " +
        "commands (dev servers, watch-mode tests, builds you want to poll). " +
        "Read output with bash_output, stop with bash_kill."
    ),
});

export const bashTool: ToolDef<typeof schema> = {
  name: "bash",
  description:
    "Execute a shell command in the project working directory.\n\n" +
    "When to use: running tests/builds/linters, git queries, package-manager " +
    "commands, ad-hoc inspection that the dedicated tools can't do.\n" +
    "When NOT to use: reading files (use `read_file`/`grep`/`glob` — no shell " +
    "escaping, better output format), editing files (use `edit_file`/" +
    "`write_file`), or communicating with the user (just write text).\n\n" +
    "Foreground commands have a 60s default timeout (max 10 min via `timeout`), " +
    "a 5MB output cap, and spill outputs >8KB to an artifact (the result keeps " +
    "the head plus an `art_<hash>` ref — pull slices with `read_artifact`). " +
    "Set `run_in_background: true` for anything long-lived (dev server, watch " +
    "mode): the call returns a `job_<id>` immediately; poll with `bash_output`, " +
    "stop with `bash_kill`.\n\n" +
    "Commands run inside the configured OS sandbox (write access is confined to " +
    "the workspace). Dangerous commands (rm -rf, force-push, drop-table, " +
    "curl|sh, …) require explicit user authorisation — when in doubt, describe " +
    "what you would run instead of running it.",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    const timeout = input.timeout ?? 60_000;
    const cwd = input.cwd ?? ctx.cwd;
    const policy = ctx.sandbox ?? resolveSandbox(undefined, cwd);
    const wrapped = wrapCommand(input.command, policy);

    if (input.run_in_background) {
      const job = await spawnBackgroundJob({
        command: wrapped.command,
        cwd,
        shell: wrapped.shell ?? defaultShell(),
        shellArgs: wrapped.shellArgs ?? defaultShellArgs(),
        sandboxed: wrapped.sandboxed,
        sandboxBackend: wrapped.backend,
      });
      return {
        content:
          `started background job ${job.meta.id} (pid ${job.meta.pid ?? "?"})` +
          `${wrapped.sandboxed ? ` [sandboxed: ${wrapped.backend}]` : ""}\n` +
          `Use bash_output(job_id="${job.meta.id}") to read output, bash_kill to stop it.`,
      };
    }

    const result = await runCommand(wrapped.command, {
      cwd,
      timeout,
      signal: ctx.signal,
      shell: wrapped.shell ?? defaultShell(),
      shellArgs: wrapped.shellArgs ?? defaultShellArgs(),
    });
    let content = result.stdout;
    if (result.stderr.length > 0) {
      content += (content.length > 0 ? "\n" : "") + result.stderr;
    }
    if (wrapped.warning) {
      content = wrapped.warning + "\n" + content;
    }
    if (result.code !== 0) {
      content = `[exit ${result.code}]\n${content}`;
    }
    let artifactRef: string | undefined;
    if (content.length > ARTIFACT_THRESHOLD) {
      artifactRef = await ctx.artifact(content, `bash:${input.command.slice(0, 80)}`);
      content =
        content.slice(0, MAX_OUTPUT_CHARS) +
        `\n\n[truncated; full output saved to artifact ${artifactRef}]`;
    }
    return {
      content,
      isError: result.code !== 0 && result.signal !== "SIGTERM",
      artifactRef,
    };
  },
};

function defaultShell(): string {
  return process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh";
}

function defaultShellArgs(): string[] {
  return process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"];
}

interface RunOpts {
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
  shell: string;
  shellArgs: string[];
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function runCommand(cmd: string, opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(opts.shell, [...opts.shellArgs, cmd], {
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
