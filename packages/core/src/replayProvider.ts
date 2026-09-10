/**
 * Keyless transcript replay — a `ChatProvider` that replays a previously
 * recorded session transcript instead of calling a real model API
 * (deepseek-harness parity).
 *
 * This enables end-to-end agent-loop tests **without an API key**: you
 * record a session once (with a real key), then replay it in CI to verify
 * the tool dispatch, permission engine, event persistence, and context
 * management all behave correctly. The replayed turns are deterministic —
 * the same transcript always yields the same provider output.
 *
 * Usage:
 *   const provider = new ReplayProvider("./session.jsonl");
 *   const session = new Session({ ..., provider });
 *   await session.prompt("anything"); // replays turn 1 from the file
 *
 * The provider maps each `prompt()` call to the next assistant `message`
 * event in the transcript. Tool calls embedded in that message are emitted
 * as `tool_call` stream events; the agent loop executes them against real
 * tools (so file/bash side-effects still happen — use a temp dir). When the
 * transcript runs out, the provider emits a terminal text message.
 *
 * @module replayProvider
 */
import { readFile } from "node:fs/promises";
import type {
  ChatProvider,
  StreamChatOptions,
  StreamEvent,
} from "./providers/types.js";
import type { Event, ToolUseBlock, UsageInfo } from "./types.js";

/**
 * A ChatProvider that replays assistant turns from a saved session JSONL.
 */
export class ReplayProvider implements ChatProvider {
  readonly name = "replay";
  readonly defaultModel: string;
  readonly smallModel: string;
  private turns: ReplayTurn[] = [];
  private cursor = 0;

  /**
   * @param transcriptPath  Path to a `.jsonl` session file (one JSON event
   *                        per line), or the raw JSONL text.
   */
  constructor(
    transcriptPathOrText: string,
    opts: { model?: string; isRawText?: boolean } = {}
  ) {
    this.defaultModel = opts.model ?? "replay-model";
    this.smallModel = opts.model ?? "replay-model";
    this._load(transcriptPathOrText, opts.isRawText ?? false).catch(() => {
      // Lazy: turns stay empty; stream() will emit a fallback.
    });
  }

  private async _load(src: string, isRawText: boolean): Promise<void> {
    const text = isRawText ? src : await readFile(src, "utf-8");
    const events: Event[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as Event);
      } catch {
        /* skip malformed lines */
      }
    }
    this.turns = extractReplayTurns(events);
  }

  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    const messageId = `replay_${this.cursor}`;
    const turn = this.turns[this.cursor];
    this.cursor++;

    if (!turn) {
      yield { kind: "text_delta", messageId, text: "(replay transcript exhausted)" };
      yield { kind: "usage", usage: { input: 0, output: 0 } };
      yield { kind: "done", finishReason: "stop" };
      return;
    }

    // Emit text deltas (one chunk per text block for simplicity).
    for (const block of turn.textBlocks) {
      yield { kind: "text_delta", messageId, text: block };
    }
    // Emit tool calls.
    for (const tc of turn.toolCalls) {
      yield {
        kind: "tool_call",
        messageId,
        toolCall: tc,
      };
    }
    // Emit usage (zeroed — this is a replay).
    yield { kind: "usage", usage: turn.usage };
    yield { kind: "done", finishReason: turn.toolCalls.length > 0 ? "tool_use" : "stop" };
  }

  /** Number of replayable turns loaded from the transcript. */
  turnCount(): number {
    return this.turns.length;
  }

  /** Reset the replay cursor to the beginning. */
  reset(): void {
    this.cursor = 0;
  }
}

interface ReplayTurn {
  textBlocks: string[];
  toolCalls: ToolUseBlock[];
  usage: UsageInfo;
}

/**
 * Extract replayable assistant turns from a session event log. Each
 * assistant `message` event with text and/or tool_use blocks becomes one
 * turn. Tool_result events are skipped (the agent loop produces them by
 * executing tools, not by the provider).
 */
export function extractReplayTurns(events: Event[]): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  for (const e of events) {
    if (e.type !== "message" || e.role !== "assistant") continue;
    const textBlocks: string[] = [];
    const toolCalls: ToolUseBlock[] = [];
    for (const b of e.content) {
      if (b.type === "text") textBlocks.push(b.text);
      else if (b.type === "tool_use") toolCalls.push(b);
    }
    if (textBlocks.length === 0 && toolCalls.length === 0) continue;
    turns.push({
      textBlocks,
      toolCalls,
      usage: { input: 0, output: 0 },
    });
  }
  return turns;
}
