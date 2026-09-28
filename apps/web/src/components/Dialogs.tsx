import { useState } from "react";

import type { PermissionDecision, QuestionAnswers } from "@codepilot/core";
import type { PendingPermission, PendingQuestion } from "../protocol/client.js";

function Backdrop({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] p-4 shadow-2xl">
        {children}
      </div>
    </div>
  );
}

/**
 * Tool-approval prompt. The command or path is shown verbatim and unwrapped:
 * approving a tool call you cannot fully read is the failure mode this dialog
 * exists to prevent, so nothing here is truncated.
 */
export function PermissionDialog({
  req,
  onDecide,
}: {
  req: PendingPermission;
  onDecide: (decision: PermissionDecision) => void;
}): React.ReactElement {
  return (
    <Backdrop>
      <div className="mb-1 text-sm text-[var(--color-ink-dim)]">Permission required</div>
      <div className="mb-3 font-mono text-sm text-[var(--color-ink)]">{req.toolName}</div>
      <div className="mb-3 text-xs text-[var(--color-ink-dim)]">{req.reason}</div>
      <pre className="mb-4 max-h-64 overflow-auto rounded-md bg-[var(--color-surface-sunken)] p-3 text-xs leading-5 whitespace-pre-wrap text-[var(--color-ink)]">
        {formatInput(req.input)}
      </pre>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => onDecide("deny")}
          className="rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-sunken)]"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => onDecide("allow")}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black"
        >
          Allow once
        </button>
        <button
          type="button"
          onClick={() => onDecide("always")}
          className="rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-sunken)]"
          title="Remember this command pattern for this session — other commands still ask"
        >
          Always allow
        </button>
      </div>
    </Backdrop>
  );
}

/** `ask_user_question` / `plan_done`: options with an "other" free-text path. */
export function QuestionDialog({
  req,
  onAnswer,
}: {
  req: PendingQuestion;
  onAnswer: (answers: QuestionAnswers) => void;
}): React.ReactElement {
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  const pick = (id: string, label: string, multi: boolean): void => {
    setAnswers((prev) => {
      if (!multi) return { ...prev, [id]: label };
      const current = prev[id];
      const list = Array.isArray(current) ? current : current ? [current] : [];
      return {
        ...prev,
        [id]: list.includes(label) ? list.filter((l) => l !== label) : [...list, label],
      };
    });
  };

  const isPicked = (id: string, label: string): boolean => {
    const v = answers[id];
    return Array.isArray(v) ? v.includes(label) : v === label;
  };

  const submit = (): void => {
    // Free text overrides the option pick for that question — the user typed
    // something specific because the options did not fit.
    const merged: QuestionAnswers = { ...answers };
    for (const [id, text] of Object.entries(freeText)) {
      if (text.trim() !== "") merged[id] = text.trim();
    }
    onAnswer(merged);
  };

  return (
    <Backdrop>
      <div className="mb-3 text-sm text-[var(--color-ink-dim)]">The agent is asking</div>
      <div className="max-h-[60vh] space-y-4 overflow-auto">
        {req.questions.map((q) => (
          <div key={q.id}>
            {q.header && (
              <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-dim)]">
                {q.header}
              </div>
            )}
            <div className="mb-2 text-sm text-[var(--color-ink)]">{q.question}</div>
            <div className="flex flex-wrap gap-2">
              {(q.options ?? []).map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => pick(q.id, opt.label, q.multiSelect === true)}
                  title={opt.description}
                  className={`rounded-md border px-2.5 py-1 text-sm ${
                    isPicked(q.id, opt.label)
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-ink)]"
                      : "border-[var(--color-edge)] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-sunken)]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <input
              value={freeText[q.id] ?? ""}
              onChange={(e) =>
                setFreeText((prev) => ({ ...prev, [q.id]: e.target.value }))
              }
              placeholder="or type an answer"
              className="mt-2 w-full rounded-md border border-[var(--color-edge)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onAnswer({})}
          className="rounded-md border border-[var(--color-edge)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-sunken)]"
          title="Sending no answers is treated as 'not approved'"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={submit}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black"
        >
          Answer
        </button>
      </div>
    </Backdrop>
  );
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null) {
    const o = input as Record<string, unknown>;
    // A bash command is the thing being approved; show it plainly rather than
    // buried in JSON quoting.
    if (typeof o.command === "string") return o.command;
  }
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}
