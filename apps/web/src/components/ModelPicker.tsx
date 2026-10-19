import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Codepilot } from "../state/useCodepilot.js";
import type { SelectableModelInfo } from "../protocol/client.js";
import { describeError } from "../protocol/client.js";
import { t } from "../i18n.js";
import { ChevronIcon } from "./Icons.js";

type MenuPos = { left: number; bottom: number; width: number };

/** Composer-adjacent picker: models grouped by provider. */
export function ModelPicker({ cp }: { cp: Codepilot }): React.ReactElement | null {
  const { state, client } = cp;
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<SelectableModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (state.connection !== "connected") return;
    setLoading(true);
    try {
      const snap = await client.getConfig(state.cwd || undefined);
      setModels(snap.selectableModels.filter((m) => m.kind === "chat"));
    } catch {
      setModels([]);
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
    setPos({
      left: Math.min(r.left, window.innerWidth - 320),
      bottom: window.innerHeight - r.top + 6,
      width: Math.max(r.width, 280),
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
    return () => {
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
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
 // Defer so the opening click does not immediately close the portal menu.
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

  const label = state.model
    ? state.providerId
      ? `${state.providerId} · ${state.model}`
      : state.model
    : t("Select model");

  const select = async (m: SelectableModelInfo): Promise<void> => {
    setOpen(false);
    try {
      await cp.setModel(m.model, m.providerId);
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
        className="fixed z-[200] max-h-72 overflow-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] py-1 shadow-lg"
        style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}
      >
        {loading && models.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-[var(--color-ink-faint)]">{t("Loading…")}</div>
        )}
        {!loading && models.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-[var(--color-ink-faint)]">
            {t("No models configured. Open Settings to add a provider.")}
          </div>
        )}
        {groups.map(([providerId, g]) => (
          <div key={providerId} className="mb-1">
            <div className="cp-eyebrow px-3 pt-2 pb-1">{g.label}</div>
            {g.items.map((m) => {
              const active =
                m.model === state.model &&
                (!state.providerId || m.providerId === state.providerId);
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`flex w-full px-3 py-1.5 text-left font-mono text-[12px] transition-colors hover:bg-[var(--color-surface-hover)] ${
                    active
                      ? "bg-[var(--color-accent-dim)] text-[var(--color-ink)]"
                      : "text-[var(--color-ink)]"
                  }`}
                  onClick={() => void select(m)}
                >
                  {m.model}
                </button>
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
        className="flex max-w-[260px] items-center gap-1 rounded-md px-1.5 py-0.5 text-left font-mono text-[11px] text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
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
