import { useState } from "react";

import { t } from "../../i18n.js";
import { XIcon } from "../Icons.js";
import type { ScheduleModelOpt, Task } from "./types.js";

export type ScheduleSectionProps = {
  idleTitle: string;
  setIdleTitle: (v: string) => void;
  idlePrompt: string;
  setIdlePrompt: (v: string) => void;
  taskKind: "idle" | "once" | "daily" | "weekly" | "interval" | "cron";
  setTaskKind: (v: ScheduleSectionProps["taskKind"]) => void;
  taskOnceAt: string;
  setTaskOnceAt: (v: string) => void;
  taskAt: string;
  setTaskAt: (v: string) => void;
  taskEvery: number;
  setTaskEvery: (v: number) => void;
  taskCron: string;
  setTaskCron: (v: string) => void;
  taskWeekdays: number[];
  setTaskWeekdays: React.Dispatch<React.SetStateAction<number[]>>;
  taskTimezone: string;
  setTaskTimezone: (v: string) => void;
  idleModelKey: string;
  setIdleModelKey: (v: string) => void;
  idleAgentMode: "chat" | "plan" | "agent";
  setIdleAgentMode: (v: "chat" | "plan" | "agent") => void;
  scheduleModels: ScheduleModelOpt[];
  editingTaskId: string | null;
  busy: boolean;
  saveEditIdle: () => Promise<boolean>;
  cancelEditIdle: () => void;
  addIdle: () => Promise<boolean>;
  tasks: Task[];
  beginEditIdle: (task: Task) => void;
  removeTask: (id: string) => Promise<void>;
};

function taskScheduleLabel(task: Task): string {
  if (task.kind === "once") {
    return task.runAt ? new Date(task.runAt).toLocaleString() : t("Once");
  }
  if (task.kind === "daily") {
    return `${t("Daily")} ${task.at ?? ""}${task.timezone ? ` (${task.timezone})` : ""}`.trim();
  }
  if (task.kind === "weekly") {
    return `${t("Weekly")} ${task.at ?? ""} [${(task.daysOfWeek ?? []).join(",")}]${task.timezone ? ` (${task.timezone})` : ""}`.trim();
  }
  if (task.kind === "cron") {
    return `${t("Cron")} ${task.cron ?? ""}${task.timezone ? ` (${task.timezone})` : ""}`.trim();
  }
  if (task.kind === "interval") {
    return `${t("Every N minutes")} (${task.everyMinutes ?? "?"})`;
  }
  return t("When idle");
}

export function ScheduleSection({
  idleTitle,
  setIdleTitle,
  idlePrompt,
  setIdlePrompt,
  taskKind,
  setTaskKind,
  taskOnceAt,
  setTaskOnceAt,
  taskAt,
  setTaskAt,
  taskEvery,
  setTaskEvery,
  taskCron,
  setTaskCron,
  taskWeekdays,
  setTaskWeekdays,
  taskTimezone,
  setTaskTimezone,
  idleModelKey,
  setIdleModelKey,
  idleAgentMode,
  setIdleAgentMode,
  scheduleModels,
  editingTaskId,
  busy,
  saveEditIdle,
  cancelEditIdle,
  addIdle,
  tasks,
  beginEditIdle,
  removeTask,
}: ScheduleSectionProps): React.ReactElement {
  const [formOpen, setFormOpen] = useState(false);

  const closeForm = (): void => {
    cancelEditIdle();
    setFormOpen(false);
  };

  const openCreate = (): void => {
    cancelEditIdle();
    setFormOpen(true);
  };

  const openEdit = (task: Task): void => {
    beginEditIdle(task);
    setFormOpen(true);
  };

  const submit = async (): Promise<void> => {
    const ok = editingTaskId ? await saveEditIdle() : await addIdle();
    if (ok) setFormOpen(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 text-[12px] text-[var(--color-ink-dim)]">
          {tasks.length === 0
            ? t("No scheduled tasks yet.")
            : `${tasks.length} ${t("Schedule")}`}
        </div>
        <button type="button" className="cp-btn shrink-0 py-1.5 text-[12px]" disabled={busy} onClick={openCreate}>
          {t("Add scheduled task")}
        </button>
      </div>

      <div className="space-y-1.5">
        {tasks.map((task) => {
          const neverRun = !task.lastRunAt;
          const schedule = taskScheduleLabel(task);
          return (
            <div
              key={task.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-edge-subtle)] px-2.5 py-2 text-[12px]"
            >
              <span className={task.enabled ? "text-[var(--color-add)]" : "text-[var(--color-ink-faint)]"}>
                {task.enabled ? "●" : "○"}
              </span>
              <span className="min-w-0 flex-1 text-[var(--color-ink)]">
                <span className="block truncate">
                  {task.title}{" "}
                  <span className="text-[var(--color-ink-faint)]">
                    [{schedule}
                    {task.model ? ` · ${task.model}` : ""}
                    {task.agentMode && task.agentMode !== "agent" ? ` · ${task.agentMode}` : ""}]
                  </span>
                  {neverRun ? (
                    <span className="ml-1 text-[10px] text-[var(--color-accent)]">{t("pending")}</span>
                  ) : (
                    <span
                      className={`ml-1 text-[10px] ${
                        task.lastStatus === "error"
                          ? "text-[var(--color-remove)]"
                          : "text-[var(--color-ink-faint)]"
                      }`}
                    >
                      {task.lastStatus ?? "ran"}
                    </span>
                  )}
                </span>
                {!neverRun && (
                  <span className="mt-0.5 block truncate text-[10px] text-[var(--color-ink-faint)]">
                    {t("Last run")}: {new Date(task.lastRunAt as number).toLocaleString()}
                    {typeof task.runCount === "number" ? ` · ${t("Runs")}: ${task.runCount}` : ""}
                    {task.lastStatus === "error" && task.lastError ? ` · ${task.lastError}` : ""}
                  </span>
                )}
              </span>
              {neverRun && (
                <button
                  type="button"
                  className="cp-btn-ghost py-0.5 text-[11px]"
                  disabled={busy}
                  onClick={() => openEdit(task)}
                >
                  {t("Edit")}
                </button>
              )}
              <button
                type="button"
                className="cp-btn-ghost py-0.5 text-[11px] text-[var(--color-remove)]"
                disabled={busy}
                onClick={() => void removeTask(task.id)}
              >
                {t("Remove")}
              </button>
            </div>
          );
        })}
      </div>

      {formOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={closeForm}
        >
          <div
            className="flex max-h-[min(640px,90vh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={editingTaskId ? t("Edit") : t("New scheduled task")}
          >
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-edge-subtle)] px-4">
              <div className="min-w-0 flex-1 text-[13.5px] font-semibold text-[var(--color-ink)]">
                {editingTaskId ? t("Edit") : t("New scheduled task")}
              </div>
              <button type="button" className="cp-icon-btn" title={t("Close")} onClick={closeForm}>
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
              <label className="block">
                <span className="cp-eyebrow">{t("Title")}</span>
                <input
                  className="cp-input mt-0.5 w-full"
                  value={idleTitle}
                  onChange={(e) => setIdleTitle(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="cp-eyebrow">{t("Prompt")}</span>
                <textarea
                  className="cp-input mt-0.5 min-h-24 w-full text-[12.5px]"
                  value={idlePrompt}
                  onChange={(e) => setIdlePrompt(e.target.value)}
                  placeholder={t("e.g. Summarize unread Feishu docs and draft a status update")}
                />
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="cp-eyebrow">{t("Task type")}</span>
                  <select
                    className="cp-input mt-0.5 w-full text-[12.5px]"
                    value={taskKind}
                    onChange={(e) =>
                      setTaskKind(
                        e.target.value as "idle" | "once" | "daily" | "weekly" | "interval" | "cron",
                      )
                    }
                  >
                    <option value="idle">{t("When idle")}</option>
                    <option value="once">{t("Once")}</option>
                    <option value="daily">{t("Daily")}</option>
                    <option value="weekly">{t("Weekly")}</option>
                    <option value="interval">{t("Every N minutes")}</option>
                    <option value="cron">{t("Cron")}</option>
                  </select>
                </label>
                {taskKind === "once" && (
                  <label className="block">
                    <span className="cp-eyebrow">{t("Run at")}</span>
                    <input
                      type="datetime-local"
                      className="cp-input mt-0.5 w-full text-[12.5px]"
                      value={taskOnceAt}
                      onChange={(e) => setTaskOnceAt(e.target.value)}
                    />
                  </label>
                )}
                {(taskKind === "daily" || taskKind === "weekly") && (
                  <label className="block">
                    <span className="cp-eyebrow">{t("Run at")}</span>
                    <input
                      type="time"
                      className="cp-input mt-0.5 w-full text-[12.5px]"
                      value={taskAt}
                      onChange={(e) => setTaskAt(e.target.value)}
                    />
                  </label>
                )}
                {taskKind === "interval" && (
                  <label className="block">
                    <span className="cp-eyebrow">{t("Every (minutes)")}</span>
                    <input
                      type="number"
                      min={1}
                      className="cp-input mt-0.5 w-full text-[12.5px]"
                      value={taskEvery}
                      onChange={(e) => setTaskEvery(Math.max(1, Number(e.target.value) || 1))}
                    />
                  </label>
                )}
                {taskKind === "cron" && (
                  <label className="block">
                    <span className="cp-eyebrow">{t("Cron expression")}</span>
                    <input
                      type="text"
                      className="cp-input mt-0.5 w-full font-mono text-[12.5px]"
                      value={taskCron}
                      onChange={(e) => setTaskCron(e.target.value)}
                      placeholder="0 9 * * 1-5"
                    />
                  </label>
                )}
              </div>
              {taskKind === "weekly" && (
                <div className="block">
                  <span className="cp-eyebrow">{t("Weekdays")}</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {[
                      { d: 0, label: t("Sun") },
                      { d: 1, label: t("Mon") },
                      { d: 2, label: t("Tue") },
                      { d: 3, label: t("Wed") },
                      { d: 4, label: t("Thu") },
                      { d: 5, label: t("Fri") },
                      { d: 6, label: t("Sat") },
                    ].map(({ d, label }) => {
                      const on = taskWeekdays.includes(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          className="cp-chip text-[12px]"
                          style={
                            on
                              ? {
                                  borderColor: "var(--color-accent)",
                                  color: "var(--color-ink)",
                                }
                              : undefined
                          }
                          onClick={() =>
                            setTaskWeekdays((prev) =>
                              prev.includes(d)
                                ? prev.filter((x) => x !== d)
                                : [...prev, d].sort((a, b) => a - b),
                            )
                          }
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {(taskKind === "daily" || taskKind === "weekly" || taskKind === "cron") && (
                <label className="block">
                  <span className="cp-eyebrow">{t("Timezone (optional)")}</span>
                  <input
                    type="text"
                    className="cp-input mt-0.5 w-full text-[12.5px]"
                    value={taskTimezone}
                    onChange={(e) => setTaskTimezone(e.target.value)}
                    placeholder="America/New_York"
                  />
                </label>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="cp-eyebrow">{t("Model")}</span>
                  <select
                    className="cp-input mt-0.5 w-full text-[12.5px]"
                    value={idleModelKey}
                    onChange={(e) => setIdleModelKey(e.target.value)}
                  >
                    <option value="">{t("Host default model")}</option>
                    {scheduleModels.map((m) => (
                      <option key={m.id} value={`${m.providerId}::${m.model}`}>
                        {m.providerLabel}: {m.model}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="cp-eyebrow">{t("Tool mode")}</span>
                  <select
                    className="cp-input mt-0.5 w-full text-[12.5px]"
                    value={idleAgentMode}
                    onChange={(e) => setIdleAgentMode(e.target.value as "chat" | "plan" | "agent")}
                  >
                    <option value="agent">{t("Agent (full tools)")}</option>
                    <option value="plan">{t("Plan")}</option>
                    <option value="chat">{t("Chat (read-leaning)")}</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--color-edge-subtle)] px-4 py-3">
              <button type="button" className="cp-btn-ghost" disabled={busy} onClick={closeForm}>
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="cp-btn"
                disabled={busy || !idlePrompt.trim()}
                onClick={() => void submit()}
              >
                {editingTaskId
                  ? t("Save changes")
                  : taskKind === "idle"
                    ? t("Add idle task")
                    : t("Add scheduled task")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
