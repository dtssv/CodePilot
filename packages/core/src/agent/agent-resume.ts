// Truncation / interrupt / soft-stop resume copy, overflow shrink ladders, and
// related heuristics used when a provider turn ends incompletely.

import type { ToolUseBlock } from "../types.js";

export const MAX_TRUNCATION_RESUMES = 3;
/** Max consecutive mid-stream interrupts resumed by continuation before we
 * give up on continuing and fall back to regenerating the turn. */
export const MAX_INTERRUPT_RESUMES = 3;
export const MAX_EMPTY_STOP_RESUMES = 2;
export const MAX_PLAN_SOFT_RESUMES = 1;
/** The model wrote a tool call as text markup instead of a real call. Nudge it
 * back to the structured channel a bounded number of times, then stop so a
 * model that simply cannot emit structured calls can't loop forever. */
export const MAX_PSEUDO_TOOL_RESUMES = 2;
/** Proportional send-budget shrink steps applied on successive context-overflow
 * errors: first compact, then shrink to these fractions of the computed hard
 * budget. Bounded so overflow can't loop. */
export const OVERFLOW_SHRINK_STEPS = [0.6, 0.4, 0.25];

/** Payload-too-large (byte/size) recovery shrink the SEND budget harder and
 * drop inline images / fold every tool result. Distinct from the token-overflow
 * ladder: a size rejection is not fixed by compacting the transcript's tokens,
 * only by shrinking the request body. Bounded so it can't loop. */
export const PAYLOAD_SHRINK_STEPS = [0.5, 0.3, 0.2];

export const TRUNCATION_RESUME =
  "[system] Your previous reply was cut off by the output-token limit. Continue exactly where it " +
  "stopped — don't repeat what you already wrote. If you were about to call a tool with a large " +
  "argument, split the work into smaller calls.";

export const INTERRUPT_RESUME =
  "[system] The connection dropped mid-response, so your previous reply was cut off partway. The " +
  "text you had already produced is preserved above. Continue exactly where it stopped — do NOT " +
  "repeat what you already wrote, and do NOT restart the task from the beginning.";

export const EMPTY_STOP_RESUME =
  "[system] Your previous response ended successfully but contained no visible text. Respond to " +
  "the user now: continue the task from its current state without repeating completed work — call " +
  "tools if you still have autonomous work, otherwise write a short status or answer for the user.";

export const PLAN_SOFT_RESUME =
  "[system] Your plan still has unfinished steps, and your last reply looked incomplete. " +
  "Resume at the first unfinished step — do not repeat completed work. Keep calling tools until " +
  "the step's deliverable is done, or ask the user a clear question if you are blocked.";

export const PSEUDO_TOOL_CALL_RESUME =
  "[system] Your last reply wrote a tool call as text markup (e.g. <tool_call> / <invoke> / " +
  "<arg_key> / <parameter>) instead of making a real tool call. Text like that is NOT executed — " +
  "it was shown to the user verbatim and nothing ran. Use the structured tool-calling channel: " +
  "issue the tool call through the function/tool interface, never by writing XML/markup in your " +
  "reply. Re-issue the call now.";

export const TRUNCATED_CALL =
  "This tool call was cut off by the output-token limit before its arguments were complete, so it " +
  "was NOT executed. Re-issue it with smaller arguments — e.g. write a large file in several parts " +
  "(write_file for the first part, then edit_file / apply_patch to append the rest).";

export const PLAN_ONLY_TURN =
  "\n\nNote: this response contained only plan_update, which cost a full extra request. Next " +
  "time, send plan_update in the same response as the tool calls for the step you're starting.";

export const MALFORMED_CALL =
  "This tool call's arguments were not valid JSON, so it was NOT executed. Re-issue it with " +
  "well-formed JSON arguments.";

/** Providers hand back `{ __raw }` when a tool call's JSON didn't parse. */
export function hasUnparsedInput(tc: ToolUseBlock): boolean {
  const input = tc.input as Record<string, unknown> | null;
  return !!input && typeof input === "object" && "__raw" in input && Object.keys(input).length === 1;
}

/**
 * Detect when the model wrote a tool call as markup into its reply text instead
 * of a real structured call. We (bounded) nudge it back to the tool channel; we
 * do NOT parse and run the markup. Targets invocation markup specifically.
 */
export function looksLikePseudoToolCall(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    /<\s*tool_call\b/i.test(t) ||
    /<\s*function_calls\b/i.test(t) ||
    /<\s*invoke\b[^>]*\bname\s*=/i.test(t) ||
    /<\s*arg_key\s*>/i.test(t) ||
    /<\s*parameter\b[^>]*\bname\s*=/i.test(t) ||
    /<\s*antml:/i.test(t)
  );
}

/** Whether a provider error means "the prompt is too long for the context
 * window" — recoverable by compacting and retrying, unlike a transient
 * network error. Matches the common phrasings
 * across OpenAI / Anthropic / gateways. */
export function isContextOverflowError(message: string): boolean {
  return /context[_ ]length|maximum context|too (?:long|many tokens)|exceeds? the (?:model'?s )?(?:maximum )?context|prompt is too long|reduce the length|input length|context window (?:exceeded|too)/i.test(
    message,
  );
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
