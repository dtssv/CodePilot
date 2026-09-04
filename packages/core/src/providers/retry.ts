// Shared retry helper for provider HTTP calls.
// Retries transient failures (429 rate-limit, 5xx, network errors) with
// exponential backoff, honoring Retry-After when present.

export interface RetryOptions {
  maxRetries?: number; // default 5
  baseDelayMs?: number; // default 1000
  maxDelayMs?: number; // default 60_000
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

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
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(maxDelay, base * 2 ** attempt + Math.random() * 500);
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
    attempt++;
    opts.onRetry?.(attempt, delay, `HTTP ${res.status}`);
    await sleep(delay, opts.signal);
  }
}
