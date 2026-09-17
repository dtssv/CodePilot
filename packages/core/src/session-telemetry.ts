// Session telemetry: extracted from the monolithic session.ts.
//
// Wraps each `Session.prompt()` in a "codepilot.prompt" span (no-op when
// OTEL is not configured). The span is wired into the agent deps as
// `parentSpan` so provider streams and tool executions become child spans,
// and is ended in the prompt's finally block.

import { getTracer } from "./telemetry.js";
import type { Span } from "./telemetry.js";

/** Handle for an in-flight prompt span. `undefined` when telemetry is off. */
export type PromptSpan = Span | undefined;

/** Start a "codepilot.prompt" span. Returns undefined when the tracer is
 *  disabled so callers can cheaply skip span bookkeeping. */
export function startPromptSpan(
  sessionId: string,
  promptLength: number
): PromptSpan {
  const tracer = getTracer();
  return tracer.enabled
    ? tracer.startSpan("codepilot.prompt", {
        attributes: {
          "codepilot.session_id": sessionId,
          "codepilot.prompt_length": promptLength,
        },
      })
    : undefined;
}

/** End a prompt span started by `startPromptSpan` (no-op when undefined). */
export function endPromptSpan(span: PromptSpan): void {
  if (span) getTracer().end(span);
}
