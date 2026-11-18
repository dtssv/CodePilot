import type { Codepilot } from "../state/useCodepilot.js";
import { t } from "../i18n.js";

export function TaskStatusChip({ cp }: { cp: Codepilot }): React.ReactElement {
  const s = cp.state;
  const last = [...s.rows].reverse().find((r) => r.kind !== "usage");
  const failed = s.status === "idle" && last?.kind === "error";
  const [label, tone] =
    s.status === "waiting_permission"
      ? [t("Waiting for approval"), "bg-[var(--color-warn-dim)] text-[var(--color-warn)]"]
      : s.status === "waiting_question"
        ? [t("Waiting for your answer"), "bg-[var(--color-accent-dim)] text-[var(--color-accent)]"]
        : s.status !== "idle"
          ? [t("Working"), "bg-[var(--color-accent-dim)] text-[var(--color-accent)]"]
          : failed
            ? [t("failed"), "bg-[var(--color-remove-dim)] text-[var(--color-remove)]"]
            : s.rows.length > 0
              ? [t("done"), "bg-[var(--color-add-dim)] text-[var(--color-add)]"]
              : [t("Ready"), "bg-[var(--color-surface-hover)] text-[var(--color-ink-dim)]"];
  return (
    <span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {s.status !== "idle" && <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-current" />}
      {label}
    </span>
  );
}
