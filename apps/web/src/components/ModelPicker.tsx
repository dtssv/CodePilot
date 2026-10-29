import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Codepilot } from "../state/useCodepilot.js";
import type { SelectableModelInfo } from "../protocol/client.js";
import { describeError } from "../protocol/client.js";
import { loadReasoningEffort, saveReasoningEffort } from "../prefs.js";
import {
  reasoningEffortChoicesForModel,
  reasoningEffortFromChoice,
  reasoningEffortToChoice,
  type ReasoningEffort,
  type ReasoningEffortChoice,
} from "../reasoningEffort.js";
import { t } from "../i18n.js";
import { ChevronIcon } from "./Icons.js";

type MenuPos = { left: number; bottom: number; width: number };

function effortLabel(choice: ReasoningEffortChoice): string {
  if (choice === "off") return t("Think off");
  if (choice === "low") return t("Think low");
  if (choice === "medium") return t("Think medium");
  return t("Think high");
}

function providerKind(label: string, providerId: string): string | undefined {
  const s = `${label} ${providerId}`.toLowerCase();
  if (s.includes("anthropic") || s.includes("claude")) return "anthropic";
  if (s.includes("openai") || s.includes("copilot")) return "openai";
  if (s.includes("gemini") || s.includes("google")) return "gemini";
  return undefined;
}

/** Composer-adjacent picker: models grouped by provider + per-model thinking effort. */
export function ModelPicker({ cp }: { cp: Codepilot }): React.ReactElement | null {
  const { state, client } = cp;
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<SelectableModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [effortByKey, setEffortByKey] = useState<Record<string, ReasoningEffortChoice>>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const modelKey = (m: SelectableModelInfo): string => `${m.providerId}::${m.model}`;

  const refresh = useCallback(async () => {
    if (state.connection !== "connected") return;
    setLoading(true);
    setLoadError(null);
    try {
      const snap = await client.getConfig(state.cwd || undefined);
      const list = snap.selectableModels.filter((m) => m.kind === "chat");
      setModels(list);
      const next: Record<string, ReasoningEffortChoice> = {};
      for (const m of list) {
        const choices = reasoningEffortChoicesForModel(
          m.model,
          providerKind(m.providerLabel, m.providerId),
        );
        if (choices.length === 0) continue;
        const saved = loadReasoningEffort(m.model, m.providerId);
        const choice = reasoningEffortToChoice(saved);
        next[modelKey(m)] = choices.includes(choice) ? choice : choices[0]!;
      }
      setEffortByKey(next);
    } catch (err) {
      setModels([]);
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [client, state.connection, state.cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const updatePos = useCallback((): void => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Constrain the menu to the composer's width so it never spills past the
    // input box into a right-side panel. Fall back to the viewport.
    const bounds = el.closest("[data-cp-composer]")?.getBoundingClientRect();
    const leftEdge = bounds ? bounds.left : 8;
    const rightEdge = bounds ? bounds.right : window.innerWidth - 8;
    const avail = Math.max(200, rightEdge - leftEdge);
    const width = Math.min(Math.max(r.width, 320), avail);
    // Prefer aligning to the button's left, but keep the whole menu inside the
    // composer's right edge.
    const left = Math.min(Math.max(r.left, leftEdge), rightEdge - width);
    setPos({
      left,
      bottom: window.innerHeight - r.top + 6,
      width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePos();
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    // Re-measure when the composer reflows for reasons other than a window
    // resize — e.g. a right-side panel expanding/collapsing shrinks the
    // composer without firing `resize`. A ResizeObserver on the composer (and
    // the button) keeps the menu pinned inside the shrunken input box.
    const composer = btnRef.current?.closest("[data-cp-composer]") ?? null;
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => updatePos()) : null;
    if (ro) {
      if (composer) ro.observe(composer);
      if (btnRef.current) ro.observe(btnRef.current);
    }
    return () => {
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
      ro?.disconnect();
    };
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; items: SelectableModelInfo[] }>();
    for (const m of models) {
      let g = map.get(m.providerId);
      if (!g) {
        g = { label: m.providerLabel, items: [] };
        map.set(m.providerId, g);
      }
      g.items.push(m);
    }
    return [...map.entries()];
  }, [models]);

  if (state.connection !== "connected") return null;

  const activeChoices = state.model
    ? reasoningEffortChoicesForModel(
        state.model,
        providerKind(
          models.find((m) => m.model === state.model && m.providerId === state.providerId)
            ?.providerLabel ?? "",
          state.providerId ?? "",
        ),
      )
    : [];
  const activeEffort = state.model
    ? effortByKey[`${state.providerId ?? "_"}::${state.model}`] ??
      reasoningEffortToChoice(loadReasoningEffort(state.model, state.providerId))
    : "off";

  const label = state.model
    ? `${state.providerId ? `${state.providerId} · ` : ""}${state.model}${
        activeChoices.length > 0 ? ` · ${effortLabel(activeEffort)}` : ""
      }`
    : t("Select model");

  const apply = async (
    m: SelectableModelInfo,
    choice: ReasoningEffortChoice | undefined,
  ): Promise<void> => {
    setOpen(false);
    const choices = reasoningEffortChoicesForModel(
      m.model,
      providerKind(m.providerLabel, m.providerId),
    );
    let effort: ReasoningEffort | null | undefined;
    if (choices.length > 0) {
      const picked = choice ?? effortByKey[modelKey(m)] ?? choices[0]!;
      effort = reasoningEffortFromChoice(picked) ?? null;
      saveReasoningEffort(m.model, m.providerId, effort ?? undefined);
      setEffortByKey((prev) => ({ ...prev, [modelKey(m)]: picked }));
    }
    try {
      await cp.setModel(m.model, m.providerId, effort);
    } catch (err) {
      cp.notify(describeError(err));
    }
  };

  const menu =
    open &&
    pos &&
    createPortal(
      <div
        ref={menuRef}
        role="listbox"
        className="fixed z-[200] max-h-80 overflow-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] py-1 shadow-lg"
        style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}
      >
        {loading && models.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-[var(--color-ink-faint)]">{t("Loading…")}</div>
        )}
        {!loading && models.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-[var(--color-ink-faint)]">
            {loadError
              ? `${t("Couldn’t load models")}: ${loadError}`
              : t("No models configured. Open Settings to add a provider.")}
          </div>
        )}
        {groups.map(([providerId, g]) => (
          <div key={providerId} className="mb-1">
            <div className="cp-eyebrow px-3 pt-2 pb-1">{g.label}</div>
            {g.items.map((m) => {
              const active =
                m.model === state.model &&
                (!state.providerId || m.providerId === state.providerId);
              const choices = reasoningEffortChoicesForModel(
                m.model,
                providerKind(g.label, m.providerId),
              );
              const effort = effortByKey[modelKey(m)] ?? choices[0] ?? "off";
              return (
                <div
                  key={m.id}
                  className={`px-2 py-1 ${
                    active ? "bg-[var(--color-accent-dim)]" : "hover:bg-[var(--color-surface-hover)]"
                  }`}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className="flex w-full px-1 py-1 text-left font-mono text-[12px] text-[var(--color-ink)]"
                    onClick={() => void apply(m, choices.length > 0 ? effort : undefined)}
                  >
                    {m.model}
                  </button>
                  {choices.length > 0 && (
                    <div className="mb-1 flex flex-wrap items-center gap-1 px-1">
                      <span className="mr-0.5 text-[10px] text-[var(--color-ink-faint)]">
                        {t("Thinking intensity")}
                      </span>
                      {choices.map((c) => {
                        const on = effort === c;
                        return (
                          <button
                            key={c}
                            type="button"
                            className={`rounded px-1.5 py-0.5 text-[10.5px] ${
                              on
                                ? "bg-[var(--color-accent)] text-white"
                                : "bg-[var(--color-surface)] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-edge-subtle)] hover:text-[var(--color-ink)]"
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEffortByKey((prev) => ({ ...prev, [modelKey(m)]: c }));
                              void apply(m, c);
                            }}
                          >
                            {effortLabel(c)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>,
      document.body,
    );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left font-mono text-[11px] text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
        onClick={() => setOpen((v) => !v)}
        title={t("Switch model")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronIcon open={open} className="h-3 w-3 shrink-0 opacity-60" />
      </button>
      {menu}
    </>
  );
}
