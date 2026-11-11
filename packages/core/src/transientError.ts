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

/** Coarse failure class for a provider request, from its error message.
 *  - "payload_too_large": the request bytes/size were rejected (413 or an
 *    explicit "payload/request too large"), WITHOUT token/context-window
 *    semantics. Recover by shrinking the request body (fold the largest tool
 *    results, drop inline images, head+tail a single oversize message) rather
 *    than compacting the whole transcript.
 *  - "context_overflow": too many tokens for the model's context window.
 *    Recover by compacting the transcript and shrinking the send budget.
 *  - "transient": network blip / rate-limit / gateway overload — retry.
 *  - "fatal": a deterministic error (auth, bad request) — fail fast. */
export type ProviderFailureKind =
  | "payload_too_large"
  | "context_overflow"
  | "transient"
  | "fatal";

/** Phrasings that indicate a byte/size-level payload rejection (as opposed to
 * a token-count rejection). */
const PAYLOAD_PATTERNS: RegExp[] = [
  /payload too large|request entity too large|request too large|body too large/i,
  /maximum (?:request|payload|body) size|exceeds the maximum size/i,
];

/** Phrasings that mean "too many tokens for the context window". Mirrors
 * {@link isContextOverflowError} in agent.ts; kept here so the structured
 * classifier can tell an ambiguous 413 apart from a real token overflow. */
const CONTEXT_PATTERNS: RegExp[] = [
  /context[_ ]length|maximum context|too (?:long|many tokens)/i,
  /exceeds? the (?:model'?s )?(?:maximum )?context|prompt is too long/i,
  /reduce the length|input length|context window (?:exceeded|too)/i,
];

/**
 * Classify a provider failure from its error message. Structured signal (the
 * framed HTTP status) is consulted first; 413 is split by whether the body also
 * carries context/window semantics (then overflow) or only size semantics (then
 * payload). Non-413 messages fall back to pattern families.
 */
export function classifyProviderFailure(message: string): ProviderFailureKind {
  const statusMatch = STATUS_TOKEN.exec(message);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const hasContext = CONTEXT_PATTERNS.some((re) => re.test(message));
  const hasPayload = PAYLOAD_PATTERNS.some((re) => re.test(message));

  // A 413 is the canonical payload rejection, but some gateways return 413 for a
  // token overflow too — if the body talks about context/window, treat it as
  // overflow so we compact instead of only shrinking bytes.
  if (status === 413) {
    return hasContext ? "context_overflow" : "payload_too_large";
  }
  if (hasContext) return "context_overflow";
  if (hasPayload) return "payload_too_large";
  if (isTransientError(message)) return "transient";
  return "fatal";
}
