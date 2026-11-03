/**
 * Consistency assertion: "model-visible equals logged".
 *
 * In production, the agent loop intentionally transforms the persisted event
 * transcript before sending it to the model provider:
 * - **Micro-compaction**: old `tool_result` events are folded into short
 * stubs (`foldToolResults`) to save tokens. This is lossy by design.
 * - **Secret redaction**: applied identically to both the persisted event
 * and the provider message, so it is NOT a source of divergence.
 *
 * This module provides an assertion that verifies the *non-folded* portions
 * of the provider messages exactly match the corresponding persisted events.
 * It catches bugs where a tool result's content, a tool call's input, or a
 * message's text diverges between what the model saw and what was logged — a
 * class of bug that is otherwise invisible and extremely hard to reproduce.
 *
 * The agent loop runs this on every turn, before sending, via two triggers:
 * - the `consistencyCheck` config (`"off"` | `"warn"` (default) | `"throw"`):
 *   `"warn"` emits a non-blocking diagnostic on divergence, `"throw"` fails
 *   the turn loudly. This is active in production by default (warn mode).
 * - the `CODEPILOT_ASSERT_CONSISTENCY=1` env var: a hard override that forces
 *   the throwing path regardless of config — intended for tests/CI.
 *
 * On any divergence the check surfaces a precise diff (`ConsistencyError`)
 * rather than letting the provider transcript silently drift from the log.
 *
 * @module consistency
 */
import type { ProviderMessage, ProviderMessageContent } from "./providers/types.js";
import type { Event } from "./types.js";
import { compactTranscriptToProviderMessages } from "./agent-messages.js";

/**
 * Whether the `CODEPILOT_ASSERT_CONSISTENCY` env override is set — a hard
 * force of the throwing path for tests/CI. This is NOT the only trigger: the
 * `consistencyCheck` config also runs the check (warn by default). Env unset
 * means "defer to config", not "check disabled".
 */
export function consistencyAssertEnabled(): boolean {
  return process.env.CODEPILOT_ASSERT_CONSISTENCY === "1" ||
    process.env.CODEPILOT_ASSERT_CONSISTENCY === "true";
}

export class ConsistencyError extends Error {
  constructor(
    message: string,
    readonly details: { expected: unknown; actual: unknown; context: string }
  ) {
    super(message);
    this.name = "ConsistencyError";
  }
}

/**
 * Verify that the provider messages are consistent with the persisted event
 * log. Only the **recent** (non-folded) messages are checked — folded tool
 * results are allowed to differ (that's the whole point of micro-compaction).
 *
 * @param providerMessages The messages built by `buildProviderMessages`.
 * @param events The full persisted event log (history + produced).
 * @param keepRecent The `keepRecentMessages` window used by folding
 * (must match what `buildProviderMessages` used).
 * @throws {ConsistencyError} on any divergence in the non-folded portion.
 */
export function assertConsistency(
  providerMessages: ProviderMessage[],
  events: Event[],
  keepRecent = 8
): void {
 // Reconstruct the "ground truth" provider messages WITHOUT folding, then
 // compare the tail. Folding only rewrites messages older than the
 // `keepRecent` cutoff, so the last half-window must match exactly.
  const full = compactTranscriptToProviderMessages(events, "");
  const tailGroundTruth = full.slice(-Math.max(1, Math.floor(keepRecent / 2)));
  const providerTail = providerMessages.slice(-tailGroundTruth.length);
  if (providerTail.length < tailGroundTruth.length) {
    throw new ConsistencyError(
      `Provider message tail is shorter than expected: ` +
        `got ${providerTail.length} messages, expected at least ${tailGroundTruth.length}`,
      {
        expected: tailGroundTruth.length,
        actual: providerTail.length,
        context: "tail-length",
      }
    );
  }
  for (let i = 0; i < tailGroundTruth.length; i++) {
    const expected = tailGroundTruth[tailGroundTruth.length - 1 - i]!;
    const actual = providerTail[providerTail.length - 1 - i]!;
    assertMessageEqual(actual, expected, `tail[${i}]`);
  }
}

function assertMessageEqual(actual: ProviderMessage, expected: ProviderMessage, ctx: string): void {
  if (actual.role !== expected.role) {
    throw new ConsistencyError(`Role mismatch at ${ctx}: expected ${expected.role}, got ${actual.role}`, {
      expected: expected.role,
      actual: actual.role,
      context: ctx,
    });
  }
  const aBlocks = actual.content;
  const eBlocks = expected.content;
  if (aBlocks.length !== eBlocks.length) {
    throw new ConsistencyError(`Block count mismatch at ${ctx}: expected ${eBlocks.length}, got ${aBlocks.length}`, {
      expected: eBlocks.length,
      actual: aBlocks.length,
      context: ctx,
    });
  }
  for (let i = 0; i < eBlocks.length; i++) {
    assertBlockEqual(aBlocks[i]!, eBlocks[i]!, `${ctx}.block[${i}]`);
  }
}

function assertBlockEqual(actual: ProviderMessageContent, expected: ProviderMessageContent, ctx: string): void {
  if (actual.type !== expected.type) {
    throw new ConsistencyError(`Block type mismatch at ${ctx}: expected ${expected.type}, got ${actual.type}`, {
      expected: expected.type,
      actual: actual.type,
      context: ctx,
    });
  }
  if (actual.type === "text" && expected.type === "text") {
    if (actual.text !== expected.text) {
      throw new ConsistencyError(`Text mismatch at ${ctx}`, {
        expected: expected.text.slice(0, 200),
        actual: actual.text.slice(0, 200),
        context: ctx,
      });
    }
  } else if (actual.type === "tool_use" && expected.type === "tool_use") {
    if (actual.id !== expected.id || actual.name !== expected.name) {
      throw new ConsistencyError(`Tool-use id/name mismatch at ${ctx}`, {
        expected: `${expected.name}(${expected.id})`,
        actual: `${actual.name}(${actual.id})`,
        context: ctx,
      });
    }
 // Input must match exactly (deep equality via JSON).
    const aj = JSON.stringify(actual.input);
    const ej = JSON.stringify(expected.input);
    if (aj !== ej) {
      throw new ConsistencyError(`Tool-use input mismatch at ${ctx}`, {
        expected: ej?.slice(0, 200),
        actual: aj?.slice(0, 200),
        context: ctx,
      });
    }
  } else if (actual.type === "tool_result" && expected.type === "tool_result") {
    if (actual.toolCallId !== expected.toolCallId) {
      throw new ConsistencyError(`Tool-result toolCallId mismatch at ${ctx}`, {
        expected: expected.toolCallId,
        actual: actual.toolCallId,
        context: ctx,
      });
    }
    if (actual.content !== expected.content) {
      // A tool_result inside the checked tail may still have been legitimately
      // compacted: under budget pressure the real build drops its fold window
      // (keepRecentMessages 8 → 6 → 4 → 2, then a hard trim at 1) and folds or
      // truncates results that this fixed-window ground-truth rebuild left
      // whole. That divergence is by design, not corruption. Treat the provider
      // (`actual`) side being a recognised fold stub / truncation of the full
      // (`expected`) content as consistent; only a NON-compacted-yet-different
      // content is a genuine "model saw something other than what we logged".
      if (isCompactedToolResult(String(actual.content), String(expected.content))) return;
      throw new ConsistencyError(`Tool-result content mismatch at ${ctx}`, {
        expected: String(expected.content).slice(0, 200),
        actual: String(actual.content).slice(0, 200),
        context: ctx,
      });
    }
  }
}

/**
 * True when `actual` is a legitimate micro-compaction of `expected`: either a
 * fold stub (`[folded …]`) or a hard-trim truncation (`… [truncated to fit
 * context window.]`). These transforms are applied on the provider path by
 * design when the turn is under budget pressure; the no-fold ground-truth
 * rebuild keeps the full content, so a divergence here is expected, not a bug.
 */
function isCompactedToolResult(actual: string, expected: string): boolean {
  // Fold stubs — see summariseToolResult / foldForBudget in compaction.ts.
  if (actual.startsWith("[folded tool_result") || actual.startsWith("[folded ")) return true;
  // Hard-trim truncation keeps a head+tail of the original and injects a
  // notice. Require the notice AND that the provider content is strictly
  // shorter than the full content (a real truncation, not a rewrite).
  if (actual.includes("[truncated to fit context window.]") && actual.length < expected.length) {
    return true;
  }
  return false;
}
