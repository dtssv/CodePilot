// Shared helpers for the context-window usage gauge (footer gauge + sidebar
// breakdown). Keeping the numerator/percent/colour logic in one place ensures
// the compact gauge and the detailed breakdown always agree.

import type { ContextReport } from "../protocol/client";

/**
 * Numerator the gauge displays: provider-reported prompt size if available
 * (ground truth), else the per-turn send estimate, else the event-log total.
 * Mirrors core's `usagePercent` in `Session.contextReport`.
 */
export function effectiveContextTokens(r: ContextReport): number {
  if (r.providerInputTokens && r.providerInputTokens > 0) return r.providerInputTokens;
  if (r.sentTokens && r.sentTokens > 0) return r.sentTokens;
  return r.totalTokens;
}

/** Fraction (0–1) of the window in use, based on the effective numerator. */
export function contextFraction(r: ContextReport): number {
  if (!r.window || r.window <= 0) return 0;
  return Math.min(1, effectiveContextTokens(r) / r.window);
}

export type ContextSeverity = "ok" | "warn" | "critical";

/**
 * Colour band for the gauge. Goes `warn` as usage approaches the compaction
 * trigger and `critical` at/after it, so the user sees pressure building before
 * an auto-compaction kicks in.
 */
export function contextSeverity(r: ContextReport): ContextSeverity {
  const used = effectiveContextTokens(r);
  const trigger = r.triggerThreshold > 0 ? r.triggerThreshold : r.window * 0.92;
  if (used >= trigger) return "critical";
  // Warn once within ~85% of the trigger point.
  if (used >= trigger * 0.85) return "warn";
  return "ok";
}

/** CSS variable for the gauge fill colour, by severity. */
export function severityColor(sev: ContextSeverity): string {
  switch (sev) {
    case "critical":
      return "var(--color-remove)";
    case "warn":
      return "var(--color-warn, #d98300)";
    default:
      return "var(--color-accent)";
  }
}
