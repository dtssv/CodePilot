// Row model for the transcript.
//
// Events arrive as a stream of deltas and pairs (tool_call now, tool_result
// later); the UI wants a flat list of stable, renderable rows. This implements
// the TUI's `Row` model (apps/tui/src/ui/state.ts) so both front ends agree
// on what a transcript looks like.

import type { Event, ImageAttachment, PlanStep, SavedUpload, UsageInfo } from "@codepilot/core";
import type { FileChange } from "./diff.js";

export interface MessageRow {
  id: string;
  role: "user" | "assistant";
 /** Grows as `message_delta` events arrive. */
  text: string;
 /** Extended-thinking / reasoning text, accumulated from `reasoning`
  * message deltas (Anthropic extended thinking). Rendered as a collapsible
  * block above the answer. Empty when the model did not think out loud. */
  reasoning?: string;
 /** Images the user attached (user messages only). */
  images?: ImageAttachment[];
 /** Non-image uploads written under `~/.codepilot/projects/<hash>/uploads/`. */
  files?: SavedUpload[];
  model?: string;
 /** True until the terminal `message` event lands. */
  streaming: boolean;
 /** Wall-clock of first streamed token (assistant only) — for TTFT. */
  firstTokenAt?: number;
}

export interface ToolRow {
  id: string;
  name: string;
  input: unknown;
  status: "running" | "ok" | "error";
  result?: string;
  artifactRef?: string;
 /** Images returned by image tools (read_image). */
  images?: ImageAttachment[];
 /** Present for file-mutating tools — drives the diff view. */
  change?: FileChange | null;
 /** Wall-clock start / end, for the step duration shown in the UI. */
  startedAt?: number;
  finishedAt?: number;
}

export interface RetryRow {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
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
  | { kind: "compaction"; at: number; summary: string; foldKind?: "summary" | "micro-fold" }
  | { kind: "error"; at: number; message: string; recoverable: boolean }
  | { kind: "mode"; at: number; mode: string }
  | { kind: "team"; at: number; team: TeamRow }
  | { kind: "retry"; at: number; retry: RetryRow };

/** Text of a message event (the blocks the model produced). */
export function messageText(e: Extract<Event, { type: "message" }>): string {
  return e.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Persisted extended-thinking blocks on an assistant message (resume / export). */
export function messageReasoning(e: Extract<Event, { type: "message" }>): string {
  return e.content
    .filter((b): b is { type: "reasoning"; text: string } => b.type === "reasoning")
    .map((b) => b.text)
    .join("");
}
