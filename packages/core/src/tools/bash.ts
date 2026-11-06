// bash tool: run shell commands — foreground (with timeout, truncation and
// artifact spill) or background (detached job, polled via bash_output).
//
// Commands are wrapped in the OS sandbox (sandbox-exec / bwrap / wsl-bwrap)
// according to the session's sandbox policy; see ../sandbox.js. Dangerous
// commands are force-asked by the permission engine before reaching here.

import { z } from "zod";
import { spawn } from "node:child_process";
import type { ToolDef } from "./types.js";
import {
  wrapCommand,
  resolveSandbox,
  looksLikeSandboxWriteDenial,
  looksLikeSandboxNetworkDenial,
  modelShellEnv,
} from "../sandbox.js";
import { spillHeadTail } from "./_shared.js";
import { spawnBackgroundJob } from "./bashJobs.js";

const schema = z.object({
  command: z
    .string()
    .describe(
      "Required. The shell command string to execute via /bin/sh -c " +
        "(e.g. builds, tests, scripts, network fetches). This is the only way to run a process.",
    ),
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
      "Run detached and return a job id immediately. Use for long-running or long-lived " +
        "processes (servers, watchers, rendering/compute jobs) that can outlive a foreground " +
        "timeout. Poll with `bash_output`, stop with `bash_kill`.",
    ),
  escalate_sandbox: z
    .boolean()
    .optional()
    .describe(
      "Run THIS ONE command WITHOUT the OS sandbox (full host access), after a user " +
        "approval prompt. Use only when a command FAILED because the sandbox blocked it " +
        "— e.g. a dev server that needs the network while the sandbox denies it, or a " +
        "write the jail refuses. The escalation is for this single call only; it does " +
        "NOT change the session's sandbox. Always pair with `justification`. Do not use " +
        "it pre-emptively — try the normal (sandboxed) command first.",
    ),
  justification: z
    .string()
    .optional()
    .describe(
      "Required with `escalate_sandbox`: one sentence shown to the user explaining why " +
        "this exact command needs to run outside the sandbox.",
    ),
});

export const bashTool: ToolDef<typeof schema> = {
  name: "bash",
  description:
    "Execute a shell command (`command` required). Use for builds, tests, package managers, " +
    "network fetches, and any other process the task needs. " +
    "Not for creating or editing project files — use `write_file` / `edit_file` for that; " +
    "prefer `read_file` / `grep` / `glob` over shell for reading code. " +
    "Default timeout 60s (max 10m); output >8KB spills to an artifact (`read_artifact`). " +
    "Set `run_in_background: true` for long-lived jobs, then `bash_output` / `bash_kill`. " +
    "Foreground calls share one shell (`cd`/`export` persist). " +
    "OS sandbox limits writes to the workspace, `/tmp`, and `~/.codepilot`; put run " +
    "artifacts (generated files, caches, zips) under session `scratch_dir`, not `cwd/.tmp`.",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    const timeout = input.timeout ?? 60_000;
    const cwd = input.cwd ?? ctx.cwd;
    const basePolicy = ctx.sandbox ?? resolveSandbox(undefined, cwd);
    // Per-command escalation: run THIS command without the OS jail. The
    // permission engine has already forced (and the user granted) an approval
    // prompt to reach here — escalation is never auto-allowed. Ephemeral: we
    // only loosen the policy for this one wrap; ctx.sandbox (the session policy)
    // is untouched, so the next command is sandboxed again.
    const escalated = input.escalate_sandbox === true;
    const policy = escalated ? { ...basePolicy, mode: "off" as const } : basePolicy;
    const wrapped = wrapCommand(input.command, policy);

    if (input.run_in_background) {
      const job = await spawnBackgroundJob({
        command: wrapped.command,
        displayCommand: input.command,
        cwd,
        ownerSessionId: ctx.sessionId,
        shell: wrapped.shell ?? defaultShell(),
        shellArgs: wrapped.shellArgs ?? defaultShellArgs(),
        sandboxed: wrapped.sandboxed,
        sandboxBackend: wrapped.backend,
      });
      return {
        content:
          `started background job ${job.meta.id} (pid ${job.meta.pid ?? "?"})` +
          `${wrapped.sandboxed ? ` [sandboxed: ${wrapped.backend}]` : escalated ? ` [UNSANDBOXED — escalated]` : ""}\n` +
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
    if (ctx.persistentShell && !input.cwd && !escalated) {
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
    // Mechanistic: if the OS jail blocked this command, tell the model how to
    // recover — expand roots for a write, or escalate for a network/other
    // denial. Only when the command ran sandboxed AND was not already an
    // escalation (otherwise the advice is stale). We do not guess paths from
    // the command text.
    if (policy.mode !== "off" && wrapped.sandboxed && !escalated && code !== 0) {
      if (looksLikeSandboxWriteDenial(content)) {
        content +=
          `\n\n[sandbox] Write blocked by the OS jail (writable roots: ` +
          `${policy.writableRoots.join(", ")}). ` +
          `To work outside them: write via write_file/edit_file so the user can ` +
          `"Allow folder", or ask the user to add the directory to ` +
          `sandbox.writablePaths / approve a delivery-root expand. If a shell ` +
          `command genuinely needs host access, retry it with ` +
          `\`escalate_sandbox: true\` + a \`justification\` (runs that one command ` +
          `outside the sandbox after a user prompt).`;
      } else if (looksLikeSandboxNetworkDenial(content)) {
        content +=
          `\n\n[sandbox] This looks like a network failure caused by the OS jail ` +
          `(the sandbox restricts network egress). If this command legitimately ` +
          `needs the network, retry it with \`escalate_sandbox: true\` and a ` +
          `\`justification\` — that runs this one command outside the sandbox ` +
          `after a user approval prompt. Do not disable the sandbox for the whole ` +
          `session.`;
      }
    }
    // Spill large output to an artifact, keeping a head+tail inline view. This
    // preserves the start (the command's first lines / the first error) AND the
    // end (exit status, final summary, stack traces), which a head-only
    // truncation loses. Shared helper so the threshold/shape can't drift.
    const spilled = await spillHeadTail(ctx, content, `bash:${input.command.slice(0, 80)}`);
    content = spilled.content;
    const artifactRef = spilled.artifactRef;
    // Timeouts must surface as errors so the model changes approach (e.g.
    // background + bash_output). Soft-cancel via SIGTERM without a timeout
    // stays non-error so a user abort isn't mistaken for a failed command.
    const isError =
      timedOut ||
      (code !== null && code !== 0) ||
      signal === "SIGINT" ||
      signal === "SIGKILL";
    return {
      content,
      isError,
      artifactRef,
    };
  },
};

/** Collapse runs of mostly-unprintable lines (binary bytes decoded as UTF-8)
 * into one marker: they carry no information but cost tokens every turn. */
export function elideBinaryLines(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip binary / C0 junk from shell output
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
 // `close` never fires — so the tool hangs forever on a stuck
 // screenshot/dev-server command.
    const child = spawn(opts.shell, [...opts.shellArgs, cmd], {
      cwd: opts.cwd,
      env: modelShellEnv(),
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
