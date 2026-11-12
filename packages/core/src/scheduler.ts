/**
 * Scheduled / idle tasks — run prompts when the machine is free, at a wall-clock
 * time, on an interval, or on a 5-field cron expression.
 *
 * Idle tasks: queued with `kind: "idle"`; a watcher runs them when the local
 * engine reports no busy sessions for `idleAfterMs` (default 10 min).
 * Time tasks: one-time (`once`), daily `HH:MM`, weekly (`HH:MM` + weekdays),
 * interval minutes, or `cron` (standard 5-field `min hour dom month dow`).
 * `cron` and `daily`/`weekly` honour an optional IANA `timezone` (e.g.
 * "America/New_York"); without one they use the host's local time.
 *
 * Delivery: each run either opens a fresh one-shot session (default) or posts
 * the prompt as a follow-up into an existing session (`delivery.sessionId`).
 *
 * Lifecycle: a task can be `paused` (kept but never due) and can carry an
 * `endsAt` epoch after which it stops firing (and one-time/`once` auto-disables
 * after it runs).
 *
 * Persistence: `~/.codepilot/scheduled-tasks.json`
 * Execution is host-driven (`startSchedulerWatcher` from CLI/desktop).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE = join(homedir(), ".codepilot", "scheduled-tasks.json");

export type ScheduledTaskKind =
  | "idle"
  | "once"
  | "daily"
  | "weekly"
  | "interval"
  | "cron";

/** Where a scheduled run is delivered. `new_session` (default) opens a fresh
 * one-shot session; `{ sessionId }` posts the prompt as a follow-up into an
 * existing session so results land in a conversation the user already has. */
export type ScheduledDelivery = "new_session" | { sessionId: string };

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  kind: ScheduledTaskKind;
  /** For daily/once/weekly: "HH:MM" (in `timezone` when set, else local). */
  at?: string;
  /** For weekly: weekdays to fire on (0 = Sunday … 6 = Saturday). */
  daysOfWeek?: number[];
  /** For cron: a standard 5-field expression `min hour dom month dow`. */
  cron?: string;
  /** IANA timezone (e.g. "America/New_York") for daily/weekly/cron matching.
   * Omit to use the host's local time. */
  timezone?: string;
  /** For once: absolute epoch ms to run at (takes precedence over `at`). */
  runAt?: number;
  /** For interval: minutes between runs. */
  everyMinutes?: number;
  /** Idle: how long with no busy sessions before run (ms). */
  idleAfterMs?: number;
  /** Where to deliver the run. Default `new_session`. */
  delivery?: ScheduledDelivery;
  /** Paused: kept in the store but never due until un-paused. */
  paused?: boolean;
  /** Stop firing after this epoch ms (inclusive). Omit for no expiry. */
  endsAt?: number;
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

/** Calendar fields of an instant, in a given IANA timezone (or host-local when
 * omitted). Used so daily/weekly/cron matching respects `task.timezone`. */
interface CalendarFields {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number; // 1-12
  dayOfWeek: number; // 0 = Sunday … 6 = Saturday
  year: number;
}

export function calendarFieldsIn(now: Date, timezone?: string): CalendarFields {
  if (!timezone) {
    return {
      minute: now.getMinutes(),
      hour: now.getHours(),
      dayOfMonth: now.getDate(),
      month: now.getMonth() + 1,
      dayOfWeek: now.getDay(),
      year: now.getFullYear(),
    };
  }
  // Intl gives us the wall-clock fields in the target zone without pulling in a
  // tz database. An invalid zone throws → caller treats the task as not-due.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // some ICU builds emit 24 for midnight
  return {
    minute: Number(get("minute")),
    hour,
    dayOfMonth: Number(get("day")),
    month: Number(get("month")),
    dayOfWeek: weekdayMap[get("weekday")] ?? 0,
    year: Number(get("year")),
  };
}

/** Parse one cron field (e.g. `*`, `5`, `1-5`, step like `*` over 15, `1,3,5`)
 * into the set of matching integers within [min,max]. Returns null when the
 * field is malformed. */
export function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const token = part.trim();
    if (token.length === 0) return null;
    let step = 1;
    let rangeStr = token;
    const slash = token.indexOf("/");
    if (slash >= 0) {
      rangeStr = token.slice(0, slash);
      step = Number(token.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    let lo = min;
    let hi = max;
    if (rangeStr === "*" || rangeStr === "") {
      // full range with step
    } else if (rangeStr.includes("-")) {
      const [a, b] = rangeStr.split("-");
      lo = Number(a);
      hi = Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      lo = hi = Number(rangeStr);
      if (!Number.isInteger(lo)) return null;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

/** Parse a standard 5-field cron expression. Returns null when malformed. */
export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCronField(fields[0]!, 0, 59);
  const hour = parseCronField(fields[1]!, 0, 23);
  const dayOfMonth = parseCronField(fields[2]!, 1, 31);
  const month = parseCronField(fields[3]!, 1, 12);
  // Accept both 0 and 7 for Sunday by normalizing 7 → 0.
  const dowRaw = parseCronField(fields[4]!, 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dowRaw) return null;
  const dayOfWeek = new Set<number>();
  for (const d of dowRaw) dayOfWeek.add(d === 7 ? 0 : d);
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** Whether `cal` satisfies a parsed cron expression. Follows the common cron
 * rule: when BOTH day-of-month and day-of-week are restricted (not `*`), the
 * task fires when EITHER matches; otherwise both must match. */
export function cronMatches(parsed: ParsedCron, cal: CalendarFields): boolean {
  const minOk = parsed.minute.has(cal.minute);
  const hourOk = parsed.hour.has(cal.hour);
  const monthOk = parsed.month.has(cal.month);
  if (!minOk || !hourOk || !monthOk) return false;
  const domRestricted = parsed.dayOfMonth.size < 31;
  const dowRestricted = parsed.dayOfWeek.size < 7;
  const domOk = parsed.dayOfMonth.has(cal.dayOfMonth);
  const dowOk = parsed.dayOfWeek.has(cal.dayOfWeek);
  if (domRestricted && dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

function matchesAt(at: string, cal: CalendarFields): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return cal.hour === h && cal.minute === min;
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

  // True when `lastRunAt` falls in the same wall-clock minute as `now` in the
  // task's timezone — used to fire a time-based task at most once per minute.
  const ranThisMinute = (task: ScheduledTask, cal: CalendarFields): boolean => {
    if (!task.lastRunAt) return false;
    const last = calendarFieldsIn(new Date(task.lastRunAt), task.timezone);
    return (
      last.year === cal.year &&
      last.month === cal.month &&
      last.dayOfMonth === cal.dayOfMonth &&
      last.hour === cal.hour &&
      last.minute === cal.minute
    );
  };

  for (const task of store.tasks) {
    if (!task.enabled) continue;
    // Paused tasks are kept but never due; an expired task never fires again.
    if (task.paused) continue;
    if (typeof task.endsAt === "number" && now > task.endsAt) continue;

    let cal: CalendarFields;
    try {
      cal = calendarFieldsIn(date, task.timezone);
    } catch {
      // Invalid timezone → treat as not due (don't crash the whole tick).
      continue;
    }

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
        due = !task.lastRunAt && matchesAt(task.at, cal);
      }
    } else if (task.kind === "daily" && task.at) {
      due = matchesAt(task.at, cal) && !ranThisMinute(task, cal);
    } else if (task.kind === "weekly" && task.at) {
      const days = task.daysOfWeek ?? [];
      due =
        days.includes(cal.dayOfWeek) &&
        matchesAt(task.at, cal) &&
        !ranThisMinute(task, cal);
    } else if (task.kind === "cron" && task.cron) {
      const parsed = parseCron(task.cron);
      due = parsed !== null && cronMatches(parsed, cal) && !ranThisMinute(task, cal);
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
