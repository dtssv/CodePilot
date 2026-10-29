/**
 * Scheduled / idle tasks — run prompts when the machine is free or on a cron.
 *
 * Idle tasks: queued with `kind: "idle"`; a watcher runs them when the local
 * engine reports no busy sessions for `idleAfterMs` (default 10 min).
 * Scheduled tasks: one-time (`once`), daily `HH:MM`, or interval minutes.
 *
 * Persistence: `~/.codepilot/scheduled-tasks.json`
 * Execution is host-driven (`startSchedulerWatcher` from CLI/desktop).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE = join(homedir(), ".codepilot", "scheduled-tasks.json");

export type ScheduledTaskKind = "idle" | "once" | "daily" | "interval";

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  kind: ScheduledTaskKind;
  /** For daily/once: "HH:MM" local time. */
  at?: string;
  /** For once: absolute epoch ms to run at (takes precedence over `at`). */
  runAt?: number;
  /** For interval: minutes between runs. */
  everyMinutes?: number;
  /** Idle: how long with no busy sessions before run (ms). */
  idleAfterMs?: number;
  /** Optional model id for the one-shot session (default: host config model). */
  model?: string;
  /** Optional provider preset id paired with `model`. */
  providerId?: string;
  /**
   * Agent mode for the run. Default `"agent"` — full tool surface from the
   * session registry (same as a normal agent chat). `"chat"` / `"plan"` narrow tools.
   */
  agentMode?: "chat" | "plan" | "agent";
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  /** How many times this task has run (for the execution-history view). */
  runCount?: number;
}

interface StoreFile {
  tasks: ScheduledTask[];
}

async function load(): Promise<StoreFile> {
  try {
    const j = JSON.parse(await readFile(STORE, "utf-8")) as StoreFile;
    return { tasks: Array.isArray(j.tasks) ? j.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

async function save(s: StoreFile): Promise<void> {
  await mkdir(join(homedir(), ".codepilot"), { recursive: true });
  await writeFile(STORE, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

export async function listScheduledTasks(): Promise<ScheduledTask[]> {
  return (await load()).tasks;
}

export async function addScheduledTask(
  input: Omit<ScheduledTask, "id" | "createdAt" | "enabled"> & { enabled?: boolean },
): Promise<ScheduledTask> {
  const store = await load();
  const task: ScheduledTask = {
    ...input,
    id: randomUUID().slice(0, 10),
    createdAt: Date.now(),
    enabled: input.enabled !== false,
  };
  store.tasks.push(task);
  await save(store);
  return task;
}

export async function updateScheduledTask(
  id: string,
  patch: Partial<ScheduledTask>,
): Promise<ScheduledTask | null> {
  const store = await load();
  const i = store.tasks.findIndex((t) => t.id === id);
  if (i < 0) return null;
  store.tasks[i] = { ...store.tasks[i]!, ...patch, id };
  await save(store);
  return store.tasks[i]!;
}

export async function removeScheduledTask(id: string): Promise<boolean> {
  const store = await load();
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((t) => t.id !== id);
  await save(store);
  return store.tasks.length < before;
}

export interface SchedulerTickContext {
  now?: number;
  /** True when no sessions are busy on this host. */
  isIdle: boolean;
  /** How long the host has been idle (ms). */
  idleForMs: number;
  /** Run the task prompt; return ok/error. */
  run: (task: ScheduledTask) => Promise<{ ok: boolean; error?: string }>;
}

function matchesDaily(at: string, now: Date): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return now.getHours() === h && now.getMinutes() === min;
}

/**
 * One scheduler tick — call every ~30–60s from the host process.
 * Returns ids that were attempted this tick.
 */
export async function schedulerTick(ctx: SchedulerTickContext): Promise<string[]> {
  const now = ctx.now ?? Date.now();
  const date = new Date(now);
  const store = await load();
  const ran: string[] = [];

  for (const task of store.tasks) {
    if (!task.enabled) continue;
    let due = false;
    if (task.kind === "idle") {
      const need = task.idleAfterMs ?? 10 * 60 * 1000;
      due = ctx.isIdle && ctx.idleForMs >= need;
      // At most once per idle window: skip if ran in last need/2
      if (task.lastRunAt && now - task.lastRunAt < need / 2) due = false;
    } else if (task.kind === "once") {
      // Fire once when we reach the target time, then auto-disable so it
      // never repeats. `runAt` (absolute epoch) wins over `at` ("HH:MM" today).
      if (typeof task.runAt === "number") {
        due = !task.lastRunAt && now >= task.runAt;
      } else if (task.at) {
        due = !task.lastRunAt && matchesDaily(task.at, date);
      }
    } else if (task.kind === "daily" && task.at) {
      due = matchesDaily(task.at, date);
      if (task.lastRunAt) {
        const last = new Date(task.lastRunAt);
        if (
          last.getFullYear() === date.getFullYear() &&
          last.getMonth() === date.getMonth() &&
          last.getDate() === date.getDate() &&
          last.getHours() === date.getHours() &&
          last.getMinutes() === date.getMinutes()
        ) {
          due = false;
        }
      }
    } else if (task.kind === "interval" && task.everyMinutes) {
      const gap = task.everyMinutes * 60 * 1000;
      due = !task.lastRunAt || now - task.lastRunAt >= gap;
    }
    if (!due) continue;

    ran.push(task.id);
    try {
      const r = await ctx.run(task);
      task.lastRunAt = now;
      task.lastStatus = r.ok ? "ok" : "error";
      task.lastError = r.error;
      task.runCount = (task.runCount ?? 0) + 1;
    } catch (err) {
      task.lastRunAt = now;
      task.lastStatus = "error";
      task.lastError = err instanceof Error ? err.message : String(err);
      task.runCount = (task.runCount ?? 0) + 1;
    }
    // A one-time task never repeats: disable it once it has fired.
    if (task.kind === "once") task.enabled = false;
  }
  await save(store);
  return ran;
}

export interface SchedulerWatcherHandle {
  stop: () => void;
}

/**
 * Background watcher for long-lived CLI/desktop processes.
 */
export function startSchedulerWatcher(
  opts: {
    isIdle: () => boolean;
    idleForMs: () => number;
    run: (task: ScheduledTask) => Promise<{ ok: boolean; error?: string }>;
    intervalMs?: number;
  },
): SchedulerWatcherHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    void schedulerTick({
      isIdle: opts.isIdle(),
      idleForMs: opts.idleForMs(),
      run: opts.run,
    });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
