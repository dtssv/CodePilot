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

/** Client errors (HTTP 4xx) are deterministic: the request itself is wrong
 * (bad params, unsupported schema, auth, not found), so retrying sends the same
 * bad request and fails the same way — it must fail fast. The exceptions are the
 * few 4xx that genuinely clear on retry: 408 request-timeout, 409 conflict,
 * 425 too-early, 429 rate-limit (mirrors the retryable set in providers/retry.ts).
 *
 * Providers frame the status as a standalone code right before a colon —
 * "OpenAI 400: <body>", "Anthropic 404: <body>", "Gemini 400: <body>" (see
 * providers/{openai,anthropic,gemini}.ts). We anchor on that "<code>:" token so
 * a stray 4xx/5xx number or a "please try again" nicety inside the response body
 * cannot flip the verdict. Status 0 / network-level failures have no such token
 * and fall through to the transient-pattern check below. */
const STATUS_TOKEN = /(?:^|\s)(\d{3}):/;
const RETRYABLE_CLIENT_STATUS = new Set([408, 409, 425, 429]);

/** Whether an error message describes a transient failure (network blip,
 * rate-limit, gateway overload, dropped stream) rather than a deterministic
 * one. Callers use it to decide whether a retry / regenerate is worthwhile. */
export function isTransientError(message: string): boolean {
  // When the provider framed a status code ("<Provider> <code>: <body>"), a 4xx
  // client error is non-retryable unless it is one of the retryable 4xx. This
  // veto wins over any transient-looking text in the body.
  const m = STATUS_TOKEN.exec(message);
  if (m) {
    const status = Number(m[1]);
    if (status >= 400 && status <= 499 && !RETRYABLE_CLIENT_STATUS.has(status)) {
      return false;
    }
  }
  return TRANSIENT_PATTERNS.some((re) => re.test(message));
}
