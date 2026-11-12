// Shared retry helper for provider HTTP calls.
// Retries transient failures (429 rate-limit, 5xx, network errors) with
// exponential backoff, honoring Retry-After when present.

export interface RetryOptions {
  maxRetries?: number; // default 5
  baseDelayMs?: number; // default 1000
  maxDelayMs?: number; // default 60_000
 /** When set, abort retrying once the next backoff would exceed this many ms.
 * Used to fail fast under sustained rate-limiting instead of blocking the
 * agent for tens of seconds per retry. The caller then gets an error it can
 * surface ("rate-limited, try another provider/model") rather than hanging. */
  abortOnDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** A best-effort provider rate-limit snapshot parsed from response headers. */
export interface ProviderRateLimit {
  requestsRemaining?: number;
  tokensRemaining?: number;
  resetsInSeconds?: number;
}

function numHeader(res: Response, ...names: string[]): number | undefined {
  for (const n of names) {
    const v = res.headers.get(n);
    if (v == null) continue;
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Parse provider rate-limit headers into a normalized snapshot, or null when a
 * response carries none. Handles the common families (Anthropic
 * `anthropic-ratelimit-*`, OpenAI/DeepSeek `x-ratelimit-*`) plus a plain
 * `retry-after` for the reset estimate. Pure + fail-soft: unknown providers
 * simply yield fewer fields.
 */
export function parseRateLimitHeaders(res: Response): ProviderRateLimit | null {
  const requestsRemaining = numHeader(
    res,
    "anthropic-ratelimit-requests-remaining",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining",
  );
  const tokensRemaining = numHeader(
    res,
    "anthropic-ratelimit-tokens-remaining",
    "x-ratelimit-remaining-tokens",
  );
  let resetsInSeconds: number | undefined;
  const retryAfter = retryAfterMs(res);
  if (retryAfter != null) resetsInSeconds = Math.round(retryAfter / 1000);
  const snapshot: ProviderRateLimit = {};
  if (requestsRemaining !== undefined) snapshot.requestsRemaining = requestsRemaining;
  if (tokensRemaining !== undefined) snapshot.tokensRemaining = tokensRemaining;
  if (resetsInSeconds !== undefined) snapshot.resetsInSeconds = resetsInSeconds;
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * fetch with retry on transient errors. Returns the (ok or permanently
 * failed) Response. Throws only on abort or non-retryable network failure.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 5;
  const base = opts.baseDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 60_000;
  const abortOnDelay = opts.abortOnDelayMs;
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(maxDelay, base * 2 ** attempt + Math.random() * 500);
      if (abortOnDelay !== undefined && delay > abortOnDelay) {
        throw new RateLimitAbortedError(
          `aborted after ${attempt} retry attempt(s): next backoff ${Math.round(delay / 1000)}s exceeds the ${Math.round(abortOnDelay / 1000)}s fast-fail threshold. The provider is sustaining heavy rate-limiting — consider switching provider/model or lowering request rate.`,
        );
      }
      attempt++;
      opts.onRetry?.(attempt, delay, err instanceof Error ? err.message : String(err));
      await sleep(delay, opts.signal);
      continue;
    }
    if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= maxRetries) {
      return res;
    }
    const ra = retryAfterMs(res);
    const delay = Math.min(maxDelay, ra ?? base * 2 ** attempt + Math.random() * 500);
    if (abortOnDelay !== undefined && delay > abortOnDelay) {
 // Return the rate-limited response so the caller can surface a clean
 // error rather than blocking for a long backoff. We've already decided
 // retrying won't help in time.
      return res;
    }
    attempt++;
    opts.onRetry?.(attempt, delay, `HTTP ${res.status}`);
    await sleep(delay, opts.signal);
  }
}

/**
 * Thrown when retrying is aborted because the next backoff would exceed the
 * `abortOnDelayMs` threshold (sustained rate-limiting). Providers catch this
 * in their stream and yield it as a recoverable error so the agent loop can
 * stop cleanly and the host can prompt the user to switch provider/model.
 */
export class RateLimitAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitAbortedError";
  }
}
