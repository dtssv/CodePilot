/**
 * First-class sidebar nav: Skills · Connectors, Schedule, Remote.
 * Desktop / agent: full rows under New. Embed: header overflow menu only.
 * Plugins stay under Settings.
 */
import { useEffect, useRef, useState } from "react";

import { t } from "../i18n.js";
import { openFeature } from "./FeatureDialog.js";
import { BookIcon, ClockIcon, MoreHorizontalIcon, UsersIcon } from "./Icons.js";

export type FeatureEntry = {
  id: "hub" | "schedule" | "remote";
  label: string;
  Icon: (p: { className?: string }) => React.ReactElement;
  run: () => void;
};

export const FEATURE_ENTRIES: readonly FeatureEntry[] = [
  {
    id: "hub",
    label: "Skills · Connectors",
    Icon: BookIcon,
    run: () => openFeature("skills"),
  },
  {
    id: "schedule",
    label: "Schedule",
    Icon: ClockIcon,
    run: () => openFeature("schedule"),
  },
  {
    id: "remote",
    label: "Remote",
    Icon: UsersIcon,
    run: () => openFeature("remote"),
  },
];

/** Match WorkspaceSessionNav secondary rows (`Open workspace…`). */
const ROW =
  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-40";

export function FeatureMenu({ disabled }: { disabled?: boolean }): React.ReactElement {
  return (
    <div className="space-y-0.5 px-2 pb-2">
      {FEATURE_ENTRIES.map(({ id, label, Icon, run }) => (
        <button
          key={id}
          type="button"
          className={ROW}
          disabled={disabled}
          title={t(label)}
          onClick={run}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t(label)}</span>
        </button>
      ))}
    </div>
  );
}

/** Compact header control for the IDE embed: opens FEATURE_ENTRIES in a menu. */
export function FeatureOverflowMenu({ disabled }: { disabled?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current?.contains(e.target as Node)) return;
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
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="cp-icon-btn"
        disabled={disabled}
        title={t("More")}
        aria-label={t("More")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontalIcon className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-[60] mt-1 min-w-[11.5rem] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] py-1 shadow-lg"
        >
          {FEATURE_ENTRIES.map(({ id, label, Icon, run }) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)]"
              onClick={() => {
                setOpen(false);
                run();
              }}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--color-ink-dim)]" />
              <span className="truncate">{t(label)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
