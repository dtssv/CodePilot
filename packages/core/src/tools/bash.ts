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
  type ShellEnvOptions,
} from "../sandbox/sandbox.js";
import { spillHeadTail } from "./_shared.js";
import { adoptBackgroundJob, spawnBackgroundJob } from "./bashJobs.js";
import type { ChildProcess } from "node:child_process";

const schema = z.object({
  command: z.string().describe("Shell command (login shell -c; default $SHELL or /bin/sh)."),
  timeout: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe(
      "Max wall-clock ms for foreground wait (default 60_000). On timeout the process " +
        "continues as a background job. Ignored when run_in_background is true.",
    ),
  cwd: z.string().optional().describe("Override working directory."),
  shell: z
    .string()
    .optional()
    .describe("Override shell binary (default: $SHELL, else /bin/sh or COMSPEC)."),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Detach as a background job; returns job id. Poll `bash_output`, send input with " +
        "`write_stdin`, stop with `bash_kill`.",
    ),
  tty: z
    .boolean()
    .optional()
    .describe(
      "Background only. Allocate a PTY (default false). Set true for " +
        "interactive prompts that need a TTY; pair with write_stdin.",
    ),
  escalate_sandbox: z
    .boolean()
    .optional()
    .describe(
      "THIS ONE command without OS sandbox (user must approve). Only after a sandboxed " +
        "attempt failed on the jail; pair with `justification`; does not change session policy.",
    ),
  justification: z
    .string()
    .optional()
    .describe("Required with `escalate_sandbox`: one sentence why this command needs host access."),
})
  .superRefine((v, ctx) => {
    if (v.escalate_sandbox === true && !(v.justification && v.justification.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "escalate_sandbox requires a non-empty `justification`",
        path: ["justification"],
      });
    }
  });

/**
 * Block bare `sleep N` (N≥2) in the foreground so the model uses
 * run_in_background instead of burning a turn on a poll delay. Sub-2s sleeps
 * (pacing) and sleeps inside pipelines/scripts are allowed.
 */
export function detectBlockedSleepPattern(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  // Every simple segment (split on && / || / ; / newline) — `x; sleep 5` must not slip through.
  const segments = trimmed.split(/\s*(?:&&|\|\||;|\n)\s*/).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const m = /^sleep\s+(\d+)\s*$/.exec(segments[i]!);
    if (!m) continue;
    const secs = parseInt(m[1]!, 10);
    if (secs < 2) continue;
    const rest = segments.slice(i + 1).join("; ");
    return rest ? `sleep ${secs} followed by: ${rest}` : `standalone sleep ${secs}`;
  }
  return null;
}

/** Read-only-ish git/status commands that can share a turn with file reads. */
function isConcurrencySafeBash(command: string): boolean {
  const c = command.trim();
  // Single simple command or pipes of read-only git/status tools.
  if (/[;&`]|\$\(|\n/.test(c)) return false;
  if (/\b(rm|mv|cp|chmod|chown|kill|reboot|shutdown|dd|mkfs|sudo)\b/i.test(c)) return false;
  return /^(git\s+(status|diff|log|show|branch|rev-parse|describe|ls-files|remote)\b|pwd|ls\b|echo\b|true|false|test\b|\[ )/i.test(
    c,
  );
}

export const bashTool: ToolDef<typeof schema> = {
  name: "bash",
  description:
    "Run a shell command for builds, tests, git, installs, and process control. " +
    "Prefer dedicated tools when they fit: read_file (not cat/head/tail), " +
    "edit_file/apply_patch (not sed/awk), write_file (not echo>/heredoc), " +
    "grep/glob (not find/grep/rg). Most bash calls serialize with write/execute tools; " +
    "read-only `git status`/`git diff`/`pwd` may share a turn with file reads. " +
    "Interactive → run_in_background + write_stdin (set `tty: true` when a PTY is required). " +
    "Do not foreground-`sleep` ≥2s to poll — use run_in_background instead. " +
    "Default timeout 60s (max 10m); on timeout continues as a background job " +
    "(bash_output / bash_kill). Large output → artifact. Scratch → scratch_dir.",
  inputSchema: schema,
  permission: "execute",
  concurrencySafe: (input) => isConcurrencySafeBash(input.command),
  async execute(input, ctx) {
    if (!input.run_in_background) {
      const sleepBlock = detectBlockedSleepPattern(input.command);
      if (sleepBlock) {
        return {
          content:
            `Blocked: ${sleepBlock}. Run long waits in the background with ` +
            `run_in_background: true — poll via bash_output when needed. ` +
            `For deliberate pacing keep sleep under 2 seconds.`,
          isError: true,
        };
      }
    }
    const timeout = input.timeout ?? 60_000;
    const cwd = input.cwd ?? ctx.cwd;
    const basePolicy = ctx.sandbox ?? resolveSandbox(undefined, cwd);
    // Per-command escalation: run THIS command without the OS jail. The
    // permission engine has already forced (and the user granted) an approval
    // prompt — or a matching session escalation Always grant covers this
    // pattern. Ephemeral: we only loosen the policy for this one wrap;
    // ctx.sandbox (the session policy) is untouched, so the next command is
    // sandboxed again.
    const escalated = input.escalate_sandbox === true;
    const policy = escalated ? { ...basePolicy, mode: "off" as const } : basePolicy;
    const wrapped = wrapCommand(input.command, policy);

    const shellBin = input.shell?.trim() || wrapped.shell || defaultShell();
    const shellArgs = wrapped.shellArgs ?? defaultShellArgs();

    if (input.run_in_background) {
      const job = await spawnBackgroundJob({
        command: wrapped.command,
        displayCommand: input.command,
        cwd,
        ownerSessionId: ctx.sessionId,
        shell: shellBin,
        shellArgs,
        sandboxed: wrapped.sandboxed,
        sandboxBackend: wrapped.backend,
        shellEnv: ctx.config?.shellEnv,
        // tty defaults false; opt in for interactive write_stdin.
        tty: input.tty === true,
      });
      const ptyNote =
        input.tty === true && !job.pty
          ? "\n[pty unavailable — pipe mode]"
          : "";
      return {
        content:
          `started background job ${job.meta.id} (pid ${job.meta.pid ?? "?"})` +
          `${wrapped.sandboxed ? ` [sandboxed: ${wrapped.backend}]` : escalated ? ` [UNSANDBOXED — escalated]` : ""}` +
          `${ptyNote}\n` +
          `Use bash_output(job_id="${job.meta.id}") to read output, write_stdin to send input, bash_kill to stop it.`,
      };
    }

    // Foreground uses a dedicated child so a wall-clock timeout can adopt the
    // still-running process into bashJobs (the session persistent shell cannot
    // detach one in-flight command without blocking later calls).
    const r = await runCommand(wrapped.command, {
      cwd,
      timeout,
      signal: ctx.signal,
      shell: shellBin,
      shellArgs,
      shellEnv: ctx.config?.shellEnv,
      onTimeout: "detach",
    });

    if (r.reason === "timeout" && r.proc) {
      const partial = [r.stdout, r.stderr].filter((s) => s.length > 0).join("\n");
      const job = await adoptBackgroundJob({
        proc: r.proc,
        command: wrapped.command,
        displayCommand: input.command,
        cwd,
        ownerSessionId: ctx.sessionId,
        sandboxed: wrapped.sandboxed,
        sandboxBackend: wrapped.backend,
        initialOutput: partial,
      });
      const preview = elideBinaryLines(partial).trim();
      const head = preview.length > 0 ? `\nOutput so far:\n${preview.slice(0, 4000)}` : "";
      return {
        content:
          `timed out after ${timeout}ms; continued as background job ${job.meta.id}` +
          `${wrapped.sandboxed ? ` [sandboxed: ${wrapped.backend}]` : escalated ? ` [UNSANDBOXED — escalated]` : ""}.` +
          ` Poll with bash_output(job_id="${job.meta.id}") for output/completion;` +
          ` bash_kill to stop it.` +
          head,
        // Not isError: the command is still running — abandoning would waste that work.
      };
    }

    // Prefer chronologically interleaved stdout/stderr when the runner recorded
    // chunk order; fall back to stdout-then-stderr for older result shapes.
    let content =
      r.interleaved && r.interleaved.length > 0
        ? r.interleaved
        : r.stdout +
          (r.stderr.length > 0
            ? (r.stdout.length > 0 ? "\n" : "") + `[stderr]\n${r.stderr}`
            : "");
    content = elideBinaryLines(content);
    if (wrapped.warning) {
      content = wrapped.warning + "\n" + content;
    }
    const timedOut = r.reason === "timeout";
    // Numeric exit_code for machines; keep human [exit …] prefix for models.
    const exitCodeNum =
      typeof r.code === "number"
        ? r.code
        : timedOut
          ? 124
          : r.signal
            ? 128 + (signalNumber(r.signal) ?? 0)
            : null;
    if (r.code !== 0 || timedOut) {
      content =
        `[exit ${r.code ?? (timedOut ? "timeout" : "?")}]\n` +
        (exitCodeNum !== null ? `exit_code: ${exitCodeNum}\n` : "") +
        content;
    } else if (exitCodeNum === 0) {
      content = `exit_code: 0\n${content}`;
    }
    // Mechanistic: if the OS jail blocked this command, tell the model how to
    // recover — expand roots for a write, or escalate for a network/other
    // denial. Only when the command ran sandboxed AND was not already an
    // escalation (otherwise the advice is stale). We do not guess paths from
    // the command text.
    if (policy.mode !== "off" && wrapped.sandboxed && !escalated && r.code !== 0) {
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
    const spilled = await spillHeadTail(ctx, content, `bash:${input.command.slice(0, 80)}`);
    content = spilled.content;
    const artifactRef = spilled.artifactRef;
    // Non-zero exit is data (grep/diff/test). isError only when the command did
    // not finish: hard kill/interrupt, or a timeout that could not be detached
    // (e.g. output soft-cap kill). Soft abort stays non-error.
    const isError =
      timedOut || r.signal === "SIGINT" || r.signal === "SIGKILL";
    return {
      content,
      isError,
      artifactRef,
    };
  },
};

/**
 * CSI / OSC / single-char ESC sequences. Must be stripped *before* the binary
 * heuristic — `\u001b` sits in C0 and colored Gradle/Maven/npm lines otherwise
 * look >10% "junk" and get replaced with `[binary data omitted]`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI ESC sequences
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|\u001b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip binary / C0 junk from shell output
const BINARY_JUNK_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/g;

/** Collapse runs of mostly-unprintable lines (binary bytes decoded as UTF-8)
 * into one marker: they carry no information but cost tokens every turn.
 * ANSI color/style is ignored for the junk ratio so build tool logs stay. */
export function elideBinaryLines(text: string): string {
  if (!text.includes("\u001b") && !BINARY_JUNK_RE.test(text)) return text;
  BINARY_JUNK_RE.lastIndex = 0;
  const out: string[] = [];
  let run = 0;
  const flush = (): void => {
    if (run > 0) out.push(`[binary data omitted: ${run.toLocaleString()} bytes]`);
    run = 0;
  };
  for (const line of text.split("\n")) {
    const cleaned = line.replace(ANSI_RE, "");
    ANSI_RE.lastIndex = 0;
    const bad = cleaned.match(BINARY_JUNK_RE)?.length ?? 0;
    BINARY_JUNK_RE.lastIndex = 0;
    if (cleaned.length > 0 && bad / cleaned.length > 0.1) {
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
  if (process.platform === "win32") return process.env.COMSPEC ?? "cmd.exe";
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return "/bin/sh";
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
  shellEnv?: ShellEnvOptions;
  /**
   * Wall-clock timeout behaviour. `kill` (default): SIGTERM the process group.
   * `detach`: leave the process running and return it as `proc` so the caller
   * can adopt it into the background job registry.
   */
  onTimeout?: "kill" | "detach";
}

interface RunResult {
  stdout: string;
  stderr: string;
  /** stdout/stderr merged in arrival order (stream switches annotated). */
  interleaved?: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Why the wait ended. "ok": process exited. "timeout": wall clock or soft-cap.
   * "abort": caller's AbortSignal. */
  reason: "ok" | "timeout" | "abort";
  /** Present when `onTimeout: "detach"` fired — process is still running. */
  proc?: ChildProcess;
}

/** Merge stdout/stderr chunks in arrival order; annotate stream switches. */
function joinInterleaved(chunks: { stream: "out" | "err"; data: Buffer }[]): string {
  if (chunks.length === 0) return "";
  let out = "";
  let last: "out" | "err" | null = null;
  for (const c of chunks) {
    if (c.stream === "err" && last !== "err") {
      out += out.length > 0 && !out.endsWith("\n") ? "\n" : "";
      out += "[stderr]\n";
    } else if (c.stream === "out" && last === "err") {
      out += out.length > 0 && !out.endsWith("\n") ? "\n" : "";
      out += "[stdout]\n";
    }
    out += c.data.toString("utf-8");
    last = c.stream;
  }
  return out;
}

/** Keep the last `cap` bytes of a stream in memory. */
function createByteTail(cap: number): { push(b: Buffer): void; toBuffer(): Buffer } {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(b: Buffer) {
      chunks.push(b);
      size += b.length;
      while (size > cap && chunks.length > 1) {
        const drop = chunks.shift()!;
        size -= drop.length;
      }
      if (size > cap && chunks.length === 1) {
        const only = chunks[0]!;
        chunks[0] = only.subarray(only.length - cap);
        size = chunks[0]!.length;
      }
    },
    toBuffer() {
      return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, size);
    },
  };
}

function signalNumber(sig: NodeJS.Signals): number | null {
  const map: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return map[sig] ?? null;
}

function runCommand(cmd: string, opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    // Own process group so we can signal the shell and its grandchildren.
    // stdin ignored: interactive input → run_in_background + write_stdin (PTY).
    // Leaving a pipe open with no writer hangs readers (cat/ssh/npm init) until timeout.
    const child = spawn(opts.shell, [...opts.shellArgs, cmd], {
      cwd: opts.cwd,
      env: modelShellEnv(process.env, opts.shellEnv),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let killed = false;
    let settled = false;
    let termCause: "timeout" | "abort" | null = null;
    const pgid = child.pid;
    const onTimeout = opts.onTimeout ?? "kill";

    // Bounded in-memory tails (soft-cap still detaches/kills the process).
    const OUT_CAP = Math.floor((50 * 1024) / 3);
    const ERR_CAP = Math.floor((50 * 1024) * (2 / 3));
    const outTail = createByteTail(OUT_CAP);
    const errTail = createByteTail(ERR_CAP);
    const streamChunks: { stream: "out" | "err"; data: Buffer }[] = [];
    let totalOut = 0;
    const SOFT_CAP = 5 * 1024 * 1024;
    const INTERLEAVE_CAP = 50 * 1024;
    let interleaveBytes = 0;

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

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: outTail.toBuffer().toString("utf-8"),
        stderr: errTail.toBuffer().toString("utf-8"),
        interleaved: joinInterleaved(streamChunks),
        code,
        signal,
        reason: termCause ?? "ok",
      });
    };

    const terminate = (cause: "timeout" | "abort"): void => {
      killed = true;
      if (termCause === null) termCause = cause;
      killGroup("SIGTERM");
      if (graceTimer) return;
      graceTimer = setTimeout(() => {
        killGroup("SIGKILL");
        setTimeout(() => finish(null, "SIGTERM"), 500);
      }, 2000);
    };

    /** Hand the still-running child to the caller without killing it. */
    const detachForTimeout = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      resolve({
        stdout: outTail.toBuffer().toString("utf-8"),
        stderr: errTail.toBuffer().toString("utf-8"),
        interleaved: joinInterleaved(streamChunks),
        code: null,
        signal: null,
        reason: "timeout",
        proc: child,
      });
    };

    timer = setTimeout(() => {
      if (onTimeout === "detach") detachForTimeout();
      else terminate("timeout");
    }, opts.timeout);

    const onAbort = (): void => {
      terminate("abort");
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const hitSoftCap = (): void => {
      if (onTimeout === "detach") detachForTimeout();
      else terminate("timeout");
    };
    child.stdout?.on("data", (b: Buffer) => {
      totalOut += b.length;
      if (totalOut > SOFT_CAP) {
        hitSoftCap();
        return;
      }
      outTail.push(b);
      if (interleaveBytes < INTERLEAVE_CAP) {
        const take = b.subarray(0, Math.min(b.length, INTERLEAVE_CAP - interleaveBytes));
        streamChunks.push({ stream: "out", data: Buffer.from(take) });
        interleaveBytes += take.length;
      }
    });
    child.stderr?.on("data", (b: Buffer) => {
      totalOut += b.length;
      if (totalOut > SOFT_CAP) {
        hitSoftCap();
        return;
      }
      errTail.push(b);
      if (interleaveBytes < INTERLEAVE_CAP) {
        const take = b.subarray(0, Math.min(b.length, INTERLEAVE_CAP - interleaveBytes));
        streamChunks.push({ stream: "err", data: Buffer.from(take) });
        interleaveBytes += take.length;
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: outTail.toBuffer().toString("utf-8"),
        stderr: err.message,
        interleaved: joinInterleaved(streamChunks),
        code: 1,
        signal: null,
        reason: termCause ?? "ok",
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
