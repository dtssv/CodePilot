import type { DiffLine, FileChange } from "../state/diff.js";

const LINE_STYLES: Record<DiffLine["kind"], string> = {
  add: "bg-[color-mix(in_oklch,var(--color-add)_14%,transparent)] text-[var(--color-add)]",
  remove:
    "bg-[color-mix(in_oklch,var(--color-remove)_14%,transparent)] text-[var(--color-remove)]",
  context: "text-[var(--color-ink-dim)]",
  meta: "text-[var(--color-ink-dim)] italic",
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
export function DiffBlock({ change }: { change: FileChange }): React.ReactElement {
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-[var(--color-edge)]">
      <div className="flex items-center gap-2 bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs">
        <span className="font-mono text-[var(--color-ink)]">{change.path}</span>
        <span className="text-[var(--color-ink-dim)]">{change.operation}</span>
        {change.added > 0 && (
          <span className="text-[var(--color-add)]">+{change.added}</span>
        )}
        {change.removed > 0 && (
          <span className="text-[var(--color-remove)]">−{change.removed}</span>
        )}
        {change.truncated && (
          <span className="text-[var(--color-ink-dim)]">(truncated)</span>
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
            <pre className="overflow-x-auto px-0 py-1 text-xs leading-5">
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
