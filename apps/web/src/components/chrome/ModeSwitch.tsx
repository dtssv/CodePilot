import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AgentMode } from "@codepilot/core";

import { t } from "../../i18n.js";
import { ChevronIcon } from "../Icons.js";
import { modeHint, modeLabel } from "./mode.js";

/**
 * Mode picker. In compact (IDE sidebar) use the same dropdown pattern as
 * ModelPicker — never cycle-on-click. Wide layouts keep Ask/Plan/Agent chips.
 */
export function ModeSwitch({
  mode,
  modes,
  onMode,
  disabled,
  compact = false,
}: {
  mode: AgentMode;
  modes: AgentMode[];
  onMode(m: AgentMode): void;
  disabled?: boolean;
  /** Narrow IDE sidebar: dropdown like ModelPicker (pick the mode explicitly). */
  compact?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updatePos = useCallback((): void => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const bounds = el.closest("[data-cp-composer]")?.getBoundingClientRect();
    const leftEdge = bounds ? bounds.left : 8;
    const rightEdge = bounds ? bounds.right : window.innerWidth - 8;
    const avail = Math.max(160, rightEdge - leftEdge);
    const width = Math.min(Math.max(r.width, 200), avail);
    const left = Math.min(Math.max(r.left, leftEdge), rightEdge - width);
    setPos({ left, bottom: window.innerHeight - r.top + 6, width });
  }, []);

  useLayoutEffect(() => {
    if (!compact || !open) {
      setPos(null);
      return;
    }
    updatePos();
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
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
  }, [compact, open, updatePos]);

  useEffect(() => {
    if (!compact || !open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const timer = window.setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [compact, open]);

  if (!compact) {
    return (
      <div className="flex shrink-0 gap-0.5 rounded-lg bg-[var(--color-surface-sunken)] p-0.5">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onMode(m)}
            disabled={disabled}
            title={modeHint(m)}
            className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
              mode === m
                ? "bg-[var(--color-surface-raised)] text-[var(--color-ink)] shadow-sm"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            } disabled:cursor-not-allowed`}
          >
            {modeLabel(m)}
          </button>
        ))}
      </div>
    );
  }

  const menu =
    open &&
    pos &&
    createPortal(
      <div
        ref={menuRef}
        role="listbox"
        aria-label={t("Switch mode")}
        className="fixed z-[200] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] py-1 shadow-lg"
        style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}
      >
        {modes.map((m) => {
          const active = m === mode;
          return (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={active}
              disabled={disabled}
              title={modeHint(m)}
              className={`flex w-full flex-col px-3 py-2 text-left transition-colors ${
                active
                  ? "bg-[var(--color-accent-dim)] text-[var(--color-ink)]"
                  : "text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)]"
              } disabled:cursor-not-allowed`}
              onClick={() => {
                setOpen(false);
                onMode(m);
              }}
            >
              <span className="text-[12.5px] font-medium">{modeLabel(m)}</span>
              <span className="text-[10.5px] text-[var(--color-ink-faint)]">{modeHint(m)}</span>
            </button>
          );
        })}
      </div>,
      document.body,
    );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={modeHint(mode)}
        aria-label={t("Switch mode")}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex shrink-0 items-center gap-0.5 rounded-lg bg-[var(--color-surface-sunken)] px-2 py-1 text-[11.5px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed"
      >
        <span>{modeLabel(mode)}</span>
        <ChevronIcon open={open} className="h-3 w-3 shrink-0 opacity-60" />
      </button>
      {menu}
    </>
  );
}