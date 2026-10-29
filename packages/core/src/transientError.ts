// Single source of truth for message-based transient-error classification.
//
// Several layers need to ask "is this error worth retrying / not a real
// failure?" from an error *message* (as opposed to an HTTP Response — that
// status-based check lives in providers/retry.ts, a lower layer):
//   - the agent turn loop (regenerate a dropped stream),
//   - the task tool (retry a transient sub-agent failure once),
//   - stop-verify (treat a rate-limited judge call as a non-failure).
// They used to each carry their own near-duplicate regex, which drifted: the
// judge classifier matched phrasings the others lacked ("too many requests",
// "tokens limit", "访问限制") while missing network/timeout, and the task
// classifier was a strict subset of the agent one. Unifying on this union keeps
// the retry policy predictable everywhere.

/** Phrasings that indicate a transient, retry-worthy failure. The union of the
 * network, errno, timeout, overload, rate-limit, and stream-drop families, plus
 * the gateway/TPM phrasings that only the judge path used to catch. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /network|fetch failed|socket|terminated|aborted by peer|other side closed/i,
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|UND_ERR/,
  // Timeouts and aborts (network drops, AbortSignal, semaphore-acquire aborts).
  // Deliberate non-transient stops avoid the word "aborted" (see the
  // degeneration guard in agent.ts) so they are not misclassified as transient.
  /timed? ?out|timeout|aborted|aborterror/i,
  /overloaded|temporarily unavailable|try again|server error|bad gateway/i,
  /rate.?limit|too many requests|tokens? limit|访问限制|sustaining heavy rate-limiting/i,
  /\b429\b|\b5\d\d\b/,
  /stream (ended|closed)|unexpected end/i,
];

/** Whether an error message describes a transient failure (network blip,
 * rate-limit, gateway overload, dropped stream) rather than a deterministic
 * one. Callers use it to decide whether a retry / regenerate is worthwhile. */
export function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((re) => re.test(message));
}
