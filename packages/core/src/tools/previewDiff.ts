/**
 * Compact before/after preview for permission cards. Not a full Myers diff —
 * finds the first/last changed lines and prints a bounded +/- window so the
 * user sees what will land on disk, not just the model's search/replace strings.
 */

const DEFAULT_MAX = 80;

/** Format a short unified-style preview of `before` → `after`. */
export function previewTextDiff(
  path: string,
  before: string,
  after: string,
  maxLines = DEFAULT_MAX,
): string {
  if (before === after) return `${path}\n(no changes)`;
  const a = before.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const ctx = 2;
  const fromA = Math.max(0, start - ctx);
  const toA = Math.min(a.length - 1, endA + ctx);
  const fromB = Math.max(0, start - ctx);
  const toB = Math.min(b.length - 1, endB + ctx);

  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`, `@@ -${fromA + 1},${Math.max(0, toA - fromA + 1)} +${fromB + 1},${Math.max(0, toB - fromB + 1)} @@`];
  // Emit a simple interleaved window: context from before, then removals, then additions.
  for (let i = fromA; i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i <= endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+${b[i]}`);
  for (let i = endA + 1; i <= toA; i++) lines.push(` ${a[i]}`);

  if (lines.length - 3 > maxLines) {
    const head = lines.slice(0, 3 + Math.floor(maxLines * 0.7));
    const tail = lines.slice(-(Math.floor(maxLines * 0.3)));
    return [...head, `… (${lines.length - 3 - maxLines} more lines) …`, ...tail].join("\n");
  }
  return lines.join("\n");
}
