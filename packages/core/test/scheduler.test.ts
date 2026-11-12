// Scheduler: cron / weekly parsing + timezone-aware tick matching, plus the
// delivery / pause / endsAt lifecycle. Pure parsers are tested directly; tick
// behaviour is driven through the real store (HOME is redirected in setup, so
// the store lands under the temp home).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  parseCronField,
  parseCron,
  cronMatches,
  calendarFieldsIn,
  addScheduledTask,
  updateScheduledTask,
  schedulerTick,
  listScheduledTasks,
  removeScheduledTask,
} from "../src/scheduler.js";

const STORE = join(homedir(), ".codepilot", "scheduled-tasks.json");

async function clearStore(): Promise<void> {
  for (const t of await listScheduledTasks()) await removeScheduledTask(t.id);
  rmSync(STORE, { force: true });
}

describe("parseCronField", () => {
  it("parses wildcard, number, range, step, and list", () => {
    expect([...(parseCronField("*", 0, 5) ?? [])]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...(parseCronField("3", 0, 59) ?? [])]).toEqual([3]);
    expect([...(parseCronField("1-3", 0, 59) ?? [])]).toEqual([1, 2, 3]);
    expect([...(parseCronField("0-10/5", 0, 59) ?? [])]).toEqual([0, 5, 10]);
    expect([...(parseCronField("1,3,5", 0, 59) ?? [])]).toEqual([1, 3, 5]);
  });
  it("rejects out-of-range and malformed fields", () => {
    expect(parseCronField("99", 0, 59)).toBeNull();
    expect(parseCronField("5-1", 0, 59)).toBeNull();
    expect(parseCronField("abc", 0, 59)).toBeNull();
    expect(parseCronField("*/0", 0, 59)).toBeNull();
  });
});

describe("parseCron", () => {
  it("parses a 5-field expression", () => {
    const p = parseCron("30 9 * * 1-5");
    expect(p).not.toBeNull();
    expect(p!.minute.has(30)).toBe(true);
    expect(p!.hour.has(9)).toBe(true);
    expect([...p!.dayOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });
  it("normalizes day-of-week 7 to 0 (Sunday)", () => {
    const p = parseCron("0 0 * * 7");
    expect(p!.dayOfWeek.has(0)).toBe(true);
  });
  it("rejects a wrong field count", () => {
    expect(parseCron("1 2 3")).toBeNull();
    expect(parseCron("1 2 3 4 5 6")).toBeNull();
  });
});

describe("cronMatches", () => {
  const cal = (o: Partial<ReturnType<typeof calendarFieldsIn>>) => ({
    minute: 0, hour: 0, dayOfMonth: 1, month: 1, dayOfWeek: 1, year: 2026, ...o,
  });
  it("matches minute/hour/month", () => {
    const p = parseCron("30 9 * 6 *")!;
    expect(cronMatches(p, cal({ minute: 30, hour: 9, month: 6 }))).toBe(true);
    expect(cronMatches(p, cal({ minute: 31, hour: 9, month: 6 }))).toBe(false);
  });
  it("uses OR when both dom and dow are restricted", () => {
    // Fires on the 15th OR on Monday.
    const p = parseCron("0 0 15 * 1")!;
    expect(cronMatches(p, cal({ dayOfMonth: 15, dayOfWeek: 3 }))).toBe(true); // dom
    expect(cronMatches(p, cal({ dayOfMonth: 2, dayOfWeek: 1 }))).toBe(true); // dow
    expect(cronMatches(p, cal({ dayOfMonth: 2, dayOfWeek: 3 }))).toBe(false);
  });
});

describe("calendarFieldsIn (timezone)", () => {
  it("returns host-local fields without a timezone", () => {
    const d = new Date("2026-06-15T12:34:00");
    const cal = calendarFieldsIn(d);
    expect(cal.hour).toBe(d.getHours());
    expect(cal.minute).toBe(34);
  });
  it("shifts the wall clock into the target timezone", () => {
    // A fixed UTC instant renders to different wall-clock hours per zone.
    const utcNoon = new Date("2026-06-15T12:00:00Z");
    const ny = calendarFieldsIn(utcNoon, "America/New_York"); // UTC-4 in June
    const tokyo = calendarFieldsIn(utcNoon, "Asia/Tokyo"); // UTC+9
    expect(ny.hour).toBe(8);
    expect(tokyo.hour).toBe(21);
  });
});

describe("schedulerTick (cron / weekly / lifecycle)", () => {
  beforeEach(async () => {
    await clearStore();
  });
  afterEach(async () => {
    await clearStore();
  });

  const noRun = { isIdle: false, idleForMs: 0, run: async () => ({ ok: true }) };

  it("fires a cron task at a matching minute in the given timezone", async () => {
    await addScheduledTask({
      title: "t", prompt: "p", cwd: "/tmp",
      kind: "cron", cron: "0 9 * * *", timezone: "America/New_York",
    });
    // 13:00 UTC = 09:00 America/New_York (June, UTC-4) → due.
    const due = new Date("2026-06-15T13:00:00Z").getTime();
    const ran = await schedulerTick({ ...noRun, now: due });
    expect(ran.length).toBe(1);
    // 14:00 UTC = 10:00 NY → not due.
    await clearStore();
    await addScheduledTask({
      title: "t", prompt: "p", cwd: "/tmp",
      kind: "cron", cron: "0 9 * * *", timezone: "America/New_York",
    });
    const notDue = new Date("2026-06-15T14:00:00Z").getTime();
    expect((await schedulerTick({ ...noRun, now: notDue })).length).toBe(0);
  });

  it("fires a weekly task only on listed weekdays", async () => {
    await addScheduledTask({
      title: "w", prompt: "p", cwd: "/tmp",
      kind: "weekly", at: "08:00", daysOfWeek: [1], // Monday
    });
    // 2026-06-15 is a Monday; use a local-time 08:00.
    const monday = new Date(2026, 5, 15, 8, 0, 0).getTime();
    expect((await schedulerTick({ ...noRun, now: monday })).length).toBe(1);
    await clearStore();
    await addScheduledTask({
      title: "w", prompt: "p", cwd: "/tmp",
      kind: "weekly", at: "08:00", daysOfWeek: [1],
    });
    // 2026-06-16 is a Tuesday → not due.
    const tuesday = new Date(2026, 5, 16, 8, 0, 0).getTime();
    expect((await schedulerTick({ ...noRun, now: tuesday })).length).toBe(0);
  });

  it("does not fire a paused task", async () => {
    await addScheduledTask({
      title: "p", prompt: "p", cwd: "/tmp",
      kind: "cron", cron: "* * * * *", paused: true,
    });
    expect((await schedulerTick({ ...noRun, now: Date.now() })).length).toBe(0);
  });

  it("does not fire a task past its endsAt", async () => {
    const now = new Date(2026, 5, 15, 8, 0, 0).getTime();
    await addScheduledTask({
      title: "e", prompt: "p", cwd: "/tmp",
      kind: "cron", cron: "* * * * *", endsAt: now - 1000,
    });
    expect((await schedulerTick({ ...noRun, now })).length).toBe(0);
  });

  it("delivers a follow-up task via the run callback with the task's delivery", async () => {
    await addScheduledTask({
      title: "f", prompt: "do it", cwd: "/tmp",
      kind: "cron", cron: "* * * * *",
      delivery: { sessionId: "ses_abc" },
    });
    let delivered: unknown = null;
    const ran = await schedulerTick({
      isIdle: false, idleForMs: 0, now: Date.now(),
      run: async (task) => {
        delivered = task.delivery;
        return { ok: true };
      },
    });
    expect(ran.length).toBe(1);
    expect(delivered).toEqual({ sessionId: "ses_abc" });
  });

  it("fires an invalid-cron task never (parse failure is not-due, not a crash)", async () => {
    await addScheduledTask({
      title: "bad", prompt: "p", cwd: "/tmp",
      kind: "cron", cron: "not a cron",
    });
    expect((await schedulerTick({ ...noRun, now: Date.now() })).length).toBe(0);
  });

  it("fires at most once per minute for a cron task", async () => {
    const t = await addScheduledTask({
      title: "c", prompt: "p", cwd: "/tmp",
      kind: "cron", cron: "* * * * *",
    });
    const now = new Date(2026, 5, 15, 8, 0, 0).getTime();
    expect((await schedulerTick({ ...noRun, now })).length).toBe(1);
    // Same minute again → already ran this minute.
    expect((await schedulerTick({ ...noRun, now: now + 5000 })).length).toBe(0);
    // Next minute → due again.
    expect((await schedulerTick({ ...noRun, now: now + 60_000 })).length).toBe(1);
    await updateScheduledTask(t.id, { enabled: false });
  });
});
