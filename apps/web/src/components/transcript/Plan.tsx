import type { PlanStep } from "@codepilot/core";

import { planProgress } from "../../state/selectors.js";
import { t } from "../../i18n.js";
import { ListIcon } from "../Icons.js";
import { StepMark } from "./icons.js";
import { Divider } from "./MessageViews.js";

export function PlanChecklist({ steps, dense = false }: { steps: PlanStep[]; dense?: boolean }): React.ReactElement {
  return (
    <ol className={dense ? "space-y-1" : "space-y-1.5"}>
      {steps.map((s) => (
        <li key={s.id} className="flex items-start gap-2 text-[12.5px] leading-5">
          <StepMark status={s.status} />
          <span
            className={
              s.status === "completed"
                ? "text-[var(--color-ink-faint)] line-through decoration-[var(--color-ink-faint)]/50"
                : s.status === "in_progress"
                  ? "font-medium text-[var(--color-ink)]"
                  : "text-[var(--color-ink-dim)]"
            }
          >
            {s.title}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ProgressBar({ done, total }: { done: number; total: number }): React.ReactElement {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
      <div className="cp-brand-gradient h-full rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PlanCard({ steps }: { steps: PlanStep[] }): React.ReactElement {
  const p = planProgress(steps);
  return (
    <div className="animate-fade-in rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] p-3">
      <div className="mb-2.5 flex items-center gap-2">
        <ListIcon className="h-3.5 w-3.5 text-[var(--color-accent)]" />
        <span className="text-[12px] font-semibold text-[var(--color-ink)]">{t("Plan")}</span>
        <span className="text-[11px] text-[var(--color-ink-faint)]">
          {p.done} {t("of")} {p.total}
        </span>
        <div className="ml-auto w-24">
          <ProgressBar done={p.done} total={p.total} />
        </div>
      </div>
      <PlanChecklist steps={steps} />
    </div>
  );
}

export function PlanMarker({ steps }: { steps: PlanStep[] }): React.ReactElement {
  const p = planProgress(steps);
  return (
    <Divider icon={<ListIcon className="h-3 w-3" />}>
      {t("Plan updated")} · {p.done}/{p.total}
      {p.current ? ` · ${p.current.title}` : ""}
    </Divider>
  );
}