// Row model for the transcript.
//
// Events arrive as a stream of deltas and pairs (tool_call now, tool_result
// later); the UI wants a flat list of stable, renderable rows. This mirrors
// the TUI's `Row` model (apps/tui/src/ui/state.ts) so both front ends agree
// on what a transcript looks like.

import type { Event, PlanStep, UsageInfo } from "@codepilot/core";
import type { FileChange } from "./diff.js";

export interface MessageRow {
  id: string;
  role: "user" | "assistant";
  /** Grows as `message_delta` events arrive. */
  text: string;
  model?: string;
  /** True until the terminal `message` event lands. */
  streaming: boolean;
}

export interface ToolRow {
  id: string;
  name: string;
  input: unknown;
  status: "running" | "ok" | "error";
  result?: string;
  artifactRef?: string;
  /** Present for file-mutating tools — drives the diff view. */
  change?: FileChange | null;
}

export interface TeamRow {
  from: string;
  to: string;
  text: string;
  kind: "assignment" | "conclusion" | "conflict" | "summary" | "status" | "msg";
  at: number;
}

export type Row =
  | { kind: "message"; at: number; msg: MessageRow }
  | { kind: "tool"; at: number; tool: ToolRow }
  | { kind: "plan"; at: number; steps: PlanStep[] }
  | { kind: "usage"; at: number; usage: UsageInfo }
  | { kind: "compaction"; at: number; summary: string }
  | { kind: "error"; at: number; message: string; recoverable: boolean }
  | { kind: "mode"; at: number; mode: string }
  | { kind: "team"; at: number; team: TeamRow };

/** Text of a message event (the blocks the model produced). */
export function messageText(e: Extract<Event, { type: "message" }>): string {
  return e.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
