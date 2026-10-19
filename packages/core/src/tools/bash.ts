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

/** Below this size, output is returned verbatim. Above, it spills to an
 * artifact and the inline view keeps the head + tail with a gap marker. */
const ARTIFACT_THRESHOLD = 8_000;
/** How many chars of head/tail to keep when truncating inline. Tuned so a
 * typical compile error block (head) + a stack tail fit comfortably. */
const HEAD_CHARS = 4_000;
const TAIL_CHARS = 4_000;

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
        "commands (dev servers, watch-mode tests, builds you want to poll) AND " +
        "for anything that launches a browser or does heavy rendering — headless " +
        "Chrome/Puppeteer/Playwright screenshots, PDF/image rendering, WebGL. " +
        "Those spawn child process trees that can outlive a foreground timeout " +
        "and stall the turn; run them detached and poll instead. " +
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
    "the head and tail plus an `art_<hash>` ref — pull slices with `read_artifact`). " +
    "Binary bytes (e.g. `cat` of a .gz) are elided. Every byte you print stays in " +
    "context for the rest of the task: sample data files with `wc -l` / `head -n 20` " +
    "instead of `cat`-ing whole logs, CSVs or fixtures. " +
    "Set `run_in_background: true` for anything long-lived (dev server, watch " +
    "mode): the call returns a `job_<id>` immediately; poll with `bash_output`, " +
    "stop with `bash_kill`. ALSO use background for browser/rendering commands " +
    "(headless Chrome screenshots, Puppeteer/Playwright, PDF or WebGL rendering): " +
    "they fork child-process trees that often outlive a foreground timeout — " +
    "run them detached and poll `bash_output`, don't block the turn on them.\n\n" +
    "In the main session foreground calls share one shell, so `cd` and `export` " +
    "persist between them (a sub-agent gets a fresh shell per call — chain with " +
    "`&&` there). File tools (read_file, edit_file, …) do NOT follow that `cd`: they " +
    "resolve relative paths against the workspace root — pass workspace-relative " +
    "or absolute paths to them.\n\n" +
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
        displayCommand: input.command,
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

 // Foreground: prefer the persistent shell (cwd/env persist across calls).
 // Fall back to a fresh `sh -c` child when no persistent shell is wired
 // (e.g. test harnesses) or when a custom cwd is requested (the
 // persistent shell's cwd is fixed at session start).
    let stdout: string;
    let stderr: string;
    let code: number | null;
    let signal: NodeJS.Signals | null;
    let timedOut: boolean;
    if (ctx.persistentShell && !input.cwd) {
 // The persistent shell runs the *unwrapped* command — the shell
 // itself was started inside the sandbox wrapper. Re-wrapping here
 // would double-sandbox. We pass the user's command verbatim.
 // (When sandbox mode is "off", wrapped.command === input.command.)
      const psResult = await ctx.persistentShell.run(input.command, {
        timeout,
        signal: ctx.signal,
      });
      stdout = psResult.stdout;
      stderr = psResult.stderr;
      code = psResult.exitCode;
      signal = psResult.signal;
      timedOut = psResult.timedOut;
    } else {
      const r = await runCommand(wrapped.command, {
        cwd,
        timeout,
        signal: ctx.signal,
        shell: wrapped.shell ?? defaultShell(),
        shellArgs: wrapped.shellArgs ?? defaultShellArgs(),
      });
      stdout = r.stdout;
      stderr = r.stderr;
      code = r.code;
      signal = r.signal;
      timedOut = false;
    }
    let content = stdout;
    if (stderr.length > 0) {
      content += (content.length > 0 ? "\n" : "") + stderr;
    }
    content = elideBinaryLines(content);
    if (wrapped.warning) {
      content = wrapped.warning + "\n" + content;
    }
    if (code !== 0) {
      content = `[exit ${code ?? (timedOut ? "timeout" : "?")}]\n${content}`;
    }
    let artifactRef: string | undefined;
    if (content.length > ARTIFACT_THRESHOLD) {
 // Spill the full output to an artifact, then render a head+tail view
 // inline with a gap marker. This preserves the start (where the
 // command's first lines / the first error usually live) AND the end
 // (where exit status, final summary, and stack traces land), which a
 // head-only truncation loses. same truncated head+tail shape.
      artifactRef = await ctx.artifact(content, `bash:${input.command.slice(0, 80)}`);
      const omitted = content.length - HEAD_CHARS - TAIL_CHARS;
      content =
        content.slice(0, HEAD_CHARS) +
        `\n\n[... ${omitted.toLocaleString()} chars omitted; full output in artifact ${artifactRef} — use read_artifact with startLine/maxLines for any slice ...]\n\n` +
        content.slice(content.length - TAIL_CHARS);
    }
    return {
      content,
      isError: code !== 0 && signal !== "SIGTERM",
      artifactRef,
    };
  },
};

/** Collapse runs of mostly-unprintable lines (binary bytes decoded as UTF-8)
 * into one marker: they carry no information but cost tokens every turn. */
export function elideBinaryLines(text: string): string {
 // eslint-disable-next-line no-control-regex
  const junk = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/g;
  if (!new RegExp(junk.source).test(text)) return text;
  const out: string[] = [];
  let run = 0;
  const flush = (): void => {
    if (run > 0) out.push(`[binary data omitted: ${run.toLocaleString()} bytes]`);
    run = 0;
  };
  for (const line of text.split("\n")) {
    const bad = line.match(junk)?.length ?? 0;
    if (line.length > 0 && bad / line.length > 0.1) {
      run += line.length + 1;
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

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
 // `detached: true` puts the child shell in its OWN process group, so we
 // can signal the ENTIRE tree (the shell AND everything it spawns — e.g.
 // headless Chrome's renderer/GPU children) with `process.kill(-pid)`.
 // Without this, `child.kill` only hits the shell wrapper; grandchildren
 // like Chrome survive as orphans, keep the stdout/stderr pipe open, and
 // `close` never fires — so the tool used to hang forever on a stuck
 // screenshot/dev-server command.
    const child = spawn(opts.shell, [...opts.shellArgs, cmd], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let killed = false;
    let settled = false;
    const pgid = child.pid;

 // Signal the whole process group; fall back to the single child when the
 // group signal isn't available (e.g. pid missing).
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (pgid) process.kill(-pgid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
 /* already gone */
        }
      }
    };

 // Resolve exactly once. After a kill we don't wait for `close` (orphaned
 // grandchildren can hold the pipe open indefinitely) — we read what we
 // have and return, so the agent loop never stalls on a wedged command.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        code,
        signal,
      });
    };

 // SIGTERM the group, then SIGKILL after a short grace period, then resolve
 // regardless (don't trust `close` for a wedged tree).
    const terminate = (): void => {
      killed = true;
      killGroup("SIGTERM");
      if (graceTimer) return;
      graceTimer = setTimeout(() => {
        killGroup("SIGKILL");
 // Give SIGKILL a beat to take; then resolve even if close never fires.
        setTimeout(() => finish(null, "SIGTERM"), 500);
      }, 2000);
    };

    const timer = setTimeout(terminate, opts.timeout);

    const onAbort = (): void => {
      terminate();
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
        terminate();
        return;
      }
      outChunks.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      totalOut += b.length;
      if (totalOut > SOFT_CAP) {
        terminate();
        return;
      }
      errChunks.push(b);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: err.message,
        code: 1,
        signal: null,
      });
    });
    child.on("close", (code, signal) => {
      finish(
        killed && code === null ? null : code,
        signal as NodeJS.Signals | null,
      );
    });
  });
}
