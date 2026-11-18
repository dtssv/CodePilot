/**
 * The footer injected into the sub-agent's user message. Reinforces the
 * role boundary right before the model starts reasoning.
 */
/** Field-level conclusion shape — once in the first user message (not re-paid in system every turn). */
export const SUBAGENT_OBJECTIVE_FOOTER = `This is your only task. When met or blocked, stop tools and emit ONE final assistant message (no preamble):

### Findings
  - <bullet with file:line>

### Verification
  - check: <command or "n/a">
  - exit: <code or "n/a">
  - result: pass|fail|skipped
  (Diagnostic / Q&A: check n/a, result skipped — do not invent builds.)

### Key references
  - \`path/to/file.ts:42\` — one-line purpose

### Recommendations
  - <next step for the parent, or "none">

Or replace all of the above with:
### Blocker
  - kind: permission|missing_context|dependency|external|rate_limit|timeout|not_found|other
  - need: <exactly one input or approval the parent/user must supply — not a command for you>
  - reason: <one sentence>
  (sandbox/network deny → permission; need parent/user fact → missing_context; missing tool/command-not-found → dependency; outage → external.)

Do not wait for another turn. Do not produce any other output.`;

/** Plan conclusion field shape — once in the first user message. */
export const SUBAGENT_PLAN_FOOTER = `This is your only task. Investigate (read-only), then stop tools and emit ONE final plan (no preamble, do not claim edits):

### Plan
  - <ordered concrete steps>

### Critical files
  - \`path/to/file.ts:42\` — why it matters

### Risks
  - <edge cases>

### Open questions
  - <decisions for the parent, or "none">

Or ### Blocker with kind / exactly one need (parent-or-user input|approval, not your command) / reason.

Do not wait for another turn.`;

/** Default token cap on an inherited (`context: "fork"`) parent history. Keeps
 * the fork seed from blowing the sub-agent's own budget; the older turns are
 * folded/trimmed to fit. Overridable per call via `fork_max_tokens`. */
export const DEFAULT_FORK_MAX_TOKENS = 24_000;

/** Prefix message that precedes a forked parent history, so the sub-agent reads
 * it as inherited context rather than its own prior work. */
export const FORK_CONTEXT_MARKER = `The messages below are inherited context from the parent conversation that delegated this task — files it has already read, decisions it has made, and tool output it has seen. Use them as background. Do NOT continue the parent's work or address its user; your only task is the task message that follows this inherited block.`;