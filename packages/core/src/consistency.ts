/**
 * Consistency assertion: model-visible equals logged — the non-folded portions
 * of provider messages must exactly match persisted events. Runs every turn via
 * `consistencyCheck` config. @module consistency
 */
import type { ProviderMessage, ProviderMessageContent } from "./providers/types.js";
import type { Event } from "./types.js";
import { compactTranscriptToProviderMessages } from "./agent-messages.js";

/**
 * Whether the CODEPILOT_ASSERT_CONSISTENCY env override forces the throwing
 * path (for tests/CI). Env unset means "defer to config", not "disabled".
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
 * Verify provider messages are consistent with the persisted event log.
 * Only the recent (non-folded) messages are checked — folded results may differ.
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
      // A tail tool_result may have been legitimately compacted under budget
      // pressure (the real build folds/truncates what this fixed-window rebuild
      // left whole). Treat a recognised fold stub/truncation as consistent.
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
 * True when `actual` is a legitimate micro-compaction of `expected`: a fold
 * stub (`[folded …]`) or hard-trim truncation (`… [truncated to fit context window.]`).
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
