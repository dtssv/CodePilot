/**
 * Consistency assertion: "model-visible equals logged" (deepseek-harness parity).
 *
 * In production, the agent loop intentionally transforms the persisted event
 * transcript before sending it to the model provider:
 *   - **Micro-compaction**: old `tool_result` events are folded into short
 *     stubs (`foldToolResults`) to save tokens. This is lossy by design.
 *   - **Secret redaction**: applied identically to both the persisted event
 *     and the provider message, so it is NOT a source of divergence.
 *
 * This module provides a debug/test-only assertion that verifies the
 * *non-folded* portions of the provider messages exactly match the
 * corresponding persisted events. It catches bugs where a tool result's
 * content, a tool call's input, or a message's text diverges between what
 * the model saw and what was logged — a class of bug that is otherwise
 * invisible and extremely hard to reproduce.
 *
 * Enable by setting `CODEPILOT_ASSERT_CONSISTENCY=1`. When enabled, the
 * agent loop calls `assertConsistency()` after building provider messages
 * and before sending them; any divergence throws an `ConsistencyError`
 * with a precise diff, failing the turn loudly instead of silently
 * corrupting the transcript.
 *
 * @module consistency
 */
import type { ProviderMessage, ProviderMessageContent } from "./providers/types.js";
import type { Event, ContentBlock } from "./types.js";

/** Whether the consistency assertion is enabled (env-gated, off by default). */
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
 * @param providerMessages  The messages built by `buildProviderMessages`.
 * @param events            The full persisted event log (history + produced).
 * @param keepRecent        The `keepRecentMessages` window used by folding
 *                          (must match what `buildProviderMessages` used).
 * @throws {ConsistencyError} on any divergence in the non-folded portion.
 */
export function assertConsistency(
  providerMessages: ProviderMessage[],
  events: Event[],
  keepRecent = 8
): void {
  // Reconstruct the "ground truth" provider messages WITHOUT folding, then
  // compare the tail (last `keepRecent` events worth of messages). The head
  // may legitimately differ (folded), so we only assert on the tail.
  const tailEvents = events.slice(-keepRecent * 2); // *2: each turn ≈ 2 events
  const tailGroundTruth = eventsToProviderMessages(tailEvents);
  // Find the corresponding tail of the provider messages. Since folding only
  // shortens the head, the tail of providerMessages should match the tail of
  // ground truth.
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

function eventsToProviderMessages(events: Event[]): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  let buffer: { role: "user" | "assistant"; blocks: ProviderMessageContent[] } | null = null;
  const flush = () => {
    if (buffer && buffer.blocks.length > 0) out.push({ role: buffer.role, content: buffer.blocks });
    buffer = null;
  };
  for (const e of events) {
    if (e.type === "message") {
      flush();
      buffer = { role: e.role, blocks: contentBlocksToProvider(e.content) };
    } else if (e.type === "tool_call") {
      if (!buffer || buffer.role !== "assistant") { flush(); buffer = { role: "assistant", blocks: [] }; }
      buffer.blocks.push({ type: "tool_use", id: e.id, name: e.name, input: e.input });
    } else if (e.type === "tool_result") {
      flush();
      out.push({
        role: "user",
        content: [{ type: "tool_result", toolCallId: e.toolCallId, content: e.content, isError: e.isError }],
      });
    }
  }
  flush();
  return out;
}

function contentBlocksToProvider(blocks: ContentBlock[]): ProviderMessageContent[] {
  const out: ProviderMessageContent[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    else if (b.type === "tool_result")
      out.push({ type: "tool_result", toolCallId: b.toolCallId, content: b.content, isError: b.isError });
  }
  return out;
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
      throw new ConsistencyError(`Tool-result content mismatch at ${ctx}`, {
        expected: String(expected.content).slice(0, 200),
        actual: String(actual.content).slice(0, 200),
        context: ctx,
      });
    }
  }
}
