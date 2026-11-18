import { useState } from "react";

import type { QuestionAnswers } from "@codepilot/core";
import type { PendingQuestion } from "../../protocol/client.js";
import { t } from "../../i18n.js";
import { CheckIcon, QuestionIcon } from "../Icons.js";

/** `ask_user_question` / `plan_done`: options plus a free-text answer. */
export function QuestionCard({
  req,
  onAnswer,
}: {
  req: PendingQuestion;
  onAnswer(answers: QuestionAnswers): void;
}): React.ReactElement {
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  const pick = (id: string, label: string, multi: boolean): void => {
    setAnswers((prev) => {
      if (!multi) {
        // Single-select is a toggle too: clicking the already-selected option
        // clears it, so the user can undo a pick (and submit free text instead).
        return prev[id] === label ? { ...prev, [id]: "" } : { ...prev, [id]: label };
      }
      const current = prev[id];
      const list = Array.isArray(current) ? current : current ? [current] : [];
      return { ...prev, [id]: list.includes(label) ? list.filter((l) => l !== label) : [...list, label] };
    });
  };
  const isPicked = (id: string, label: string): boolean => {
    const v = answers[id];
    return Array.isArray(v) ? v.includes(label) : v === label;
  };
  const submit = (): void => {
 // Free text wins for its question: the user typed it because no option fit.
    const merged: QuestionAnswers = { ...answers };
    for (const [id, text] of Object.entries(freeText)) {
      if (text.trim() !== "") merged[id] = text.trim();
    }
    // Drop deselected/empty answers so a cancelled single-select doesn't submit
    // an empty string as if it were a choice.
    for (const [id, v] of Object.entries(merged)) {
      if (v === "" || (Array.isArray(v) && v.length === 0)) delete merged[id];
    }
    onAnswer(merged);
  };

  return (
    <div className="animate-fade-in overflow-hidden rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-surface-raised)] shadow-lg shadow-black/10">
      <div className="flex items-center gap-2 border-b border-[var(--color-edge-subtle)] bg-[var(--color-accent-dim)] px-3 py-2 text-[12px] font-semibold text-[var(--color-accent)]">
        <QuestionIcon className="h-3.5 w-3.5" />
        {t("The agent is asking")}
      </div>
      <div className="max-h-[50vh] space-y-4 overflow-auto p-3">
        {req.questions.map((q) => {
          const options = q.options ?? [];
 // Recommendation convention: the FIRST option is treated as the
 // recommended one (core asks callers to put it first / label it
 // "(Recommended)"). Surface it with a badge so the user has a hint.
          return (
            <div key={q.id}>
              {q.header && <div className="cp-eyebrow mb-1">{q.header}</div>}
              <div className="mb-2 select-text whitespace-pre-wrap text-[13px] text-[var(--color-ink)]">
                {q.question}
              </div>
              {/* Vertical list — one option per row, full width, so long
                  answers wrap instead of cramming into chips. */}
              <div className="flex flex-col gap-1.5">
                {options.map((opt, i) => {
                  const picked = isPicked(q.id, opt.label);
                  const recommended =
                    i === 0 || /\(recommended\)|（推荐）|推荐/i.test(opt.label);
                  const cleanLabel = opt.label.replace(/\s*\(recommended\)\s*/i, "").replace(/（推荐）/g, "").trim();
                  // The whole row is the click target (via keyboard too), so a
                  // click anywhere on the option selects it — the checkbox/radio
                  // is just an indicator, not the only hit area. A drag to select
                  // text still works because that fires selectionchange, not click.
                  const toggle = (): void => pick(q.id, opt.label, q.multiSelect === true);
                  return (
                    <div
                      key={opt.label}
                      role={q.multiSelect ? "checkbox" : "radio"}
                      aria-checked={picked}
                      tabIndex={0}
                      onClick={toggle}
                      onKeyDown={(e) => {
                        if (e.key === " " || e.key === "Enter") {
                          e.preventDefault();
                          toggle();
                        }
                      }}
                      className={`group flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                        picked
                          ? "border-[var(--color-accent)] bg-[var(--color-accent-dim)]"
                          : "border-[var(--color-edge)] hover:bg-[var(--color-surface-hover)]"
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border ${
                          q.multiSelect ? "rounded" : "rounded-full"
                        } ${
                          picked
                            ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                            : "border-[var(--color-edge)] text-transparent group-hover:border-[var(--color-ink-dim)]"
                        }`}
                      >
                        {picked && <CheckIcon className="h-3 w-3" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {/* select-text so the user can copy the answer to search it */}
                          <span className="select-text text-left text-[13px] font-medium text-[var(--color-ink)]">
                            {cleanLabel}
                          </span>
                          {recommended && (
                            <span className="rounded-full bg-[var(--color-accent-dim)] px-1.5 py-px text-[10px] font-semibold text-[var(--color-accent)]">
                              {t("Recommended")}
                            </span>
                          )}
                        </div>
                        {opt.description && (
                          <div className="mt-0.5 select-text whitespace-pre-wrap break-words text-[12px] leading-snug text-[var(--color-ink-dim)]">
                            {opt.description}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <input
                value={freeText[q.id] ?? ""}
                onChange={(e) => setFreeText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                onKeyDown={(e) => {
                  // IME composition (Chinese/Japanese input) uses Enter to
                  // commit a candidate; that must not submit the answer.
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") submit();
                }}
                placeholder={t("or type an answer")}
                className="cp-input mt-2 w-full"
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--color-edge-subtle)] px-3 py-2">
        <button type="button" onClick={() => onAnswer({})} title="Sending no answers is treated as 'not approved'" className="cp-btn-ghost">
          {t("Skip")}
        </button>
        <button type="button" onClick={submit} className="cp-btn-primary">
          {t("Answer")}
        </button>
      </div>
    </div>
  );
}