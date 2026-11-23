// Background job registry for the bash tool, keyed by cwd (shared by bash/
// bash_output/bash_kill). Jobs are detached children streaming to
// `~/.codepilot/projects/<hash>/jobs/`. Cancel/session dispose leaves jobs
// running; engine exit cascade-stops them. Stale "running" jobs load as "unknown".

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { projectStatePath } from "../workspace/projectState.js";
import { modelShellEnv, type ShellEnvOptions } from "../sandbox/sandbox.js";
import { spawnPtyCommand, type IPty } from "./ptyProcess.js";

export interface JobMeta {
  id: string;
  command: string;
 /** The user-facing command (before sandbox wrapping). The `command` field
 * holds the actual spawned string, which for sandboxed jobs is a long
 * `sandbox-exec -p '...'` wrapper that is useless to show. Prefer this for
 * any UI/steering text. Falls back to `command` when absent (old jobs). */
  displayCommand?: string;
  cwd: string;
 /** Session (or sub-agent) that started this job. The registry is keyed only
  * by cwd, so parallel sub-agents sharing a fallback cwd would otherwise be
  * able to reach each other's jobs. `write_stdin` checks this to refuse
  * cross-owner writes. Absent on jobs started before this field existed (and
  * in minimal contexts); treated as "unowned" (no restriction) for back-compat. */
  ownerSessionId?: string;
  pid?: number;
  startedAt: string;
  status: "running" | "exited" | "killed" | "failed" | "unknown";
  exitCode?: number | null;
  finishedAt?: string;
  sandboxed: boolean;
  sandboxBackend: string;
}

export interface BackgroundJob {
  meta: JobMeta;
  /** Pipe-backed child (adopted FG timeout, or PTY fallback). */
  proc?: ChildProcess;
  /** Interactive PTY session (preferred for run_in_background + write_stdin). */
  pty?: IPty;
  logPath: string;
  metaPath: string;
  /**
   * Skip session completion steer when the model already observed this job
   * via `bash_output` (terminal status) or explicitly `bash_kill`'d it — so
   * the same tail is not steered back into context after an explicit read.
   */
  suppressCompletionSteer?: boolean;
}

interface Registry {
  jobs: Map<string, BackgroundJob>;
 /** Listeners fired when a job transitions to a terminal state. */
  completionListeners: Set<(meta: JobMeta) => void>;
}

const registries = new Map<string, Registry>();

/** Default grace between SIGTERM and SIGKILL for a single job. */
const KILL_GRACE_MS = 2000;
/** Shorter grace when sweeping all jobs on engine shutdown. */
const KILL_ALL_GRACE_MS = 500;

let exitHookInstalled = false;

function registryFor(cwd: string): Registry {
  let r = registries.get(cwd);
  if (!r) {
    r = { jobs: new Map(), completionListeners: new Set() };
    registries.set(cwd, r);
  }
  return r;
}

/**
 * Signal the whole process group (shell + grandchildren like vite/chrome).
 * Falls back to the direct child on Windows or when the group signal fails.
 */
function killProcessTree(proc: ChildProcess, sig: NodeJS.Signals): void {
  const pid = proc.pid;
  try {
    if (pid && process.platform !== "win32") {
      process.kill(-pid, sig);
      return;
    }
    proc.kill(sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

/** Sync last-resort kill for `process.on("exit")` (no async allowed). */
function killAllJobsSync(): void {
  for (const reg of registries.values()) {
    for (const job of reg.jobs.values()) {
      if (job.meta.status !== "running") continue;
      if (!job.proc && !job.pty) continue;
      job.meta.status = "killed";
      if (job.pty) {
        try {
          job.pty.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      } else if (job.proc) {
        killProcessTree(job.proc, "SIGKILL");
      }
    }
  }
}

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", killAllJobsSync);
}

/** Register a listener fired when any job in this cwd finishes (exits, is
 * killed, or errors). Returns an unsubscribe function. The session uses
 * this to push a steering message into the agent loop so the model learns
 * the job is done without having to poll. */
export function onJobCompletion(
  cwd: string,
  listener: (meta: JobMeta) => void
): () => void {
  const r = registryFor(cwd);
  r.completionListeners.add(listener);
  return () => r.completionListeners.delete(listener);
}

export function jobsDir(cwd: string): string {
  return projectStatePath(cwd, "jobs");
}

/** Default retention for finished job logs on disk. */
export const JOB_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let lastPruneAt = 0;
const PRUNE_COOLDOWN_MS = 60_000;

/**
 * Delete finished job `.json`/`.log` pairs older than `retentionMs`.
 * Skips jobs still `running` in the live registry. Best-effort; rate-limited.
 */
export async function pruneOldJobs(
  cwd: string,
  retentionMs = JOB_LOG_RETENTION_MS,
  now = Date.now(),
  opts?: { force?: boolean },
): Promise<number> {
  if (!opts?.force && now - lastPruneAt < PRUNE_COOLDOWN_MS) return 0;
  lastPruneAt = now;
  const dir = jobsDir(cwd);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const live = registryFor(cwd).jobs;
  const cutoff = now - retentionMs;
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const liveJob = live.get(id);
    if (liveJob?.meta.status === "running") continue;
    const metaPath = join(dir, name);
    const logPath = join(dir, `${id}.log`);
    try {
      const st = await stat(metaPath);
      const mtime = st.mtimeMs;
      // Prefer finishedAt from meta when present.
      let finishedAt = mtime;
      try {
        const meta = JSON.parse(await readFile(metaPath, "utf-8")) as JobMeta;
        if (meta.finishedAt) {
          const t = Date.parse(meta.finishedAt);
          if (!Number.isNaN(t)) finishedAt = t;
        } else if (meta.status === "running" || meta.status === "unknown") {
          // Stale "running" on disk after restart — still age by mtime.
        }
      } catch {
        /* use mtime */
      }
      if (finishedAt > cutoff) continue;
      await unlink(metaPath).catch(() => undefined);
      await unlink(logPath).catch(() => undefined);
      consumptionCursors.delete(cursorKey(cwd, id));
      live.delete(id);
      removed++;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

export interface SpawnJobSpec {
  command: string;
 /** User-facing command before sandbox wrapping (for UI/steering text). */
  displayCommand?: string;
  cwd: string;
 /** Owner session/sub-agent id, stamped onto the job for `write_stdin`
  * ownership checks. Optional — absent → job is unowned (no restriction). */
  ownerSessionId?: string;
 /** Shell executable and args prefix (from the sandbox wrapper). */
  shell: string;
  shellArgs: string[];
  sandboxed: boolean;
  sandboxBackend: string;
  /** `shellEnv` config: optional secret filtering for the job's environment. */
  shellEnv?: ShellEnvOptions;
  /**
   * Allocate a PTY (default false). Pipe-backed jobs avoid ANSI/CR
   * noise in build logs; set true for interactive prompts + write_stdin.
   */
  tty?: boolean;
}

/** Spawn a detached background job. PTY only when `tty: true` (default
 * is off); otherwise a pipe-backed child. Falls back to pipes when node-pty
 * is unavailable. Returns the job record immediately. */
export async function spawnBackgroundJob(spec: SpawnJobSpec): Promise<BackgroundJob> {
  ensureExitHook();
  void pruneOldJobs(spec.cwd);
  const env = modelShellEnv(process.env, spec.shellEnv);
  if (spec.tty) {
    const pty = await spawnPtyCommand({
      shell: spec.shell,
      shellArgs: spec.shellArgs,
      command: spec.command,
      cwd: spec.cwd,
      env,
    });
    if (pty) {
      return registerBackgroundJob({
        pty,
        command: spec.command,
        displayCommand: spec.displayCommand,
        cwd: spec.cwd,
        ownerSessionId: spec.ownerSessionId,
        sandboxed: spec.sandboxed,
        sandboxBackend: spec.sandboxBackend,
      });
    }
  }
  const proc = spawn(spec.shell, [...spec.shellArgs, spec.command], {
    cwd: spec.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  return registerBackgroundJob({
    proc,
    command: spec.command,
    displayCommand: spec.displayCommand,
    cwd: spec.cwd,
    ownerSessionId: spec.ownerSessionId,
    sandboxed: spec.sandboxed,
    sandboxBackend: spec.sandboxBackend,
  });
}

export interface AdoptJobSpec {
  /** Still-running child (typically a foreground bash that hit its wall clock). */
  proc: ChildProcess;
  command: string;
  displayCommand?: string;
  cwd: string;
  ownerSessionId?: string;
  sandboxed: boolean;
  sandboxBackend: string;
  /** Bytes already read from stdout/stderr before adoption (written to the log first). */
  initialOutput?: string;
}

/**
 * Register an already-running process as a background job: keep it alive, stream
 * further output to the job log, and fire the same completion listeners as a
 * job started with {@link spawnBackgroundJob}. Used when a foreground bash hits
 * its timeout — the work continues under `bash_output` / completion steer.
 */
export async function adoptBackgroundJob(spec: AdoptJobSpec): Promise<BackgroundJob> {
  ensureExitHook();
  return registerBackgroundJob(spec);
}

async function registerBackgroundJob(spec: {
  proc?: ChildProcess;
  pty?: IPty;
  command: string;
  displayCommand?: string;
  cwd: string;
  ownerSessionId?: string;
  sandboxed: boolean;
  sandboxBackend: string;
  initialOutput?: string;
}): Promise<BackgroundJob> {
  if (!spec.proc && !spec.pty) {
    throw new Error("registerBackgroundJob: need proc or pty");
  }
  const id = `job_${randomUUID().slice(0, 8)}`;
  await mkdir(jobsDir(spec.cwd), { recursive: true });
  const logPath = join(jobsDir(spec.cwd), `${id}.log`);
  const metaPath = join(jobsDir(spec.cwd), `${id}.json`);

  const log = createWriteStream(logPath, { flags: "a" });
  if (spec.initialOutput && spec.initialOutput.length > 0) {
    log.write(spec.initialOutput);
  }

  const pid = spec.pty?.pid ?? spec.proc?.pid ?? undefined;
  const meta: JobMeta = {
    id,
    command: spec.command,
    displayCommand: spec.displayCommand ?? spec.command,
    cwd: spec.cwd,
    ownerSessionId: spec.ownerSessionId,
    pid,
    startedAt: new Date().toISOString(),
    status: "running",
    sandboxed: spec.sandboxed,
    sandboxBackend: spec.sandboxBackend,
  };
  const job: BackgroundJob = {
    meta,
    proc: spec.proc,
    pty: spec.pty,
    logPath,
    metaPath,
  };
  registryFor(spec.cwd).jobs.set(id, job);
  await persistMeta(job);

  let completionFired = false;
  const complete = (status: JobMeta["status"], code: number | null): void => {
    if (completionFired) return;
    completionFired = true;
    if (meta.status === "running") meta.status = status;
    meta.exitCode = code;
    meta.finishedAt = new Date().toISOString();
    log.end();
    void persistMeta(job);
    fireCompletion(spec.cwd, meta);
  };

  if (spec.pty) {
    // A PTY merges stdout/stderr into one stream.
    spec.pty.onData((data) => log.write(data));
    spec.pty.onExit(({ exitCode }) =>
      complete(meta.status === "killed" ? "killed" : "exited", exitCode ?? null),
    );
    return job;
  }

  const proc = spec.proc!;
  // Drop any prior data listeners (e.g. the foreground runCommand buffers) so
  // only the job log consumes further chunks.
  proc.stdout?.removeAllListeners("data");
  proc.stderr?.removeAllListeners("data");
  proc.stdout?.on("data", (b: Buffer) => log.write(b));
  proc.stderr?.on("data", (b: Buffer) => log.write(b));

  // Append listeners; a prior foreground runner may also listen but should be settled.
  proc.on("close", (code) => complete(meta.status === "killed" ? "killed" : "exited", code));
  proc.on("error", () => complete("failed", null));

  // Adopted after exit (race): finalize immediately.
  if (proc.exitCode !== null || proc.signalCode !== null) {
    complete(
      meta.status === "killed" ? "killed" : "exited",
      proc.exitCode,
    );
  }
  return job;
}

function fireCompletion(cwd: string, meta: JobMeta): void {
  const r = registries.get(cwd);
  if (!r) return;
  for (const l of r.completionListeners) {
    try {
      l(meta);
    } catch {
 /* listener errors must not crash the close handler */
    }
  }
}

/** Mark that the model already saw this job finish (poll) or killed it — skip steer. */
export function suppressJobCompletionSteer(cwd: string, id: string): void {
  const job = registryFor(cwd).jobs.get(id);
  if (job) job.suppressCompletionSteer = true;
}

/** Whether session-lifecycle should skip the completion steer for this job. */
export function isJobCompletionSteerSuppressed(cwd: string, id: string): boolean {
  return registryFor(cwd).jobs.get(id)?.suppressCompletionSteer === true;
}

/** Look up a live job; if absent in memory, try loading metadata from disk. */
export async function getJob(cwd: string, id: string): Promise<BackgroundJob | null> {
  const live = registryFor(cwd).jobs.get(id);
  if (live) return live;
  const metaPath = join(jobsDir(cwd), `${id}.json`);
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf-8")) as JobMeta;
 // The process that owned it is gone (CodePilot restarted) — we can no
 // longer know its true state.
    if (meta.status === "running") meta.status = "unknown";
    return {
      meta,
      logPath: join(jobsDir(cwd), `${id}.log`),
      metaPath,
    };
  } catch {
    return null;
  }
}

/** List all jobs known to this session (live registry only). */
export function listJobs(cwd: string): JobMeta[] {
  return [...registryFor(cwd).jobs.values()].map((j) => j.meta);
}

/** Tools whose model input is only a `job_id` (opaque to the UI without the
 * underlying shell command). */
export const JOB_DISPLAY_TOOLS: ReadonlySet<string> = new Set([
  "bash_output",
  "bash_kill",
  "write_stdin",
]);

/**
 * Attach `command` + `status` onto a job-tool input for UI / permission copy.
 * Fail-soft: unknown job or missing `job_id` returns `input` unchanged.
 * Does not remove `job_id` — callers that parse the schema still see it.
 */
export async function attachJobCommandForDisplay(
  cwd: string,
  input: unknown,
): Promise<unknown> {
  if (!input || typeof input !== "object") return input;
  const o = input as Record<string, unknown>;
  if (typeof o.job_id !== "string" || !o.job_id) return input;
  if (typeof o.command === "string" && o.command.trim()) return input;
  const job = await getJob(cwd, o.job_id);
  if (!job) return input;
  return {
    ...o,
    command: job.meta.displayCommand ?? job.meta.command,
    status: job.meta.status,
  };
}

/**
 * Build an actionable "unknown job" error: list jobs that actually exist this
 * session (with status) rather than a dead-end bare id, so the model can
 * recover instead of stalling on a hallucinated placeholder.
 */
export function describeUnknownJob(cwd: string, requestedId: string): string {
  const jobs = listJobs(cwd);
  if (jobs.length === 0) {
    return (
      `unknown job: ${requestedId}. No background jobs are running in this ` +
      `session. A job id is returned by \`bash\` when you pass ` +
      `\`run_in_background: true\` (e.g. "started background job job_xxxx"); ` +
      `start one that way before polling.`
    );
  }
  const lines = jobs
    .map((j) => {
      const exit =
        j.exitCode !== undefined && j.exitCode !== null ? ` (exit ${j.exitCode})` : "";
      const cmd = j.command.replace(/\s+/g, " ").trim().slice(0, 60);
      return `  - ${j.id}: ${j.status}${exit} — ${cmd}`;
    })
    .join("\n");
  return (
    `unknown job: ${requestedId}. It does not match any background job in this ` +
    `session — did you use a placeholder id? The real id is in the \`bash\` ` +
    `result that started the job. Current jobs:\n${lines}`
  );
}

/** Kill a job (process-group SIGTERM, then SIGKILL after grace). */
export async function killJob(cwd: string, id: string): Promise<boolean> {
  const job = registryFor(cwd).jobs.get(id);
  if (!job || job.meta.status !== "running") return false;
  if (!job.proc && !job.pty) return false;
  // Model-initiated kill: the kill tool_result already tells the model; don't
  // also steer a completion notice with the same log tail.
  job.suppressCompletionSteer = true;
  await terminateJob(job, KILL_GRACE_MS);
  return true;
}

/**
 * Cascade-stop every running background job. Call on engine process exit only,
 * not on turn cancel or session dispose (those leave servers up for reconnect).
 * @returns number of jobs signaled.
 */
export async function killAllJobs(): Promise<number> {
  const running: BackgroundJob[] = [];
  for (const reg of registries.values()) {
    for (const job of reg.jobs.values()) {
      if (job.meta.status === "running" && (job.proc || job.pty)) running.push(job);
    }
  }
  await Promise.all(running.map((job) => terminateJob(job, KILL_ALL_GRACE_MS)));
  return running.length;
}

async function terminateJob(job: BackgroundJob, graceMs: number): Promise<void> {
  if (job.meta.status !== "running") return;
  if (!job.proc && !job.pty) return;
  job.meta.status = "killed";
  if (job.pty) {
    const pty = job.pty;
    try {
      pty.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await Promise.race([
      new Promise<void>((resolve) => {
        pty.onExit(() => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);
    // Still in registry as running completion may race; escalate if needed.
    try {
      pty.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await persistMeta(job);
    return;
  }
  const proc = job.proc!;
  killProcessTree(proc, "SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => {
      proc.once("close", () => resolve());
    }),
    new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
  ]);
  // Still alive after grace → escalate.
  if (proc.exitCode === null && proc.signalCode === null) {
    killProcessTree(proc, "SIGKILL");
  }
  await persistMeta(job);
}

/** Why a stdin write did not happen. Distinct cases, because the caller's
 * advice differs: an exited job is never worth retrying, a closed stdin
 * means the process stopped reading, and a failed write may be transient. */
export type WriteJobStdinResult =
  | { ok: true }
  | { ok: false; reason: "no-such-job" }
  | { ok: false; reason: "not-running"; status: JobMeta["status"] }
  | { ok: false; reason: "no-stdin" }
  | { ok: false; reason: "write-failed"; message: string };

/**
 * Write data to a background job's stdin / PTY (for interactive processes).
 * Status is re-checked here since a job can exit between the caller's check
 * and the write. `appendNewline` (default true) appends `\n`; false for raw.
 */
export async function writeJobStdin(
  cwd: string,
  id: string,
  data: string,
  opts: { appendNewline?: boolean } = {}
): Promise<WriteJobStdinResult> {
  const job = registryFor(cwd).jobs.get(id);
  if (!job || (!job.proc && !job.pty)) return { ok: false, reason: "no-such-job" };
  if (job.meta.status !== "running") {
    return { ok: false, reason: "not-running", status: job.meta.status };
  }
  const payload = opts.appendNewline === false ? data : data + "\n";

  if (job.pty) {
    try {
      job.pty.write(payload);
      return { ok: true };
    } catch (err) {
      if (job.meta.status !== "running") {
        return { ok: false, reason: "not-running", status: job.meta.status };
      }
      return {
        ok: false,
        reason: "write-failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const stdin = job.proc!.stdin;
  if (!stdin || stdin.destroyed) return { ok: false, reason: "no-stdin" };
  // A dead child makes the pipe raise EPIPE asynchronously: the error
  // listener must be attached up front (and kept until the job ends) so it
  // never surfaces as an uncaught "error" event on the stream.
  if (!stdin.listenerCount("error")) {
    stdin.on("error", () => {
      /* write failures are reported via the write callback below */
    });
  }
  return new Promise<WriteJobStdinResult>((resolve) => {
    // Node's stream write callback receives `null` (not undefined) on success.
    stdin.write(payload, (err) => {
      if (err == null) {
        resolve({ ok: true });
        return;
      }
      // The write lost a race with the process exiting: report the job's
      // state, which is what the caller can act on.
      if (job.meta.status !== "running") {
        resolve({ ok: false, reason: "not-running", status: job.meta.status });
        return;
      }
      resolve({ ok: false, reason: "write-failed", message: err.message });
    });
  });
}

/**
 * Refuse cross-owner job access when both the job and the caller carry a
 * session id (parallel sub-agents sharing a cwd).
 */
export function assertJobOwner(
  job: BackgroundJob,
  sessionId: string | undefined,
): string | null {
  if (job.meta.ownerSessionId && sessionId && job.meta.ownerSessionId !== sessionId) {
    return `job ${job.meta.id} belongs to a different agent and cannot be accessed from here`;
  }
  return null;
}

/** Soft ceiling on bytes returned from a job log (line tails alone can still
 * blow context when a single line is megabytes of JSON). */
export const JOB_LOG_MAX_CHARS = 100_000;

/**
 * Per-job consumption cursor (byte offset into the log file). `bash_output`
 * advances this on default polls so repeated calls return only new bytes.
 * Keyed by cwd+id because job ids are unique per project dir, not globally.
 */
const consumptionCursors = new Map<string, number>();

function cursorKey(cwd: string, id: string): string {
  return `${cwd}\0${id}`;
}

/** Last consumed byte offset for a job (0 if never polled). */
export function getJobLogCursor(cwd: string, id: string): number {
  return consumptionCursors.get(cursorKey(cwd, id)) ?? 0;
}

/** Set / clear the consumption cursor (tests + explicit offset polls). */
export function setJobLogCursor(cwd: string, id: string, offset: number): void {
  const key = cursorKey(cwd, id);
  if (offset <= 0) consumptionCursors.delete(key);
  else consumptionCursors.set(key, offset);
}

export type JobLogSlice = {
  text: string;
  /** Absolute byte offset into the log where `text` begins. */
  fromOffset: number;
  /** Absolute byte offset to pass on the next incremental read. */
  nextOffset: number;
  totalBytes: number;
};

/**
 * Read log bytes starting at `fromOffset` (UTF-8), capped by `maxChars`
 * (measured in UTF-16 code units of the decoded slice, matching prior
 * JOB_LOG_MAX_CHARS behavior). Does not advance the consumption cursor.
 */
export async function readJobLogFrom(
  cwd: string,
  id: string,
  fromOffset: number,
  maxChars = JOB_LOG_MAX_CHARS,
): Promise<JobLogSlice> {
  const logPath = join(jobsDir(cwd), `${id}.log`);
  try {
    const totalBytes = (await stat(logPath)).size;
    const start = Math.min(Math.max(0, Math.floor(fromOffset)), totalBytes);
    if (start >= totalBytes) {
      return { text: "(no new output)", fromOffset: start, nextOffset: start, totalBytes };
    }
    // Read only a window from `start` — never the whole multi-hundred-MB log.
    // Worst-case UTF-8 is 4 bytes/code unit; +4 KiB covers a torn trailing char.
    const maxBytes = Math.min(totalBytes - start, maxChars * 4 + 4096);
    const fh = await open(logPath, "r");
    let slice: Buffer;
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, start);
      slice = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    // Cap by decoded string length so multi-byte UTF-8 does not undershoot the
    // historical char budget; prefer a trailing newline cut when truncated.
    let text = slice.toString("utf-8");
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      const lastNl = text.lastIndexOf("\n");
      if (lastNl > maxChars * 0.5) text = text.slice(0, lastNl + 1);
      const kept = Buffer.byteLength(text, "utf-8");
      slice = slice.subarray(0, kept);
      text =
        text +
        `\n[... truncated to ${maxChars.toLocaleString()} chars; pass offset=${start + kept} to continue ...]`;
    }
    return {
      text: text.length > 0 ? text : "(no new output)",
      fromOffset: start,
      nextOffset: start + slice.length,
      totalBytes,
    };
  } catch {
    return { text: "(no output yet)", fromOffset: 0, nextOffset: 0, totalBytes: 0 };
  }
}

/** Consuming incremental read: from the stored cursor (or `fromOffset` when
 * provided), then advance the cursor to `nextOffset`. */
export async function consumeJobLog(
  cwd: string,
  id: string,
  fromOffset?: number,
  maxChars = JOB_LOG_MAX_CHARS,
): Promise<JobLogSlice> {
  const key = cursorKey(cwd, id);
  const start = fromOffset !== undefined ? fromOffset : (consumptionCursors.get(key) ?? 0);
  const slice = await readJobLogFrom(cwd, id, start, maxChars);
  consumptionCursors.set(key, slice.nextOffset);
  return slice;
}

/** Read the tail of a job's log (line cap + byte cap). Does not move the
 * consumption cursor — use for completion steers / diagnostic dumps. */
export async function readJobLog(
  cwd: string,
  id: string,
  tailLines = 100,
  maxChars = JOB_LOG_MAX_CHARS,
): Promise<string> {
  const logPath = join(jobsDir(cwd), `${id}.log`);
  try {
    const totalBytes = (await stat(logPath)).size;
    if (totalBytes === 0) return "(no output yet)";
    // Tail by reading a bounded window from the end (not the whole file).
    const windowBytes = Math.min(totalBytes, Math.max(maxChars * 4, 256_000));
    const start = totalBytes - windowBytes;
    const fh = await open(logPath, "r");
    let buf: Buffer;
    try {
      buf = Buffer.allocUnsafe(windowBytes);
      const { bytesRead } = await fh.read(buf, 0, windowBytes, start);
      buf = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    let text = buf.toString("utf-8");
    // If we started mid-file, drop a torn first line so we don't invent garbage.
    if (start > 0) {
      const firstNl = text.indexOf("\n");
      if (firstNl >= 0) text = text.slice(firstNl + 1);
    }
    const lines = text.split(/\r?\n/);
    const omittedGuess = start > 0 || lines.length > tailLines;
    const tail = lines.slice(-tailLines);
    const prefix = omittedGuess ? `[...earlier lines omitted]\n` : "";
    let body = prefix + tail.join("\n");
    if (body.length > maxChars) {
      body =
        body.slice(0, maxChars) +
        `\n[... truncated to ${maxChars.toLocaleString()} chars; use a smaller \`tail\` or read the job log file ...]`;
    }
    return body;
  } catch {
    return "(no output yet)";
  }
}

async function persistMeta(job: BackgroundJob): Promise<void> {
  try {
    await mkdir(jobsDir(job.meta.cwd), { recursive: true });
    await writeFile(job.metaPath, JSON.stringify(job.meta, null, 2), "utf-8");
  } catch {
 /* best-effort */
  }
}
