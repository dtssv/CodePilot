/**
 * Headless / print mode (claude-code `-p --output-format` equivalent).
 *
 * When the TUI is invoked with `--print`/`-p` (and a prompt), we skip the
 * Ink UI entirely and run a single prompt to completion, writing machine-
 * readable output to stdout. Three output formats are supported:
 *
 *   --output-format text        Plain text — the final assistant message only.
 *   --output-format json        A single JSON `result` object written once
 *                               the run finishes (mirrors claude-code).
 *   --output-format stream-json Newline-delimited JSON (NDJSON): one JSON
 *                               object per line per event, in real time.
 *
 * Headless mode never renders the Ink UI, never prompts interactively for
 * permissions (it requires --yolo or a permission mode that auto-approves,
 * otherwise tool calls that need approval are denied), and exits as soon
 * as the prompt completes (or errors).
 *
 * The output schema deliberately mirrors claude-code's so downstream tools
 * (jq pipelines, CI scripts) written against `claude -p --output-format
 * json` work against `codepilot-tui -p --output-format json` unchanged.
 */
import type { Event, Session, UsageInfo } from "@codepilot/core";

export type OutputFormat = "text" | "json" | "stream-json";

export interface HeadlessOptions {
  session: Session;
  prompt: string;
  format: OutputFormat;
  /** Optional stdin reader for prompts piped in (unused for now, reserved
   *  for --input-format stream-json). */
}

/** The single JSON object emitted by `--output-format json` at the end. */
export interface HeadlessResult {
  type: "result";
  subtype: "success" | "error";
  /** The final assistant text (or an error message when subtype is error). */
  result: string;
  /** Session id (so callers can --resume later). */
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

/**
 * Run a single prompt in headless mode and write the output to stdout.
 * Resolves when the prompt completes (or errors). The caller is responsible
 * for disposing the session afterwards.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<void> {
  const { session, prompt, format } = opts;
  const startedAt = Date.now();

  // Collect events for the final json result + extract final text.
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
    if (ev.type === "error") {
      // Recoverable agent-loop errors are collected for visibility but do
      // NOT flip the run to "error" — the run continues and may still
      // produce a final assistant message. Only a prompt() throw (caught
      // below) marks the run as errored.
      errors.push(ev.message);
    }
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
  // A run is "error" only when the prompt() call itself threw (lastError
  // set in the catch). Individual `error` events emitted mid-run are
  // recoverable agent-loop issues — they're collected in `errors[]` for
  // visibility but don't flip the subtype, since the run still produced a
  // final assistant message.
  const success = lastError === null;

  if (format === "text") {
    // Plain text: just the final assistant message (or the error).
    process.stdout.write((success ? finalText : (lastError ?? finalText)) + "\n");
    return;
  }

  if (format === "json") {
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
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  // stream-json: events were already streamed above. Emit a final `result`
  // envelope so consumers know the run is done (mirrors claude-code's
  // closing `{"type":"result",...}` line).
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
  writeNdjson(result);
}

/** Write a single value as compact JSON + newline. Flushes immediately so
 *  stream-json consumers see each line as it's produced. */
function writeNdjson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

/** Extract the text of the last assistant message from the event stream. */
function extractFinalAssistantText(events: readonly Event[]): string {
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
function countAssistantTurns(events: readonly Event[]): number {
  let n = 0;
  for (const e of events) {
    if (e.type === "message" && e.role === "assistant") n++;
  }
  return n;
}

/** Validate an --output-format argument. Returns the normalised value or
 *  throws with a helpful message. */
export function parseOutputFormat(raw: string | undefined): OutputFormat {
  if (raw === undefined || raw === "text") return "text";
  if (raw === "json" || raw === "stream-json") return raw;
  throw new Error(
    `--output-format must be one of: text, json, stream-json (got: ${raw})`
  );
}
