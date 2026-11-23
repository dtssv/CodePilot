import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect(): void;
  /** Optional leading glyph (emoji/symbol or React node rendered as-is). */
  icon?: React.ReactNode;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** Floating context menu anchored at the click point. */
export function ContextMenu({
  menu,
  onClose,
}: {
  menu: ContextMenuState | null;
  onClose(): void;
}): React.ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [menu, onClose]);

  if (!menu || menu.items.length === 0) return null;

  const maxX = typeof window !== "undefined" ? window.innerWidth - 8 : menu.x;
  const maxY = typeof window !== "undefined" ? window.innerHeight - 8 : menu.y;
  const left = Math.max(8, Math.min(menu.x, maxX - 180));
  const top = Math.max(8, Math.min(menu.y, maxY - 40 * menu.items.length));

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[80] min-w-[160px] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] py-1 shadow-lg"
      style={{ left, top }}
    >
      {menu.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${
            item.disabled
              ? "cursor-default text-[var(--color-ink-faint)]"
              : item.danger
                ? "text-[var(--color-danger,#e5484d)] hover:bg-[var(--color-surface-hover)]"
                : "text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)]"
          }`}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
        >
          {item.icon ? <span className="w-4 shrink-0 text-[var(--color-ink-dim)]">{item.icon}</span> : null}
          <span className="min-w-0 flex-1">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export function openContextMenu(
  e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
  items: ContextMenuItem[],
  setMenu: (m: ContextMenuState | null) => void,
): void {
  e.preventDefault();
  e.stopPropagation();
  setMenu({ x: e.clientX, y: e.clientY, items });
}
