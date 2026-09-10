// Doom-loop detection (opencode-style): when the agent calls the same tool
// with the same input repeatedly without making progress, we surface a
// warning and (after a threshold) inject a steering message telling the
// model it's stuck.
//
// opencode triggers after 3 identical calls. We do the same, but:
//   - We track per-(tool, serialized-input) call counts within a single
//     agent run (not across runs / sessions).
//   - On the 3rd identical call we inject a tool-result warning.
//   - On the 5th identical call we refuse the tool call entirely and tell
//     the model to change approach.
//
// The detector is intentionally simple and cheap: a Map of call signatures
// to counts. It does NOT try to detect semantic loops (e.g. editing a file
// then reverting) — only exact-input repetition, which is the common
// failure mode when a tool keeps erroring and the model keeps retrying
// with the same arguments.

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

const WARN_THRESHOLD = 3;
const REFUSE_THRESHOLD = 5;

export class DoomLoopDetector {
  private counts = new Map<string, number>();

  /** Record a tool call and return whether it should be warned/refused. */
  check(toolName: string, input: unknown): DoomLoopCheck {
    const sig = signature(toolName, input);
    const count = (this.counts.get(sig) ?? 0) + 1;
    this.counts.set(sig, count);

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

  /** Reset all counters (e.g. at the start of a new run). */
  reset(): void {
    this.counts.clear();
  }
}
