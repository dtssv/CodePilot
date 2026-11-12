/**
 * Shared headless (non-interactive / print-mode) output contract.
 *
 * A single prompt runs to completion and machine-readable output is written to
 * a sink. One format set is shared by every non-interactive entry point so a
 * `jq` pipeline or CI script works against any of them unchanged:
 *
 *   text         Plain text — the final assistant message only.
 *   json         A single JSON `result` object emitted once the run finishes.
 *   stream-json  Newline-delimited JSON (NDJSON): one object per line per event
 *                in real time, closed by a final `result` object.
 *
 * The `json` and `stream-json` terminal line is the same rich `HeadlessResult`
 * (subtype + result text + session id + usage + cost + duration + turn count +
 * errors), so the two formats share a schema and only differ in whether the
 * per-event stream precedes the result.
 *
 * Headless mode never prompts interactively for permissions: the caller wires a
 * permission mode / handler that auto-approves or denies. A run is marked
 * `error` only when the prompt call itself throws; recoverable mid-run `error`
 * events are collected in `errors[]` but keep `subtype: "success"` because the
 * run may still have produced a final assistant message.
 *
 * @module headless
 */
import type { Event, UsageInfo } from "./types.js";

/** The minimal session surface headless mode needs. The concrete `Session`
 * class (and any test fake) is structurally compatible; kept narrow so this
 * module stays free of a session import cycle. */
export interface HeadlessSession {
  readonly id: string;
  subscribe(listener: (ev: Event) => void): () => void;
  prompt(text: string): Promise<unknown>;
  getUsage(): UsageInfo;
  filterToolRegistry(allowed: string[]): void;
}

export type OutputFormat = "text" | "json" | "stream-json";

/** The single JSON object emitted by `json` (and closing `stream-json`). */
export interface HeadlessResult {
  type: "result";
  subtype: "success" | "error";
  /** The final assistant text (or an error message when subtype is error). */
  result: string;
  /** Session id (so callers can resume later). */
  session_id: string;
  /** Aggregated token usage for the run. */
  usage: UsageInfo;
  /** Approximate USD cost, when computable. */
  cost_usd?: number;
  /** Wall-clock duration of the run, in ms. */
  duration_ms: number;
  /** Number of assistant turns (messages) produced. */
  num_turns: number;
  /** Whether the model called any tools during the run. */
  had_tool_calls: boolean;
  /** Any errors emitted by the agent loop. */
  errors: string[];
}

export interface HeadlessOptions {
  session: HeadlessSession;
  prompt: string;
  format: OutputFormat;
  /** Maximum number of agent turns (maps to config.maxTurns). */
  maxTurns?: number;
  /** Restrict which tools the agent can use. */
  allowedTools?: string[];
  /** Sink for every output line (a trailing newline is appended per line).
   * Defaults to `process.stdout.write`. Injected in tests and reused by every
   * entry point so the contract is identical across surfaces. */
  write?: (line: string) => void;
}

/**
 * Run a single prompt in headless mode and write the output via the sink.
 * Resolves when the prompt completes (or errors). The caller is responsible for
 * disposing the session afterwards. Returns the computed `HeadlessResult` so a
 * caller can derive an exit code (subtype === "error") without re-parsing.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const { session, prompt, format, allowedTools } = opts;
  const emit = opts.write ?? ((line: string) => void process.stdout.write(line));
  const writeNdjson = (value: unknown): void => emit(JSON.stringify(value) + "\n");
  const startedAt = Date.now();

  // Apply tool restriction before prompting: filter the session's tool
  // registry so the model only sees the allowed tools.
  if (allowedTools && allowedTools.length > 0) {
    session.filterToolRegistry(allowedTools);
  }

  // maxTurns is expected to have been set via config at session creation time;
  // it flows through CodepilotConfig.maxTurns into the agent loop.

  const events: Event[] = [];
  let hadToolCalls = false;
  const errors: string[] = [];
  let lastError: string | null = null;

  const unsubscribe = session.subscribe((ev: Event) => {
    events.push(ev);
    if (format === "stream-json") {
      // Emit each event as a single NDJSON line immediately.
      writeNdjson(ev);
    }
    if (ev.type === "tool_call") hadToolCalls = true;
    if (ev.type === "error") errors.push(ev.message);
  });

  try {
    await session.prompt(prompt);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    errors.push(lastError);
  } finally {
    unsubscribe();
  }

  const duration_ms = Date.now() - startedAt;
  const finalText = extractFinalAssistantText(events);
  const usage = session.getUsage();
  const num_turns = countAssistantTurns(events);
  const success = lastError === null;

  const result: HeadlessResult = {
    type: "result",
    subtype: success ? "success" : "error",
    result: success ? finalText : (lastError ?? finalText),
    session_id: session.id,
    usage,
    cost_usd: usage.costUSD,
    duration_ms,
    num_turns,
    had_tool_calls: hadToolCalls,
    errors,
  };

  if (format === "text") {
    emit(result.result + "\n");
    return result;
  }
  // json: one result object. stream-json: events already streamed, close with
  // the same result object so consumers know the run is done.
  writeNdjson(result);
  return result;
}

/** Extract the text of the last assistant message from the event stream. */
export function extractFinalAssistantText(events: readonly Event[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "assistant") {
      const text = e.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("")
        .trim();
      if (text.length > 0) return text;
    }
  }
  return "";
}

/** Count distinct assistant message events (turns). */
export function countAssistantTurns(events: readonly Event[]): number {
  let n = 0;
  for (const e of events) {
    if (e.type === "message" && e.role === "assistant") n++;
  }
  return n;
}

/** Validate an output-format argument. Returns the normalised value or throws
 * with a helpful message. `undefined` and "text" both yield "text". */
export function parseOutputFormat(raw: string | undefined): OutputFormat {
  if (raw === undefined || raw === "text") return "text";
  if (raw === "json" || raw === "stream-json") return raw;
  throw new Error(`--output-format must be one of: text, json, stream-json (got: ${raw})`);
}
