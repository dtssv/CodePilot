// Persistent shell: keep a long-lived PTY so cwd/env survive across bash tool calls.
//
// The single biggest agent-capability gap in the original bash tool: every
// command ran in a fresh `sh -c` child, so `cd`, `export`, and background
// jobs did NOT persist across calls. This made build/debug loops painful
// ("cd packages/core && pnpm test" had to be one command) and broke the
// mental model of "I'm working in a terminal".
//
// This module implements a persistent login shell that stays alive for the
// lifetime of a Session. Each `run` call sends a command to the shell's
// stdin, then reads stdout/stderr until a unique sentinel marker appears.
// The shell's cwd and env therefore carry over: a `cd packages/core` in
// one call means the next call runs in `packages/core`.
//
// Design:
// - One long-running child process: the user's login shell (`$SHELL` or
// `/bin/bash`), started with `-i` so it sources rc files.
// - Each command is wrapped: `printf '<sentinel> <exitcode>\n'` is
// appended after the user's command. We read until we see the
// sentinel, then parse the exit code from the line.
// - stdout and stderr are interleaved into one stream (the shell's
// stdout). This matches how a terminal looks and avoids ordering
// issues. The caller gets a single `output` string.
// - A timeout kills the *command* (not the shell): we send SIGINT to
// the shell's process group, then keep reading for the sentinel. The
// shell itself stays alive for the next command.
// - The shell is sandboxed via the same `wrapCommand` policy as the
// one-shot bash tool — we pass the sandbox wrapper as the shell's
// argv[0] when a sandbox is configured.
//
// Trade-offs vs. a real PTY (node-pty):
// - No TTY: interactive commands (vim, htop, sudo prompt) won't work.
// This is acceptable for an agent — it shouldn't be driving vim.
// - No ANSI rendering: output is plain text. Fine for logs/test output.
// - Zero native deps: pure Node, no node-pty compile step. This keeps
// the package dependency-free, matching the rest of the codebase.
// A future PTY upgrade can swap in node-pty behind the same interface.
//
// Lifecycle: the shell is lazily started on the first `run` call. It
// stays alive until `close` is called (Session.dispose) or the process
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
 * A long-running shell whose cwd and env persist across `run` calls.
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
 /** Pre-command marker: everything received before it (rc files, precmd
 * hooks, session-restore banners) is discarded. */
  private preSentinel: string | null = null;
 /** Startup drain: resolves when the sacrificial init command's marker has
 * been seen (or a timeout fires). Every run awaits this first so rc
 * noise never lands in a real command's output. */
  private drainPromise: Promise<void> | null = null;
 /** Tail of the run queue. The shell has a single stdin and one set of
 * per-command fields, so commands must execute strictly one at a time —
 * the agent issues parallel tool calls via Promise.all. */
  private runQueue: Promise<unknown> = Promise.resolve();
  private drainMarker: string | null = null;
  private drainResolve: (() => void) | null = null;
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
 // Interactive shells source rc files and run precmd hooks whose output
 // (prompt themes, Terminal.app session banners, OSC title escapes) lands
 // in our stdout stream. We can't stop users' rc files from running, so
 // instead we wrap every command in *two* sentinels: a pre-marker that
 // discards everything before it, and the completion marker. Init noise
 // between them can only pollute the FIRST run — so ensureStarted fires a
 // sacrificial no-op command immediately and swallows its output, letting
 // the shell settle before the first real command.
    const env: Record<string, string> = {
      ...this.opts.env,
 // Discourage (not eliminate) rc chrome:
      TERM: "dumb",
      PS1: "",
      PROMPT: "",
      PS2: "",
      PROMPT2: "",
      PROMPT_COMMAND: "",
      SHELL_SESSIONS_DISABLE: "1", // macOS Terminal.app restore banner
      ZSH_DISABLE_COMPFIX: "1",
    };
    const child = spawn(this.opts.shell, this.opts.shellArgs, {
      cwd: this.opts.cwd,
      env,
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
 // to "" after processing because onData copies into currentOutput.)
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

 // Sacrificial drain: write an init command that (a) turns off zsh's
 // precmd hooks + prompt escapes for the rest of the session, and
 // (b) ends with a unique drain marker. `run` queues behind `drainPromise`
 // and its pre-sentinel discards anything the rc files already emitted.
    const drain = `__CP_DRAIN_${randomBytes(6).toString("hex")}__`;
    this.drainMarker = drain;
    this.drainPromise = new Promise<void>((resolve) => {
      this.drainResolve = resolve;
 // If the marker never shows (broken shell rc), don't block forever.
      setTimeout(() => {
        if (this.drainResolve) {
          this.drainResolve = null;
          resolve();
        }
      }, 5000);
    });
    try {
      child.stdin!.write(
 // unset precmd hooks & prompt for this session; then drain marker.
        `unset precmd_functions 2>/dev/null; unsetopt PROMPT_CR PROMPT_SP 2>/dev/null; ` +
          `PS1=''; PROMPT=''; RPROMPT=''; PS2=''; PROMPT2=''\nprintf '%s\\n' '${drain}'\n`,
      );
    } catch {
      const r = this.drainResolve;
      this.drainResolve = null;
      r?.();
    }
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
 // rc/init noise guard: zsh -i sources ~/.zshrc asynchronously; precmd
 // hooks and theme banners can still be in flight when the first command
 // runs. Prepend a pre-sentinel and discard everything up to it, so only
 // the wrapped command's own output survives.
    const preSentinel = `__CP_START_${randomBytes(6).toString("hex")}__`;
 // Wrap the command so the sentinel + exit code are printed after it.
 // We use `;` so the sentinel prints even if the command fails, and we
 // capture `$?` immediately after the command (before the `;` runs).
 // The marker line is: <sentinel> <exitcode>
 // The command goes through `eval` of one quoted word: the shell parses it
 // as a whole, so multi-line input doesn't trigger continuation prompts
 // and an unbalanced quote fails the eval instead of swallowing the
 // sentinel lines. `eval` runs in this shell, so `cd`/`export` persist.
    const wrapped =
      `printf '%s\\n' '${preSentinel}'\n` +
      `eval ${shellQuote(command)}\n__cp_exit=$?\nprintf '%s %s\\n' '${sentinel}' "$__cp_exit"\n`;
 // Wait for the startup drain before configuring this run's state —
 // otherwise rc noise could race into currentOutput.
    const run = this.runQueue
      .then(() => this.drainPromise ?? undefined)
      .then(() => {
        if (opts.signal?.aborted) {
          return { stdout: "", stderr: "aborted before start", exitCode: null, signal: null, timedOut: true };
        }
        return this.runAfterDrain(command, wrapped, sentinel, preSentinel, timeout, opts.signal);
      });
    this.runQueue = run.catch(() => undefined);
    return run;
  }

  private runAfterDrain(
    _command: string,
    wrapped: string,
    sentinel: string,
    preSentinel: string,
    timeout: number,
    signal: AbortSignal | undefined,
  ): Promise<PersistentShellResult> {
 // The shell may have died during the drain; respawn if needed.
    this.ensureStarted();
    this.currentSentinel = sentinel;
    this.currentOutput = "";
    this.currentBytes = 0;
    this.currentTimedOut = false;
    this.preSentinel = preSentinel;
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
 // A command that reads stdin swallows the printf above, so the
 // sentinel may never arrive. Kill the shell (the exit handler
 // resolves this run; the next run respawns a fresh shell).
        const stuck = this.child;
        setTimeout(() => {
          if (this.pendingResolve === resolve && this.child === stuck && stuck?.pid) {
            try { process.kill(-stuck.pid, "SIGKILL"); } catch { /* ignore */ }
          }
        }, 5_000).unref?.();
      }, timeout);
 // AbortSignal support.
      const onAbort = () => {
        if (this.currentTimer) clearTimeout(this.currentTimer);
        this.currentTimedOut = true;
        if (this.child && this.child.pid) {
          try { process.kill(-this.child.pid, "SIGINT"); } catch { /* ignore */ }
        }
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
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
 // Startup drain phase: swallow everything until the drain marker.
    if (this.drainMarker) {
      const idx = chunk.indexOf(this.drainMarker);
      if (idx < 0) return; // still rc noise — discard whole chunk
      chunk = chunk.slice(idx + this.drainMarker.length);
      this.drainMarker = null;
      const r = this.drainResolve;
      this.drainResolve = null;
      r?.();
 // Fall through with the remainder of the chunk (usually empty).
      if (chunk.length === 0) return;
    }
    if (!this.pendingResolve || !this.currentSentinel) {
 // No command in flight — discard (e.g. shell's interactive prompt).
      return;
    }
    this.currentBytes += Buffer.byteLength(chunk, "utf-8");
    this.currentOutput += chunk;
 // Discard everything up to the pre-sentinel (shell init noise).
    if (this.preSentinel) {
      const preIdx = this.currentOutput.indexOf(this.preSentinel + "\n");
      if (preIdx >= 0) {
        this.currentOutput = this.currentOutput.slice(preIdx + this.preSentinel.length + 1);
        this.preSentinel = null;
      } else if (this.currentOutput.length > 65536) {
 // Pre-sentinel never arrived (broken shell?) — stop buffering noise.
        this.currentOutput = "";
        this.preSentinel = null;
      } else {
        return; // still waiting for the pre-sentinel
      }
    }
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
    this.preSentinel = null;
    this.currentOutput = "";
    this.currentBytes = 0;
 // currentTimedOut is reset on the next run.
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

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
