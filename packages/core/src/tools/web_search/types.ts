/** Shared types + constants for the web_search tool. */

export const SEARCH_TIMEOUT_MS = 20_000;

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Resolved search locale: ISO-639-1 language + ISO-3166-1 region + optional recency. */
export interface SearchLocale {
  language?: string;
  region?: string;
  freshness?: "day" | "week" | "month" | "year";
}

/** Unwrap undici's opaque "fetch failed" into the underlying cause. */
export function formatFetchError(err: unknown, timeoutMs: number): string {
  const e = err as Error & { cause?: Error };
  if (e?.name === "AbortError") return `timed out after ${timeoutMs}ms`;
  const cause = e?.cause?.message ?? (typeof e?.cause === "string" ? e.cause : undefined);
  const base = e?.message ?? String(err);
  return cause && cause !== base ? `${base} (${cause})` : base;
}
