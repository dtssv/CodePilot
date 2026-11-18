import { useMemo } from "react";
import type { Codepilot } from "../state/useCodepilot.js";

export function EmbeddedFiles({ cp, onOpenFile }: { cp: Codepilot; onOpenFile(path: string): void }): React.ReactElement | null {
  const files = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of cp.state.rows) {
      if (r.kind === "tool" && r.tool.change && r.tool.status === "ok" && !seen.has(r.tool.change.path)) {
        seen.add(r.tool.change.path);
        out.push(r.tool.change.path);
      }
    }
    return out;
  }, [cp.state.rows]);
  if (files.length === 0 || cp.state.status !== "idle") return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {files.map((f) => (
        <button key={f} type="button" className="cp-chip hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]" onClick={() => onOpenFile(f)} title={f}>
          {f.split("/").pop()}
        </button>
      ))}
    </div>
  );
}
