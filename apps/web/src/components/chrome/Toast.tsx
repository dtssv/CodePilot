import { useEffect } from "react";

/** Self-dismissing toast for `state.notice`. */
export function Toast({ text, onDone }: { text?: string; onDone(): void }): React.ReactElement | null {
  useEffect(() => {
    if (!text) return;
    const id = setTimeout(onDone, 4500);
    return () => clearTimeout(id);
  }, [text, onDone]);
  if (!text) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto max-w-lg animate-fade-in truncate rounded-full border border-[var(--color-edge)] bg-[var(--color-surface-raised)] px-4 py-1.5 text-[12px] text-[var(--color-ink-dim)] shadow-lg"
        title={text}
      >
        {text}
      </div>
    </div>
  );
}