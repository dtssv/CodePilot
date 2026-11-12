// Transient-error classification from error messages: shared by the agent
// turn loop, the task tool, and stop-verify so retry policy stays consistent.

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

/** Client 4xx errors are deterministic and fail fast, except the few that clear
 * on retry (408/409/425/429). Providers frame the status as "<code>:" which we
 * anchor on so a stray number or "try again" in the body cannot flip the verdict. */
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

/** Coarse failure class for a provider request, from its error message:
 * payload_too_large (shrink request body), context_overflow (compact transcript),
 * transient (retry), fatal (fail fast). */
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
 * Classify a provider failure from its error message. Framed HTTP status first;
 * 413 splits by context vs size semantics; non-413 falls back to pattern families.
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

/** Failure class for provider failover: distinguishes errors worth trying on
 * another provider (rate_limit, overloaded, server_5xx, transport) from those
 * that fail identically everywhere (auth, invalid_request) and from quota. */
export type ProviderFailoverKind =
  | "auth"
  | "invalid_request"
  | "quota"
  | "rate_limit"
  | "overloaded"
  | "server_5xx"
  | "transport"
  | "other";

/** Phrasings for an exhausted account quota/credit, as opposed to a transient
 * per-minute rate limit. Checked before the generic rate-limit family so an
 * "insufficient quota" message is not miscounted as a retryable rate limit. */
const QUOTA_PATTERNS: RegExp[] = [
  /quota|insufficient[_ ](?:quota|credit|funds|balance)|billing|out of credit|credit balance/i,
  /exceeded your current quota|insufficient_quota/i,
];

/** Transport-level failures (no HTTP status): network drops, DNS, timeouts. */
const TRANSPORT_PATTERNS: RegExp[] = [
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EPIPE|EAI_AGAIN|UND_ERR/,
  /network|fetch failed|socket|terminated|aborted by peer|other side closed/i,
  /timed? ?out|timeout|stream (?:ended|closed)|unexpected end/i,
];

/**
 * Classify a provider failure for failover routing. Framed HTTP status is
 * authoritative; quota phrasings win over a bare 429; status-less messages
 * fall back to pattern families; unrecognised → "other".
 */
export function classifyFailover(message: string): ProviderFailoverKind {
  const statusMatch = STATUS_TOKEN.exec(message);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const isQuota = QUOTA_PATTERNS.some((re) => re.test(message));

  if (status === 401 || status === 403) return "auth";
  if (status === 429) return isQuota ? "quota" : "rate_limit";
  if (status === 529) return "overloaded";
  if (status !== null && status >= 500 && status <= 599) return "server_5xx";
  if (status !== null && status >= 400 && status <= 499) {
    // A retryable 4xx (408/409/425) behaves like transient pressure; the rest
    // are deterministic bad requests.
    return RETRYABLE_CLIENT_STATUS.has(status) ? "rate_limit" : "invalid_request";
  }

  // No framed status — lean on phrasing. A bare status-like number (no colon)
  // is also honoured so a terse "429" / "503" message still classifies.
  if (isQuota) return "quota";
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid api key|permission denied/i.test(message)) {
    return "auth";
  }
  if (/\b429\b|rate.?limit|too many requests|tokens? limit|访问限制/i.test(message)) {
    return "rate_limit";
  }
  if (/\b529\b|overloaded|temporarily unavailable|try again|bad gateway/i.test(message)) {
    return "overloaded";
  }
  if (/\b5\d\d\b|server error/i.test(message)) return "server_5xx";
  if (TRANSPORT_PATTERNS.some((re) => re.test(message))) return "transport";
  return "other";
}

/** Behaviour knob for quota failures in a fallback chain: whether an exhausted
 * quota on one provider cascades to the next (`"next"`) or fails the whole
 * request (`"fail"`, the conservative default — quota is usually account-wide,
 * so a same-account backup rarely helps). */
export type QuotaFailoverPolicy = "next" | "fail";

/** Whether a given failover class should cascade to the next provider in the
 * chain. Transient pressure (rate-limit / overload / 5xx / transport) always
 * cascades; quota is governed by {@link QuotaFailoverPolicy}; auth, invalid
 * requests, and anything unclassified never cascade — retrying them on a backup
 * only burns the chain with the same deterministic failure. */
export function shouldCascadeFailover(
  kind: ProviderFailoverKind,
  onQuota: QuotaFailoverPolicy = "fail",
): boolean {
  switch (kind) {
    case "rate_limit":
    case "overloaded":
    case "server_5xx":
    case "transport":
      return true;
    case "quota":
      return onQuota === "next";
    case "auth":
    case "invalid_request":
    case "other":
      return false;
  }
}
