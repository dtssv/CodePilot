// Per-turn tool-result character budget. Individual tools already spill large
// bodies; this caps the *sum* of inline results in one assistant turn so a fan
// of greps/reads cannot blow the next provider request.

/** Soft ceiling on total tool_result chars returned in one turn. */
export const MAX_TOOL_RESULT_CHARS_PER_MESSAGE = 200_000;

const INLINE_HEAD = 4_000;
const INLINE_TAIL = 1_000;

export interface BudgetedToolResult {
  content: string;
  artifactRef?: string;
  name: string;
}

/**
 * While the sum of inline `content` exceeds `budget`, shrink the largest
 * result to a head+tail stub (writing an artifact when missing). Stops when
 * every result is already at the minimum stub size.
 */
export async function enforceToolResultBudget(
  items: BudgetedToolResult[],
  writeArtifact: (text: string, hint: string) => Promise<string>,
  budget = MAX_TOOL_RESULT_CHARS_PER_MESSAGE,
): Promise<BudgetedToolResult[]> {
  const out = items.map((i) => ({ ...i }));
  const minStub = INLINE_HEAD + INLINE_TAIL + 240;
  const total = (): number => out.reduce((s, i) => s + i.content.length, 0);

  while (total() > budget) {
    let best = -1;
    let bestLen = 0;
    for (let i = 0; i < out.length; i++) {
      const len = out[i]!.content.length;
      if (len > bestLen && len > minStub) {
        best = i;
        bestLen = len;
      }
    }
    if (best < 0) break;

    const item = out[best]!;
    let ref = item.artifactRef;
    if (!ref) {
      try {
        ref = await writeArtifact(item.content, `tool_result_budget:${item.name}`);
      } catch {
        // Still shrink inline even if artifact write fails.
      }
    }
    const omitted = Math.max(0, item.content.length - INLINE_HEAD - INLINE_TAIL);
    const marker = ref
      ? `[... ${omitted.toLocaleString()} chars omitted; turn tool-result budget ` +
        `${budget.toLocaleString()} chars; full output in artifact ${ref} — use read_artifact ...]`
      : `[... ${omitted.toLocaleString()} chars omitted; turn tool-result budget ` +
        `${budget.toLocaleString()} chars ...]`;
    item.content =
      item.content.slice(0, INLINE_HEAD) +
      `\n\n${marker}\n\n` +
      item.content.slice(item.content.length - INLINE_TAIL);
    if (ref) item.artifactRef = ref;
  }
  return out;
}
