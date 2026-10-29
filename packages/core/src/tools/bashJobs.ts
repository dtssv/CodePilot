// Background job registry for the bash tool.
//
// A background job is a detached child process whose stdout/stderr stream
// into `~/.codepilot/projects/<hash>/jobs/<jobId>.log`, with metadata
// in `<jobId>.json`.
// The registry is module-level and keyed by cwd, so the `bash`,
// `bash_output` and `bash_kill` tools share it within a session.
//
// Lifecycle:
// - Cancel / session dispose: jobs keep running (reconnect-friendly).
// - Engine process exit (`killAllJobs` + exit hook): cascade-stop every
 //   running job (process-group SIGTERM → SIGKILL). Without this,
 //   `npm run dev` / `http.server` orphan on serve exit.
//
// Job state survives the command that started it, but NOT a process
// restart of CodePilot itself: on disk, jobs whose metadata says
// "running" at load time are reported as "unknown" (the pid may be dead
// or reused).

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { projectStatePath } from "../projectState.js";

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
  proc?: ChildProcess;
  logPath: string;
  metaPath: string;
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
      if (job.meta.status !== "running" || !job.proc) continue;
      job.meta.status = "killed";
      killProcessTree(job.proc, "SIGKILL");
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
}

/** Spawn a detached background job. Returns the job record immediately. */
export async function spawnBackgroundJob(spec: SpawnJobSpec): Promise<BackgroundJob> {
  const id = `job_${randomUUID().slice(0, 8)}`;
  await mkdir(jobsDir(spec.cwd), { recursive: true });
  const logPath = join(jobsDir(spec.cwd), `${id}.log`);
  const metaPath = join(jobsDir(spec.cwd), `${id}.json`);

  ensureExitHook();
  const log = createWriteStream(logPath, { flags: "a" });
  // `detached: true` → own process group so killJob / killAllJobs can
  // `process.kill(-pid)` the shell AND grandchildren (vite, chrome, …).
  // Keep stdio piped (do not unref) so write_stdin / log tails still work
  // and the engine can cascade-kill on shutdown.
  const proc = spawn(spec.shell, [...spec.shellArgs, spec.command], {
    cwd: spec.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  proc.stdout?.on("data", (b: Buffer) => log.write(b));
  proc.stderr?.on("data", (b: Buffer) => log.write(b));

  const meta: JobMeta = {
    id,
    command: spec.command,
    displayCommand: spec.displayCommand ?? spec.command,
    cwd: spec.cwd,
    ownerSessionId: spec.ownerSessionId,
    pid: proc.pid ?? undefined,
    startedAt: new Date().toISOString(),
    status: "running",
    sandboxed: spec.sandboxed,
    sandboxBackend: spec.sandboxBackend,
  };
  const job: BackgroundJob = { meta, proc, logPath, metaPath };
  registryFor(spec.cwd).jobs.set(id, job);
  await persistMeta(job);

  proc.on("close", (code) => {
    meta.status = meta.status === "killed" ? "killed" : "exited";
    meta.exitCode = code;
    meta.finishedAt = new Date().toISOString();
    log.end();
    void persistMeta(job);
    fireCompletion(spec.cwd, meta);
  });
  proc.on("error", () => {
    meta.status = "failed";
    meta.finishedAt = new Date().toISOString();
    log.end();
    void persistMeta(job);
    fireCompletion(spec.cwd, meta);
  });
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

/**
 * Build an actionable "unknown job" error. A bare `unknown job: <id>` is a
 * dead end — the model (which sometimes hallucinates a placeholder id like
 * `job_1a2b3c4d`) has nothing to recover from and stalls. We instead list the
 * jobs that actually exist this session, with their status, and point at
 * where a real id comes from.
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
  if (!job?.proc || job.meta.status !== "running") return false;
  await terminateJob(job, KILL_GRACE_MS);
  return true;
}

/**
 * Cascade-stop every running background job in this engine process.
 * Call on serve/CLI/TUI process exit — not on turn cancel or soft session
 * dispose (those must leave servers up for reconnect).
 *
 * @returns number of jobs that were signaled
 */
export async function killAllJobs(): Promise<number> {
  const running: BackgroundJob[] = [];
  for (const reg of registries.values()) {
    for (const job of reg.jobs.values()) {
      if (job.meta.status === "running" && job.proc) running.push(job);
    }
  }
  await Promise.all(running.map((job) => terminateJob(job, KILL_ALL_GRACE_MS)));
  return running.length;
}

async function terminateJob(job: BackgroundJob, graceMs: number): Promise<void> {
  if (!job.proc || job.meta.status !== "running") return;
  job.meta.status = "killed";
  killProcessTree(job.proc, "SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => {
      job.proc?.once("close", () => resolve());
    }),
    new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
  ]);
  // Still alive after grace → escalate.
  if (job.proc.exitCode === null && job.proc.signalCode === null) {
    killProcessTree(job.proc, "SIGKILL");
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
 * Write data to a background job's stdin. Used by the `write_stdin` tool to
 * send input to interactive long-running processes (REPLs, servers, CLIs
 * that read stdin).
 *
 * The status is re-checked here rather than trusted from the caller: a job
 * can exit between the caller's check and this write, and the result tells
 * the caller which of those actually happened.
 *
 * When `appendNewline` is true (default), a `\n` is appended — most CLI
 * tools expect line-terminated input. Set it to false for raw binary input.
 */
export async function writeJobStdin(
  cwd: string,
  id: string,
  data: string,
  opts: { appendNewline?: boolean } = {}
): Promise<WriteJobStdinResult> {
  const job = registryFor(cwd).jobs.get(id);
  if (!job?.proc) return { ok: false, reason: "no-such-job" };
  if (job.meta.status !== "running") {
    return { ok: false, reason: "not-running", status: job.meta.status };
  }
  const stdin = job.proc.stdin;
  if (!stdin || stdin.destroyed) return { ok: false, reason: "no-stdin" };
  const payload = opts.appendNewline === false ? data : data + "\n";
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

/** Read the tail of a job's log. */
export async function readJobLog(
  cwd: string,
  id: string,
  tailLines = 100
): Promise<string> {
  const logPath = join(jobsDir(cwd), `${id}.log`);
  try {
    const text = await readFile(logPath, "utf-8");
    const lines = text.split(/\r?\n/);
    const tail = lines.slice(-tailLines);
    const prefix =
      lines.length > tailLines
        ? `[...${lines.length - tailLines} earlier lines omitted]\n`
        : "";
    return prefix + tail.join("\n");
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
