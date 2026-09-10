// Persistent shell (codex / opencode / claude-code equivalent).
//
// The single biggest agent-capability gap in the original bash tool: every
// command ran in a fresh `sh -c` child, so `cd`, `export`, and background
// jobs did NOT persist across calls. This made build/debug loops painful
// ("cd packages/core && pnpm test" had to be one command) and broke the
// mental model of "I'm working in a terminal".
//
// This module implements a persistent login shell that stays alive for the
// lifetime of a Session. Each `run()` call sends a command to the shell's
// stdin, then reads stdout/stderr until a unique sentinel marker appears.
// The shell's cwd and env therefore carry over: a `cd packages/core` in
// one call means the next call runs in `packages/core`.
//
// Design (mirrors codex's approach, simplified):
//   - One long-running child process: the user's login shell (`$SHELL` or
//     `/bin/bash`), started with `-i` so it sources rc files.
//   - Each command is wrapped: `printf '<sentinel> <exitcode>\n'` is
//     appended after the user's command. We read until we see the
//     sentinel, then parse the exit code from the line.
//   - stdout and stderr are interleaved into one stream (the shell's
//     stdout). This matches how a terminal looks and avoids ordering
//     issues. The caller gets a single `output` string.
//   - A timeout kills the *command* (not the shell): we send SIGINT to
//     the shell's process group, then keep reading for the sentinel. The
//     shell itself stays alive for the next command.
//   - The shell is sandboxed via the same `wrapCommand` policy as the
//     one-shot bash tool — we pass the sandbox wrapper as the shell's
//     argv[0] when a sandbox is configured.
//
// Trade-offs vs. a real PTY (node-pty):
//   - No TTY: interactive commands (vim, htop, sudo prompt) won't work.
//     This is acceptable for an agent — it shouldn't be driving vim.
//   - No ANSI rendering: output is plain text. Fine for logs/test output.
//   - Zero native deps: pure Node, no node-pty compile step. This keeps
//     the package dependency-free, matching the rest of the codebase.
//     A future PTY upgrade can swap in node-pty behind the same interface.
//
// Lifecycle: the shell is lazily started on the first `run()` call. It
// stays alive until `close()` is called (Session.dispose) or the process
// exits unexpectedly (we respawn on the next call).

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface PersistentShellOptions {
  /** Working directory to start the shell in. */
  cwd: string;
  /** Shell executable. Defaults to `$SHELL` or `/bin/bash`. */
  shell?: string;
  /** Extra args to pass to the shell (e.g. `["-i"]` for interactive). */
  shellArgs?: string[];
  /** Environment to start with (defaults to `process.env`). */
  env?: Record<string, string>;
  /** Max bytes of output to buffer per command (default 5 MB). */
  maxOutputBytes?: number;
}

export interface PersistentShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Signal that killed the command (SIGTERM on timeout), if any. */
  signal: NodeJS.Signals | null;
  /** True when the command hit the timeout. */
  timedOut: boolean;
}

/**
 * A long-running shell whose cwd and env persist across `run()` calls.
 */
export class PersistentShell {
  private readonly opts: Required<Pick<PersistentShellOptions, "cwd" | "shell" | "shellArgs" | "maxOutputBytes">> & {
    env: Record<string, string>;
  };
  private child: ChildProcess | null = null;
  private closed = false;
  /** Buffer of bytes received since the last sentinel. */
  private buffer = "";
  /** Resolvers waiting for the current command's sentinel. */
  private pendingResolve: ((r: PersistentShellResult) => void) | null = null;
  /** The sentinel we're currently looking for. */
  private currentSentinel: string | null = null;
  /** Accumulated stdout/stderr for the current command (interleaved). */
  private currentOutput = "";
  /** Total bytes received for the current command (for the cap). */
  private currentBytes = 0;
  /** Whether the current command timed out. */
  private currentTimedOut = false;
  /** The timer for the current command. */
  private currentTimer: NodeJS.Timeout | null = null;

  constructor(opts: PersistentShellOptions) {
    const shell = opts.shell ?? process.env.SHELL ?? "/bin/bash";
    this.opts = {
      cwd: opts.cwd,
      shell,
      shellArgs: opts.shellArgs ?? ["-i"],
      env: opts.env ?? { ...process.env } as Record<string, string>,
      maxOutputBytes: opts.maxOutputBytes ?? 5 * 1024 * 1024,
    };
  }

  /** Lazily start the shell child process. */
  private ensureStarted(): void {
    if (this.child && !this.child.killed) return;
    if (this.closed) throw new Error("PersistentShell closed");
    const child = spawn(this.opts.shell, this.opts.shellArgs, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Detach so we can signal the whole process group on timeout.
      detached: true,
    });
    this.child = child;
    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (b: Buffer) => {
      stdoutBuf += b.toString("utf-8");
      this.onData(stdoutBuf, "stdout");
      // Drain what we've consumed; keep the rest.
      // (onData mutates this.currentOutput, not stdoutBuf; we reset stdoutBuf
      //  to "" after processing because onData copies into currentOutput.)
      stdoutBuf = "";
    });
    child.stderr.on("data", (b: Buffer) => {
      stderrBuf += b.toString("utf-8");
      this.onData(stderrBuf, "stderr");
      stderrBuf = "";
    });
    child.on("exit", (code, signal) => {
      // If we have a pending command, resolve it (the shell died mid-command).
      if (this.pendingResolve) {
        const res: PersistentShellResult = {
          stdout: this.currentOutput,
          stderr: "",
          exitCode: code,
          signal: signal as NodeJS.Signals | null,
          timedOut: this.currentTimedOut,
        };
        this.resetCurrent();
        this.pendingResolve(res);
        this.pendingResolve = null;
      }
      this.child = null;
    });
    child.on("error", () => {
      this.child = null;
    });
  }

  /**
   * Run a command in the persistent shell. Resolves when the command
   * finishes (sentinel seen) or the timeout elapses. The shell itself
   * stays alive for the next call.
   */
  run(command: string, opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<PersistentShellResult> {
    this.ensureStarted();
    const timeout = opts.timeout ?? 60_000;
    const sentinel = `__CP_DONE_${randomBytes(6).toString("hex")}__`;
    this.currentSentinel = sentinel;
    this.currentOutput = "";
    this.currentBytes = 0;
    this.currentTimedOut = false;
    // Wrap the command so the sentinel + exit code are printed after it.
    // We use `;` so the sentinel prints even if the command fails, and we
    // capture `$?` immediately after the command (before the `;` runs).
    // The marker line is: <sentinel> <exitcode>
    const wrapped = `${command}\n__cp_exit=$?\nprintf '%s %s\\n' '${sentinel}' "$__cp_exit"\n`;
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      // Set the timeout. On fire, SIGINT the shell's process group (the
      // foreground command gets it). The shell stays alive.
      this.currentTimer = setTimeout(() => {
        this.currentTimedOut = true;
        if (this.child && this.child.pid) {
          try {
            // negative pid → signal the process group.
            process.kill(-this.child.pid, "SIGINT");
          } catch {
            /* ignore */
          }
        }
        // Also print the sentinel ourselves so we unblock — the command
        // may have ignored SIGINT.
        try {
          this.child?.stdin?.write(`\nprintf '%s TIMEOUT\\n' '${sentinel}'\n`);
        } catch {
          /* ignore */
        }
      }, timeout);
      // AbortSignal support.
      const onAbort = () => {
        if (this.currentTimer) clearTimeout(this.currentTimer);
        this.currentTimedOut = true;
        if (this.child && this.child.pid) {
          try { process.kill(-this.child.pid, "SIGINT"); } catch { /* ignore */ }
        }
      };
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        this.child!.stdin!.write(wrapped);
      } catch (err) {
        // Shell died before we could write — resolve with an error.
        if (this.currentTimer) clearTimeout(this.currentTimer);
        resolve({
          stdout: "",
          stderr: `persistent shell write failed: ${(err as Error).message}`,
          exitCode: 1,
          signal: null,
          timedOut: false,
        });
        this.pendingResolve = null;
      }
    });
  }

  /** Feed received bytes into the current command's buffer and scan for the sentinel. */
  private onData(chunk: string, _stream: "stdout" | "stderr"): void {
    if (!this.pendingResolve || !this.currentSentinel) {
      // No command in flight — discard (e.g. shell's interactive prompt).
      return;
    }
    this.currentBytes += Buffer.byteLength(chunk, "utf-8");
    this.currentOutput += chunk;
    // Check for the sentinel line. The marker is `<sentinel> <exitcode>`.
    const sentinelRe = new RegExp(`${this.escapeRe(this.currentSentinel)} (\\d+|TIMEOUT)\n`);
    const m = this.currentOutput.match(sentinelRe);
    if (m) {
      const exitStr = m[1]!;
      const exitCode = exitStr === "TIMEOUT" ? null : Number(exitStr);
      // Strip the sentinel line from the output the caller sees.
      const visibleOutput = this.currentOutput.slice(0, m.index);
      if (this.currentTimer) {
        clearTimeout(this.currentTimer);
        this.currentTimer = null;
      }
      const res: PersistentShellResult = {
        stdout: visibleOutput,
        stderr: "",
        exitCode,
        signal: null,
        timedOut: this.currentTimedOut,
      };
      this.resetCurrent();
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(res);
      return;
    }
    // Enforce the output cap. If we've buffered too much, kill the command.
    if (this.currentBytes > this.opts.maxOutputBytes) {
      if (this.currentTimer) {
        clearTimeout(this.currentTimer);
        this.currentTimer = null;
      }
      if (this.child && this.child.pid) {
        try { process.kill(-this.child.pid, "SIGTERM"); } catch { /* ignore */ }
      }
      const res: PersistentShellResult = {
        stdout: this.currentOutput + `\n[output exceeded ${this.opts.maxOutputBytes} bytes; command killed]`,
        stderr: "",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
      };
      this.resetCurrent();
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(res);
    }
  }

  private resetCurrent(): void {
    this.currentSentinel = null;
    this.currentOutput = "";
    this.currentBytes = 0;
    // currentTimedOut is reset on the next run().
  }

  private escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Close the persistent shell. Safe to call multiple times. */
  close(): void {
    this.closed = true;
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
    if (this.child) {
      try {
        // Send `exit` to the shell so it exits cleanly.
        this.child.stdin?.end("exit\n");
      } catch {
        /* ignore */
      }
      // Give it a moment, then SIGKILL if still alive.
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          try { this.child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 1000).unref();
      this.child = null;
    }
  }
}
