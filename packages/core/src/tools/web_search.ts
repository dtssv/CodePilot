// web_search: pluggable web-search backend.
//
// Default backend is a keyless DuckDuckGo HTML scraper — convenient but
// best-effort (rate limits / markup changes surface as explicit errors,
// never silent empty results). For reliable search, configure a real API
// backend under `webSearch` in the config (or set the provider's env var):
//
//   { "webSearch": { "provider": "brave", "apiKey": "${BRAVE_API_KEY}" } }
//
// Supported backends: duckduckgo (default), brave, serper, google (CSE).

import { z } from "zod";
import type { WebSearchConfig, WebSearchProvider } from "../types.js";
import type { ToolDef, ToolContext } from "./types.js";
import { htmlToText } from "./web_fetch.js";

const schema = z.object({
  query: z.string().min(1).describe("Search query."),
  max_results: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Number of results to return (default 8)."),
});

const SEARCH_TIMEOUT_MS = 20_000;

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Conventional env var holding each backend's API key. */
const ENV_KEY: Record<Exclude<WebSearchProvider, "duckduckgo">, string> = {
  brave: "BRAVE_API_KEY",
  serper: "SERPER_API_KEY",
  google: "GOOGLE_API_KEY",
};

/** Resolve the backend + credentials from config and env. */
export function resolveSearchBackend(
  cfg: WebSearchConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { provider: WebSearchProvider; apiKey?: string; cx?: string; endpoint?: string } {
  // Explicit provider wins; its key comes from config or the conventional env.
  if (cfg?.provider) {
    const apiKey =
      cfg.apiKey ?? (cfg.provider === "duckduckgo" ? undefined : env[ENV_KEY[cfg.provider]]);
    return { provider: cfg.provider, apiKey, cx: cfg.cx ?? env.GOOGLE_CSE_ID, endpoint: cfg.endpoint };
  }
  // Auto: pick the first backend that has a key available, else DuckDuckGo.
  if (cfg?.apiKey) return { provider: "brave", apiKey: cfg.apiKey, endpoint: cfg.endpoint };
  if (env.BRAVE_API_KEY) return { provider: "brave", apiKey: env.BRAVE_API_KEY };
  if (env.SERPER_API_KEY) return { provider: "serper", apiKey: env.SERPER_API_KEY };
  if (env.GOOGLE_API_KEY && env.GOOGLE_CSE_ID)
    return { provider: "google", apiKey: env.GOOGLE_API_KEY, cx: env.GOOGLE_CSE_ID };
  return { provider: "duckduckgo" };
}

export const webSearchTool: ToolDef<typeof schema> = {
  name: "web_search",
  description:
    "Web search → titles/URLs/snippets; follow up with `web_fetch`. Prefer for " +
    "current docs/errors over training data. Default backend is keyless best-effort.",
  inputSchema: schema,
  permission: "network",
  async execute(input, ctx) {
    const backend = resolveSearchBackend(ctx.config?.webSearch);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }
    const max = input.max_results ?? 8;
    try {
      let hits: SearchHit[];
      switch (backend.provider) {
        case "brave":
          hits = await braveSearch(input.query, max, backend, controller.signal, ctx);
          break;
        case "serper":
          hits = await serperSearch(input.query, max, backend, controller.signal, ctx);
          break;
        case "google":
          hits = await googleSearch(input.query, max, backend, controller.signal, ctx);
          break;
        default:
          hits = await duckDuckGoSearch(input.query, max, controller.signal);
      }
      if (hits.length === 0) {
        return { content: `no results for "${input.query}".` };
      }
      const lines = hits
        .slice(0, max)
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`);
      const via = backend.provider === "duckduckgo" ? "" : ` (via ${backend.provider})`;
      return { content: `Results for "${input.query}"${via}:\n\n${lines.join("\n\n")}` };
    } catch (err) {
      const msg = formatFetchError(err, SEARCH_TIMEOUT_MS);
      const hint =
        backend.provider === "duckduckgo"
          ? " DuckDuckGo is often blocked; set BRAVE_API_KEY / SERPER_API_KEY, or web_fetch a known URL."
          : " Try web_fetch with a direct URL, or another webSearch.provider.";
      return {
        content: `web_search (${backend.provider}) failed: ${msg}.${hint}`,
        isError: true,
      };
    } finally {
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};

// --------------------------------------------------------------- backends

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Unwrap undici's opaque "fetch failed" into the underlying cause. */
export function formatFetchError(err: unknown, timeoutMs: number): string {
  const e = err as Error & { cause?: Error };
  if (e?.name === "AbortError") return `timed out after ${timeoutMs}ms`;
  const cause = e?.cause?.message ?? (typeof e?.cause === "string" ? e.cause : undefined);
  const base = e?.message ?? String(err);
  return cause && cause !== base ? `${base} (${cause})` : base;
}

/**
 * Keyless search: try DuckDuckGo HTML first; on network/parse failure fall
 * back to Bing HTML (DDG is frequently unreachable from some regions/ISPs).
 */
async function duckDuckGoSearch(query: string, max: number, signal: AbortSignal): Promise<SearchHit[]> {
  const errors: string[] = [];
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
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
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
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

async function braveSearch(
  query: string,
  max: number,
  backend: { apiKey?: string; endpoint?: string },
  signal: AbortSignal,
  _ctx: ToolContext,
): Promise<SearchHit[]> {
  if (!backend.apiKey) throw new Error("missing API key (set webSearch.apiKey or BRAVE_API_KEY)");
  const base = backend.endpoint ?? "https://api.search.brave.com/res/v1/web/search";
  const url = `${base}?q=${encodeURIComponent(query)}&count=${Math.min(max, 20)}`;
  const res = await fetch(url, {
    signal,
    headers: { accept: "application/json", "x-subscription-token": backend.apiKey },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (json.web?.results ?? []).map((r) => ({
    title: htmlToText(r.title ?? ""),
    url: r.url ?? "",
    snippet: htmlToText(r.description ?? ""),
  }));
}

async function serperSearch(
  query: string,
  max: number,
  backend: { apiKey?: string; endpoint?: string },
  signal: AbortSignal,
  _ctx: ToolContext,
): Promise<SearchHit[]> {
  if (!backend.apiKey) throw new Error("missing API key (set webSearch.apiKey or SERPER_API_KEY)");
  const base = backend.endpoint ?? "https://google.serper.dev/search";
  const res = await fetch(base, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-api-key": backend.apiKey },
    body: JSON.stringify({ q: query, num: Math.min(max, 20) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (json.organic ?? []).map((r) => ({
    title: htmlToText(r.title ?? ""),
    url: r.link ?? "",
    snippet: htmlToText(r.snippet ?? ""),
  }));
}

async function googleSearch(
  query: string,
  max: number,
  backend: { apiKey?: string; cx?: string; endpoint?: string },
  signal: AbortSignal,
  _ctx: ToolContext,
): Promise<SearchHit[]> {
  if (!backend.apiKey) throw new Error("missing API key (set webSearch.apiKey or GOOGLE_API_KEY)");
  if (!backend.cx) throw new Error("missing CSE id (set webSearch.cx or GOOGLE_CSE_ID)");
  const base = backend.endpoint ?? "https://www.googleapis.com/customsearch/v1";
  // Google CSE caps `num` at 10 per request.
  const url =
    `${base}?key=${encodeURIComponent(backend.apiKey)}&cx=${encodeURIComponent(backend.cx)}` +
    `&q=${encodeURIComponent(query)}&num=${Math.min(max, 10)}`;
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (json.items ?? []).map((r) => ({
    title: htmlToText(r.title ?? ""),
    url: r.link ?? "",
    snippet: htmlToText(r.snippet ?? ""),
  }));
}

// --------------------------------------------------------------- parsing

/** Parse the DuckDuckGo HTML results page. Kept exported for tests. */
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // Results are <a class="result__a" href="...">title</a>, with a
  // <a class="result__snippet">…</a> somewhere before the next result__a.
  const linkRe =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
  const matches = [...html.matchAll(linkRe)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const rawUrl = m[1] ?? "";
    const title = htmlToText(m[2] ?? "");
    // Search for the snippet between this link and the next one.
    const regionStart = (m.index ?? 0) + m[0].length;
    const regionEnd = i + 1 < matches.length ? matches[i + 1]!.index! : html.length;
    const region = html.slice(regionStart, regionEnd);
    const sm = region.match(snippetRe);
    const snippet = sm ? htmlToText(sm[1] ?? "") : "";
    // DDG wraps outbound links: //duckduckgo.com/l/?uddg=<encoded>
    const uddg = rawUrl.match(/uddg=([^&]+)/);
    const url = uddg ? decodeURIComponent(uddg[1]!) : rawUrl;
    if (title) hits.push({ title, url, snippet });
  }
  return hits;
}

/** Parse Bing HTML `b_algo` result cards. Kept exported for tests. */
export function parseBingHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blockRe = /<li[^>]+class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  for (const m of html.matchAll(blockRe)) {
    const block = m[1] ?? "";
    const link = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = link[1] ?? "";
    const title = htmlToText(link[2] ?? "");
    const snip =
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ??
      block.match(/class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snip ? htmlToText(snip[1] ?? "") : "";
    if (title && url.startsWith("http")) hits.push({ title, url, snippet });
  }
  return hits;
}
