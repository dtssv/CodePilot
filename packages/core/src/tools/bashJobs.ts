// Background job registry for the bash tool.
//
// A background job is a detached child process whose stdout/stderr stream
// into `.codepilot/jobs/<jobId>.log`, with metadata in `<jobId>.json`.
// The registry is module-level and keyed by cwd, so the `bash`,
// `bash_output` and `bash_kill` tools share it within a session.
//
// Job state survives the command that started it, but NOT a process
// restart of CodePilot itself: on disk, jobs whose metadata says
// "running" at load time are reported as "unknown" (the pid may be dead
// or reused). This mirrors claude-code's BashOutput/KillShell model.

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

export interface JobMeta {
  id: string;
  command: string;
  cwd: string;
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

function registryFor(cwd: string): Registry {
  let r = registries.get(cwd);
  if (!r) {
    r = { jobs: new Map(), completionListeners: new Set() };
    registries.set(cwd, r);
  }
  return r;
}

/** Register a listener fired when any job in this cwd finishes (exits, is
 *  killed, or errors). Returns an unsubscribe function. The session uses
 *  this to push a steering message into the agent loop so the model learns
 *  the job is done without having to poll. */
export function onJobCompletion(
  cwd: string,
  listener: (meta: JobMeta) => void
): () => void {
  const r = registryFor(cwd);
  r.completionListeners.add(listener);
  return () => r.completionListeners.delete(listener);
}

export function jobsDir(cwd: string): string {
  return join(cwd, ".codepilot", "jobs");
}

export interface SpawnJobSpec {
  command: string;
  cwd: string;
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

  const log = createWriteStream(logPath, { flags: "a" });
  const proc = spawn(spec.shell, [...spec.shellArgs, spec.command], {
    cwd: spec.cwd,
    env: process.env,
    // Use "pipe" for stdin so write_stdin can send input to interactive
    // long-running processes (REPLs, servers, CLIs that read stdin).
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (b: Buffer) => log.write(b));
  proc.stderr?.on("data", (b: Buffer) => log.write(b));

  const meta: JobMeta = {
    id,
    command: spec.command,
    cwd: spec.cwd,
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

/** Kill a job (SIGTERM). Returns false when the process is not alive. */
export async function killJob(cwd: string, id: string): Promise<boolean> {
  const job = registryFor(cwd).jobs.get(id);
  if (!job?.proc || job.meta.status !== "running") return false;
  job.meta.status = "killed";
  try {
    job.proc.kill("SIGTERM");
  } catch {
    /* already dead */
  }
  await persistMeta(job);
  return true;
}

/**
 * Write data to a background job's stdin. Used by the `write_stdin` tool to
 * send input to interactive long-running processes (REPLs, servers, CLIs
 * that read stdin). Returns false when the job is not running or has no
 * writable stdin (e.g. restored from disk after a restart).
 *
 * When `appendNewline` is true (default), a `\n` is appended — most CLI
 * tools expect line-terminated input. Set it to false for raw binary input.
 */
export async function writeJobStdin(
  cwd: string,
  id: string,
  data: string,
  opts: { appendNewline?: boolean } = {}
): Promise<boolean> {
  const job = registryFor(cwd).jobs.get(id);
  if (!job?.proc || job.meta.status !== "running") return false;
  const stdin = job.proc.stdin;
  if (!stdin || stdin.destroyed) return false;
  const payload = opts.appendNewline === false ? data : data + "\n";
  return new Promise<boolean>((resolve) => {
    stdin.write(payload, (err) => resolve(err === undefined));
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
