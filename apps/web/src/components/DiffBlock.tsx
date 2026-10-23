import type { DiffLine, FileChange } from "../state/diff.js";

const LINE_STYLES: Record<DiffLine["kind"], string> = {
  add: "bg-[var(--color-add-dim)] text-[var(--color-add)]",
  remove:
    "bg-[var(--color-remove-dim)] text-[var(--color-remove)]",
  context: "text-[var(--color-ink-dim)]",
  meta: "text-[var(--color-ink-faint)] italic",
};

const PREFIX: Record<DiffLine["kind"], string> = {
  add: "+",
  remove: "-",
  context: " ",
  meta: "",
};

/**
 * Renders what a file-mutating tool call intends to change. Not a computed
 * diff — for `edit_file` these are the exact search/replace texts the agent
 * submitted, which is what a reviewer needs to see before approving.
 */
export function DiffBlock({
  change,
  onOpenPath,
}: {
  change: FileChange;
  onOpenPath?: (path: string) => void;
}): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-edge-subtle)]">
      <div className="flex items-center gap-2 bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs">
        {onOpenPath ? (
          <button
            type="button"
            className="font-mono text-[var(--color-accent)] underline-offset-2 hover:underline"
            title={change.path}
            onClick={() => onOpenPath(change.path)}
          >
            {change.path}
          </button>
        ) : (
          <span className="font-mono text-[var(--color-ink)]">{change.path}</span>
        )}
        <span className="rounded border border-[var(--color-edge-subtle)] px-1 text-[9px] uppercase tracking-wider text-[var(--color-ink-faint)]">{change.operation}</span>
        <div className="ml-auto flex gap-1.5 font-mono">
          {change.added > 0 && (
            <span className="text-[var(--color-add)]">+{change.added}</span>
          )}
          {change.removed > 0 && (
            <span className="text-[var(--color-remove)]">−{change.removed}</span>
          )}
        </div>
        {change.truncated && (
          <span className="text-[var(--color-ink-faint)]">(truncated)</span>
        )}
      </div>
      {change.hunks.length === 0 ? (
        <div className="px-3 py-2 text-xs text-[var(--color-ink-dim)]">
          This tool's payload is not rendered as a diff; see the raw input below.
        </div>
      ) : (
        change.hunks.map((hunk, hi) => (
          <div key={hi} className="border-t border-[var(--color-edge)] first:border-t-0">
            {hunk.label && (
              <div className="bg-[var(--color-surface-sunken)] px-3 py-1 text-[11px] text-[var(--color-ink-dim)]">
                {hunk.label}
              </div>
            )}
            <pre className="max-h-80 overflow-auto px-0 py-1 text-[11.5px] leading-5">
              {hunk.lines.map((line, li) => (
                <div key={li} className={`px-3 ${LINE_STYLES[line.kind]}`}>
                  <span className="select-none opacity-60">{PREFIX[line.kind]}</span>
                  {line.text === "" ? "\u00a0" : line.text}
                </div>
              ))}
            </pre>
          </div>
        ))
      )}
    </div>
  );
}
