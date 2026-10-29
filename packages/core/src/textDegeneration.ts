// Degeneration detectors for model output. Standalone (no agent/session deps)
// so both the sub-agent outcome assessment and the live streaming loop can use
// them without a circular import.

/**
 * Detect a collapsed output made of one short repeating unit (1–4 chars),
 * e.g. the `}`}` ×tens-of-thousands case. Returns the unit + the fraction of
 * the text it covers when that fraction is overwhelming, else null.
 */
export function detectDegenerateText(text: string): { unit: string; ratio: number } | null {
  const MIN_LEN = 400;
  if (text.length < MIN_LEN) return null;
  // Try short repeating units (1–4 chars). If one unit, tiled back-to-back,
  // covers most of the text, the output has collapsed.
  for (let unitLen = 1; unitLen <= 4; unitLen++) {
    const counts = new Map<string, number>();
    for (let i = 0; i + unitLen <= text.length; i += unitLen) {
      const u = text.slice(i, i + unitLen);
      counts.set(u, (counts.get(u) ?? 0) + 1);
    }
    let bestUnit = "";
    let bestCount = 0;
    for (const [u, c] of counts) {
      if (c > bestCount) {
        bestCount = c;
        bestUnit = u;
      }
    }
    // Fraction of the text covered by the single most frequent unit.
    const ratio = (bestCount * unitLen) / text.length;
    // A real sentence never has one 1–4 char unit covering >85% of it; a
    // collapse does. Require the unit to be non-whitespace so we don't flag
    // big indented blocks.
    if (ratio >= 0.85 && bestUnit.trim().length > 0) {
      return { unit: bestUnit, ratio };
    }
  }
  return null;
}

/**
 * Detect runaway PHRASE-level repetition in streaming text — the "I call xxx,
 * I execute xxx, I call xxx…" collapse where the model loops a whole clause
 * instead of a single character. `detectDegenerateText` only catches 1–4 char
 * units; this catches longer periodic tails.
 *
 * We examine the tail (most recent `windowChars`) and look for the smallest
 * period `p` (a repeating block up to `maxPeriod` chars) such that the tail is
 * ≥ `threshold` periodic. A healthy answer is not periodic; a loop is. Returns
 * the repeating unit + how many times it tiled, or null. Cheap: O(window ·
 * maxPeriod), meant to run only every few KB of output.
 */
export function detectRunawayRepetition(
  text: string,
  opts: { windowChars?: number; maxPeriod?: number; minRepeats?: number; threshold?: number } = {},
): { unit: string; repeats: number } | null {
  const windowChars = opts.windowChars ?? 2000;
  const maxPeriod = opts.maxPeriod ?? 120;
  const minRepeats = opts.minRepeats ?? 6;
  const threshold = opts.threshold ?? 0.9;
  if (text.length < Math.max(windowChars, maxPeriod * minRepeats)) return null;
  const tail = text.slice(-windowChars);
  const n = tail.length;
  // Try each candidate period; smallest convincing one wins.
  for (let p = 2; p <= maxPeriod; p++) {
    if (n / p < minRepeats) break; // too few repeats possible at this period
    let matches = 0;
    const comparable = n - p;
    for (let i = 0; i < comparable; i++) {
      if (tail[i] === tail[i + p]) matches++;
    }
    const periodicity = matches / comparable;
    if (periodicity >= threshold) {
      const unit = tail.slice(n - p);
      // Ignore near-empty / whitespace-only periods (indentation blocks).
      if (unit.trim().length === 0) continue;
      return { unit, repeats: Math.floor(n / p) };
    }
  }
  return null;
}
