import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { CodepilotClient, ContextReport } from "../protocol/client.js";
import type { AppState } from "../state/reducer.js";
import { formatTokens } from "../state/selectors.js";
import {
  contextFraction,
  contextSeverity,
  effectiveContextTokens,
  severityColor,
  type ContextSeverity,
} from "../state/context.js";
import { t } from "../i18n.js";

/** Human labels for the semantic context categories. */
const CATEGORY_LABELS: Record<string, string> = {
  system: "System prompt",
  skills: "Skills",
  tools: "Tool definitions",
  mcp: "MCP tools",
  conversation: "Conversation",
  lastMessage: "Current message",
  subagent: "Sub-agents",
};

/** Stable per-category tint so a category keeps the same colour across the
 * stacked bar and the legend. */
const CATEGORY_TINTS: Record<string, string> = {
  system: "var(--color-accent)",
  skills: "#8b5cf6",
  tools: "#0ea5e9",
  mcp: "#14b8a6",
  conversation: "#f59e0b",
  lastMessage: "#ec4899",
  subagent: "#64748b",
};

function tintFor(category: string): string {
  return CATEGORY_TINTS[category] ?? "var(--color-ink-faint)";
}

/** Small SVG ring showing the fraction of the context window in use. */
function Ring({
  fraction,
  color,
  size = 15,
}: {
  fraction: number;
  color: string;
  size?: number;
}): React.ReactElement {
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, fraction)) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--color-surface-sunken)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c - dash}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 500ms ease, stroke 300ms ease" }}
      />
    </svg>
  );
}

type MenuPos = { left: number; bottom: number; width: number };

const SEVERITY_TEXT: Record<ContextSeverity, string> = {
  ok: "var(--color-ink-dim)",
  warn: "var(--color-warn, #d98300)",
  critical: "var(--color-remove)",
};

/**
 * Cursor-style live context-window gauge for the composer footer: a compact
 * ring + percentage that is always visible, and opens a detailed per-category
 * breakdown popover on click. The report is pulled over the protocol and
 * refreshed whenever the transcript grows or a run settles, so the gauge tracks
 * usage in real time without a dedicated push channel.
 */
export function ContextGauge({
  client,
  sessionId,
  state,
}: {
  client: CodepilotClient;
  sessionId: string | undefined;
  state: AppState;
}): React.ReactElement | null {
  const [report, setReport] = useState<ContextReport | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Track the session the current `report` belongs to so we can drop a stale
  // report the instant the session changes, without flickering on in-session
  // refreshes (which share this effect via `refreshKey`).
  const reportSessionRef = useRef<string | undefined>(undefined);

  // Trigger-only key: refetch when the transcript grows or the run status
  // changes (a turn just settled → the new send cost is known).
  const refreshKey = `${state.rows.length}:${state.status}:${state.usage.input}`;

  useEffect(() => {
    if (!sessionId || state.connection !== "connected") {
      setReport(null);
      return;
    }
    // Clear the previous session's report the instant the session changes so
    // switching into (or creating) another session never shows the old
    // session's usage during the async fetch below. Guarded by the session ref
    // so ordinary in-session refreshes (same `sessionId`, new `refreshKey`)
    // don't blank the gauge and make it flicker.
    if (reportSessionRef.current !== sessionId) {
      reportSessionRef.current = sessionId;
      setReport(null);
    }
    let alive = true;
    client
      .sessionContextReport(sessionId)
      .then((r) => {
        if (alive) setReport(r);
      })
      .catch(() => {
        if (alive) setReport(null);
      });
    return () => {
      alive = false;
    };
    // refreshKey is the intentional trigger dependency.
  }, [client, sessionId, state.connection, refreshKey]);

  const updatePos = (): void => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const bounds = el.closest("[data-cp-composer]")?.getBoundingClientRect();
    const leftEdge = bounds ? bounds.left : 8;
    const rightEdge = bounds ? bounds.right : window.innerWidth - 8;
    const avail = Math.max(240, rightEdge - leftEdge);
    const width = Math.min(320, avail);
    const left = Math.min(Math.max(r.left, leftEdge), rightEdge - width);
    setPos({ left, bottom: window.innerHeight - r.top + 8, width });
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return;
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

  if (!sessionId || !report || report.window <= 0) return null;

  const frac = contextFraction(report);
  const pct = frac * 100;
  const used = effectiveContextTokens(report);
  const sev = contextSeverity(report);
  const ringColor = severityColor(sev);
  const cats = (report.byCategory ?? []).filter((c) => c.tokens > 0);
  const catTotal = cats.reduce((n, c) => n + c.tokens, 0);
  const estimated = !(report.providerInputTokens && report.providerInputTokens > 0);

  const menu =
    open &&
    pos &&
    createPortal(
      <div
        ref={menuRef}
        role="dialog"
        aria-label={t("Context window usage")}
        className="fixed z-[200] rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] p-3 shadow-lg"
        style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}
      >
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[12px] font-semibold text-[var(--color-ink)]">
            {t("Context window")}
          </span>
          <span className="tabular-nums text-[11px]" style={{ color: SEVERITY_TEXT[sev] }}>
            {pct.toFixed(1)}%
          </span>
        </div>

        <div className="mb-1 flex h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
          {cats.map((c) => {
            // Fill the bar up to the effective-total fraction of the window so
            // the stacked bar agrees with the ring/percent even when the ground
            // truth is the provider-reported input; each category keeps its
            // share of the category estimate.
            const widthPct =
              catTotal > 0 ? (c.tokens / catTotal) * frac * 100 : 0;
            return (
              <div
                key={c.category}
                title={`${t(CATEGORY_LABELS[c.category] ?? c.category)} · ${formatTokens(c.tokens)}`}
                style={{ width: `${widthPct}%`, background: tintFor(c.category) }}
              />
            );
          })}
        </div>
        <div className="mb-2.5 text-[11px] text-[var(--color-ink-faint)]">
          {formatTokens(used)} / {formatTokens(report.window)} {t("tokens")}
          {estimated ? ` · ${t("estimated")}` : ""}
          {report.autoCompactEnabled
            ? ` · ${t("auto-compact at")} ${(report.triggerFraction * 100).toFixed(0)}%`
            : ""}
        </div>

        <ul className="space-y-1">
          {cats.map((c) => {
            const share = catTotal > 0 ? (c.tokens / catTotal) * 100 : 0;
            return (
              <li key={c.category} className="flex items-center gap-2 text-[11px]">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: tintFor(c.category) }}
                />
                <span className="min-w-0 flex-1 truncate text-[var(--color-ink-dim)]">
                  {t(CATEGORY_LABELS[c.category] ?? c.category)}
                </span>
                <span className="shrink-0 tabular-nums text-[var(--color-ink-faint)]">
                  {share.toFixed(0)}% · {formatTokens(c.tokens)}
                </span>
              </li>
            );
          })}
        </ul>

        {report.duplicateReads.length > 0 && (
          <div className="mt-2.5 border-t border-[var(--color-edge-subtle)] pt-2 text-[10.5px] text-[var(--color-ink-faint)]">
            {t("Duplicate reads — consider /compact")}:
            <ul className="mt-1 space-y-0.5">
              {report.duplicateReads.slice(0, 3).map((d) => (
                <li key={d.path} className="truncate font-mono" title={d.path}>
                  {d.path} ({d.reads}×)
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>,
      document.body,
    );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`${t("Context window")}: ${pct.toFixed(1)}%`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 tabular-nums transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <Ring fraction={frac} color={ringColor} />
        <span className="text-[11px]" style={{ color: SEVERITY_TEXT[sev] }}>
          {pct.toFixed(0)}%
        </span>
      </button>
      {menu}
    </>
  );
}
