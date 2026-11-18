import { ddgKl, htmlDf } from "../backend.js";
import { formatFetchError, BROWSER_UA, SEARCH_TIMEOUT_MS, type SearchHit, type SearchLocale } from "../types.js";
import { parseBingHtml, parseDuckDuckGoHtml } from "../html.js";

/**
 * Keyless search: try DuckDuckGo HTML first; on network/parse failure fall
 * back to Bing HTML (DDG is frequently unreachable from some regions/ISPs).
 */
export async function duckDuckGoSearch(
  query: string,
  max: number,
  locale: SearchLocale,
  signal: AbortSignal,
): Promise<SearchHit[]> {
  const errors: string[] = [];
  const df = htmlDf(locale.freshness);
  try {
    const params = new URLSearchParams({ q: query });
    const kl = ddgKl(locale);
    if (kl) params.set("kl", kl);
    if (df) params.set("df", df);
    const url = `https://html.duckduckgo.com/html/?${params.toString()}`;
    const res = await fetch(url, {
      signal,
      headers: { "user-agent": BROWSER_UA, accept: "text/html" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} (possibly rate-limited)`);
    const hits = parseDuckDuckGoHtml(await res.text());
    if (hits.length > 0) return hits.slice(0, max);
    errors.push("DuckDuckGo returned no parseable results");
  } catch (err) {
    errors.push(`DuckDuckGo: ${formatFetchError(err, SEARCH_TIMEOUT_MS)}`);
  }
  try {
    const params = new URLSearchParams({ q: query });
    if (locale.language) params.set("setlang", locale.language);
    if (locale.region) params.set("cc", locale.region);
    const url = `https://www.bing.com/search?${params.toString()}`;
    const res = await fetch(url, {
      signal,
      headers: { "user-agent": BROWSER_UA, accept: "text/html" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const hits = parseBingHtml(await res.text());
    if (hits.length > 0) return hits.slice(0, max);
    errors.push("Bing returned no parseable results");
  } catch (err) {
    errors.push(`Bing: ${formatFetchError(err, SEARCH_TIMEOUT_MS)}`);
  }
  throw new Error(errors.join("; "));
}
