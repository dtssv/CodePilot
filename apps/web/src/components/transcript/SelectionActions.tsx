import { useCallback, useEffect, useState } from "react";

import { t } from "../../i18n.js";
import { CopyIcon } from "../Icons.js";
import { ContextMenu, openContextMenu, type ContextMenuState } from "../ContextMenu.js";

/**
 * Selection actions inside the transcript:
 * - floating bar on mouse-up selection (Copy / Add to chat)
 * - right-click menu on selection (Copy / Add to chat / Select all)
 */
export function SelectionActions({
  rootRef,
  onAddToChat,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  onAddToChat?(text: string): void;
}): React.ReactElement | null {
  const [bar, setBar] = useState<{ x: number; y: number; text: string } | null>(null);
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);
  const closeCtx = useCallback(() => setCtx(null), []);

  const selectedInRoot = useCallback((): string => {
    const root = rootRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return "";
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return "";
    return sel.toString().trim();
  }, [rootRef]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onMouseUp = (): void => {
      // Defer so the selection is finalized after the click.
      requestAnimationFrame(() => {
        const text = selectedInRoot();
        if (!text) {
          setBar(null);
          return;
        }
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) {
          setBar(null);
          return;
        }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          setBar(null);
          return;
        }
        setBar({
          x: rect.left + rect.width / 2,
          y: Math.max(8, rect.top - 8),
          text,
        });
      });
    };

    const onContextMenu = (e: MouseEvent): void => {
      const text = selectedInRoot();
      if (!text) return;
      e.preventDefault();
      setBar(null);
      openContextMenu(
        e,
        [
          {
            id: "copy",
            label: t("Copy"),
            onSelect: () => {
              void navigator.clipboard?.writeText(text);
            },
          },
          ...(onAddToChat
            ? [
                {
                  id: "add",
                  label: t("Add to chat"),
                  onSelect: () => onAddToChat(text),
                },
              ]
            : []),
          {
            id: "select-all",
            label: t("Select all"),
            onSelect: () => {
              const range = document.createRange();
              range.selectNodeContents(root);
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
            },
          },
        ],
        setCtx,
      );
    };

    const onScroll = (): void => setBar(null);

    root.addEventListener("mouseup", onMouseUp);
    root.addEventListener("contextmenu", onContextMenu);
    root.addEventListener("scroll", onScroll, true);
    return () => {
      root.removeEventListener("mouseup", onMouseUp);
      root.removeEventListener("contextmenu", onContextMenu);
      root.removeEventListener("scroll", onScroll, true);
    };
  }, [rootRef, selectedInRoot, onAddToChat]);

  return (
    <>
      {bar && (
        <div
          className="fixed z-[70] flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface-raised)] px-1 py-0.5 shadow-lg"
          style={{ left: bar.x, top: bar.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)]"
            onClick={() => {
              void navigator.clipboard?.writeText(bar.text);
              setBar(null);
            }}
          >
            <CopyIcon className="h-3 w-3" />
            {t("Copy")}
          </button>
          {onAddToChat && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)]"
              onClick={() => {
                onAddToChat(bar.text);
                setBar(null);
              }}
            >
              {t("Add to chat")}
            </button>
          )}
        </div>
      )}
      <ContextMenu menu={ctx} onClose={closeCtx} />
    </>
  );
}
