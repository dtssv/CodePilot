// Doom-loop detection (opencode-style): when the agent calls the same tool
// with the same input repeatedly without making progress, we surface a
// warning and (after a threshold) inject a steering message telling the
// model it's stuck.
//
// Two layers of detection:
//
//  1. Per-signature counting (exact (tool, input) repetition):
//     - On the 3rd identical call we inject a tool-result warning.
//     - On the 4th identical call we refuse the tool call entirely.
//     (Was 3/5; lowered to 3/4 after a real run spun on `ls` of four
//     directories 4× each without ever tripping the old refuse threshold —
//     per-signature counting alone misses "rotating" loops where no single
//     input repeats enough but the same batch of calls does.)
//
//  2. Sequence-level detection (the rotating-loop case): we keep a sliding
//     window of recent call signatures and detect when the model re-issues
//     a whole batch of calls it already made. Concretely, if the last W
//     signatures contain ≥ K signatures that ALSO appeared in the W-window
//     immediately before them, the agent is re-walking ground it already
//     covered — we refuse. This catches the 4-×-4 ls loop that per-signature
//     counting could not.
//
// The detector is intentionally simple and cheap. It does NOT try to detect
// semantic loops (e.g. editing a file then reverting) — only exact-input and
// exact-sequence repetition, which are the common failure modes when a tool
// keeps erroring or a rate-limited provider makes the model "forget" it
// already explored something.

/** Signature of a single tool call: tool name + stable input hash. */
function signature(toolName: string, input: unknown): string {
  // Stable serialization: sort object keys so {a:1,b:2} === {b:2,a:1}.
  const stable = canonicalize(input);
  return `${toolName}::${stable}`;
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

export interface DoomLoopCheck {
  /** The number of times this exact (tool, input) has been called so far
   *  in this run, INCLUDING the current call. */
  count: number;
  /** True when we should refuse the call (model is clearly stuck). */
  refuse: boolean;
  /** True when we should warn but still execute. */
  warn: boolean;
  /** Human-readable message for the model. */
  message: string;
}

export const WARN_THRESHOLD = 3;
export const REFUSE_THRESHOLD = 4;

/** Sequence-loop detection window. We look at the last SEQ_WINDOW
 *  signatures (including the one being checked) and compare against the
 *  SEQ_WINDOW signatures immediately before them. If ≥ SEQ_REPEAT of the
 *  recent signatures already appeared in that prior window, the model is
 *  re-walking a batch of calls — a rotating loop. */
export const SEQ_WINDOW = 6;
export const SEQ_REPEAT = 4;

export class DoomLoopDetector {
  private counts = new Map<string, number>();
  /** Ordered list of call signatures across the whole run, for
   *  sequence-level (rotating) loop detection. */
  private seq: string[] = [];

  /** Thresholds exposed as static constants for callers that need to
   *  peek without incrementing (e.g. post-execution warn checks). */
  static readonly WARN_THRESHOLD = WARN_THRESHOLD;
  static readonly REFUSE_THRESHOLD = REFUSE_THRESHOLD;
  static readonly SEQ_WINDOW = SEQ_WINDOW;
  static readonly SEQ_REPEAT = SEQ_REPEAT;

  /** Record a tool call and return whether it should be warned/refused.
   *
   *  NOTE: this records the call (increments counts, appends to the
   *  sequence) BEFORE deciding, so a refused call still counts toward
   *  future detection. Callers that refuse must NOT execute the tool. */
  check(toolName: string, input: unknown): DoomLoopCheck {
    const sig = signature(toolName, input);
    const count = (this.counts.get(sig) ?? 0) + 1;
    this.counts.set(sig, count);
    this.seq.push(sig);

    // Layer 1: per-signature repetition.
    if (count >= REFUSE_THRESHOLD) {
      return {
        count,
        refuse: true,
        warn: false,
        message:
          `doom_loop: you've called ${toolName} with the exact same input ${count} times ` +
          `without making progress. This is almost certainly a loop — STOP and try a ` +
          `fundamentally different approach. Re-read the relevant files, check your ` +
          `assumptions, or ask the user for guidance.`,
      };
    }

    // Layer 2: sequence-level (rotating) loop. Compare the just-pushed
    // window of SEQ_WINDOW signatures against the SEQ_WINDOW signatures
    // immediately before it. If enough overlap, the model is re-walking a
    // batch of calls — refuse even if no single signature hit REFUSE.
    const seqHit = this.checkSequence();
    if (seqHit) {
      return {
        count,
        refuse: true,
        warn: false,
        message:
          `doom_loop: you're repeating a batch of tool calls you already made in the same ` +
          `form (${seqHit} recent calls match earlier ones). You are re-exploring the same ` +
          `ground without making progress. STOP re-calling tools you've already used with ` +
          `the same arguments — use the results you already have, move on to the next step ` +
          `of your plan, or summarize what you've learned so far.`,
      };
    }

    if (count >= WARN_THRESHOLD) {
      return {
        count,
        refuse: false,
        warn: true,
        message:
          `doom_loop warning: this is the ${count}rd time you're calling ${toolName} with ` +
          `identical input. If the previous calls didn't solve the problem, repeating ` +
          `them won't either. Consider a different approach.`,
      };
    }
    return { count, refuse: false, warn: false, message: "" };
  }

  /** Sequence-level rotating-loop check. Looks at the most recent
   *  SEQ_WINDOW signatures and counts how many also appear in the
   *  SEQ_WINDOW-window immediately preceding them. Returns the overlap
   *  count when it meets SEQ_REPEAT, else 0. */
  private checkSequence(): number {
    const w = SEQ_WINDOW;
    if (this.seq.length < w * 2) return 0;
    const recent = this.seq.slice(this.seq.length - w);
    const prior = this.seq.slice(this.seq.length - w * 2, this.seq.length - w);
    const priorSet = new Set(prior);
    let overlap = 0;
    for (const s of recent) if (priorSet.has(s)) overlap++;
    return overlap >= SEQ_REPEAT ? overlap : 0;
  }

  /** Return the current call count for a (tool, input) pair WITHOUT
   *  incrementing. Used by post-execution code that only needs to know
   *  whether to attach a warning, not to record a new call. */
  peekCount(toolName: string, input: unknown): number {
    const sig = signature(toolName, input);
    return this.counts.get(sig) ?? 0;
  }

  // -------------------------------------------------------------------------
  // Idempotent-call de-duplication cache
  // -------------------------------------------------------------------------

  /** Tools whose results are safe to replay when called again with identical
   *  input: they observe filesystem state the agent has not written to since.
   *  `bash` is deliberately excluded — a repeated command may observe changed
   *  state, and bash is where most genuine "retry because something changed"
   *  happens. */
  private dedupable = new Set(["ls", "glob", "grep", "read_file"]);
  private resultCache = new Map<string, { content: string; artifactRef?: string }>();

  /** True when this tool is eligible for result replay (idempotent read). */
  isDedupable(toolName: string): boolean {
    return this.dedupable.has(toolName);
  }

  /** Return a cached successful result for an identical prior call, if any.
   *  Only dedupable tools are cached, and only non-error results. */
  cachedResult(toolName: string, input: unknown): { content: string; artifactRef?: string } | undefined {
    if (!this.dedupable.has(toolName)) return undefined;
    return this.resultCache.get(signature(toolName, input));
  }

  /** Record a successful result so a future identical call can replay it. */
  recordResult(toolName: string, input: unknown, result: { content: string; artifactRef?: string; isError?: boolean }): void {
    if (!this.dedupable.has(toolName)) return;
    if (result.isError) return;
    this.resultCache.set(signature(toolName, input), {
      content: result.content,
      artifactRef: result.artifactRef,
    });
  }

  /** Reset all counters (e.g. at the start of a new run). */
  reset(): void {
    this.counts.clear();
    this.seq.length = 0;
    this.resultCache.clear();
  }
}
