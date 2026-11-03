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
  language: z
    .string()
    .optional()
    .describe(
      "Preferred result language as an ISO-639-1 code (e.g. 'zh', 'en', 'ja'). " +
        "Overrides auto-detection; omit to let it infer from the query script.",
    ),
  region: z
    .string()
    .optional()
    .describe("Preferred region/country as an ISO-3166-1 alpha-2 code (e.g. 'cn', 'us')."),
  freshness: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe("Restrict results to a recency window. Omit for no recency filter."),
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

/** Resolved search locale: a language (ISO-639-1) and region (ISO-3166-1
 * alpha-2), plus an optional recency window. Fed to each backend's native
 * params so results are anchored to the query's language instead of relying on
 * the server's IP/UA locale guess. */
export interface SearchLocale {
  language?: string;
  region?: string;
  freshness?: "day" | "week" | "month" | "year";
}

/**
 * Decide the effective locale for a query, with a three-tier priority:
 *   per-call `overrides` (tool input) > `webSearch` config > script auto-detect.
 *
 * Auto-detection anchors a Chinese (or Japanese/Korean) query to that language
 * rather than defaulting to the server's inferred locale — the root cause of a
 * long Chinese multi-keyword query surfacing only loosely-related results. The
 * model can override per call (e.g. force English results, or restrict to the
 * past year) via the tool's `language`/`region`/`freshness` params.
 */
export function resolveSearchLocale(
  query: string,
  cfg: WebSearchConfig | undefined,
  overrides?: { language?: string; region?: string; freshness?: SearchLocale["freshness"] },
): SearchLocale {
  // Freshness has no auto-detection; take the first explicit value.
  const freshness = overrides?.freshness ?? cfg?.freshness;
  // Language/region: a per-call override wins outright; else config; else
  // script auto-detect. Any explicit language OR region disables auto-detect so
  // a caller can, say, set region alone without re-triggering CJK inference.
  const explicitLang = overrides?.language ?? cfg?.language;
  const explicitRegion = overrides?.region ?? cfg?.region;
  if (explicitLang || explicitRegion) {
    return { language: explicitLang, region: explicitRegion, freshness };
  }
  // Script-based auto-detection. A Latin query is left unconstrained so English
  // search behaves exactly as before (no silent region lock-in). Kana/Hangul
  // are checked BEFORE Han: Japanese and Korean text routinely mixes in kanji,
  // so the presence of kana/hangul is the decisive signal; only a query with
  // Han and no kana/hangul is treated as Chinese.
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query))
    return { language: "ja", region: "jp", freshness };
  if (/\p{Script=Hangul}/u.test(query)) return { language: "ko", region: "kr", freshness };
  if (/\p{Script=Han}/u.test(query)) return { language: "zh", region: "cn", freshness };
  return { freshness };
}

/** Google CSE `dateRestrict` token for a freshness window. */
function googleDateRestrict(f: SearchLocale["freshness"]): string | undefined {
  switch (f) {
    case "day":
      return "d1";
    case "week":
      return "w1";
    case "month":
      return "m1";
    case "year":
      return "y1";
    default:
      return undefined;
  }
}

/** Serper/Google `tbs` recency token. */
function serperTbs(f: SearchLocale["freshness"]): string | undefined {
  switch (f) {
    case "day":
      return "qdr:d";
    case "week":
      return "qdr:w";
    case "month":
      return "qdr:m";
    case "year":
      return "qdr:y";
    default:
      return undefined;
  }
}

/** Brave `freshness` token (p = past). */
function braveFreshness(f: SearchLocale["freshness"]): string | undefined {
  switch (f) {
    case "day":
      return "pd";
    case "week":
      return "pw";
    case "month":
      return "pm";
    case "year":
      return "py";
    default:
      return undefined;
  }
}

/** DuckDuckGo/Bing HTML `df` recency token. */
function htmlDf(f: SearchLocale["freshness"]): string | undefined {
  switch (f) {
    case "day":
      return "d";
    case "week":
      return "w";
    case "month":
      return "m";
    case "year":
      return "y";
    default:
      return undefined;
  }
}

/** DuckDuckGo `kl` region-language token, e.g. `cn-zh`, `us-en`, `jp-jp`. */
function ddgKl(loc: SearchLocale): string | undefined {
  if (loc.region && loc.language) return `${loc.region.toLowerCase()}-${loc.language.toLowerCase()}`;
  if (loc.language) return `wt-${loc.language.toLowerCase()}`;
  return undefined;
}

export const webSearchTool: ToolDef<typeof schema> = {
  name: "web_search",
  description:
    "Web search → titles/URLs/snippets; follow up with `web_fetch`. Prefer for " +
    "current docs/errors over training data. Default backend is keyless best-effort. " +
    "Results are auto-anchored to the query's language (a Chinese query returns " +
    "Chinese-language results); configure webSearch.language/region/freshness to override.",
  inputSchema: schema,
  permission: "network",
  async execute(input, ctx) {
    const backend = resolveSearchBackend(ctx.config?.webSearch);
    const locale = resolveSearchLocale(input.query, ctx.config?.webSearch, {
      language: input.language,
      region: input.region,
      freshness: input.freshness,
    });
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
          hits = await braveSearch(input.query, max, backend, locale, controller.signal, ctx);
          break;
        case "serper":
          hits = await serperSearch(input.query, max, backend, locale, controller.signal, ctx);
          break;
        case "google":
          hits = await googleSearch(input.query, max, backend, locale, controller.signal, ctx);
          break;
        default:
          hits = await duckDuckGoSearch(input.query, max, locale, controller.signal);
      }
      if (hits.length === 0) {
        return { content: `no results for "${input.query}".` };
      }
      const lines = hits
        .slice(0, max)
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`);
      const via = backend.provider === "duckduckgo" ? "" : ` (via ${backend.provider})`;
      const locTag = [locale.language, locale.region].filter(Boolean).join("-");
      const loc = locTag || locale.freshness
        ? ` [${[locTag, locale.freshness].filter(Boolean).join(", ")}]`
        : "";
      return { content: `Results for "${input.query}"${via}${loc}:\n\n${lines.join("\n\n")}` };
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
async function duckDuckGoSearch(
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

async function braveSearch(
  query: string,
  max: number,
  backend: { apiKey?: string; endpoint?: string },
  locale: SearchLocale,
  signal: AbortSignal,
  _ctx: ToolContext,
): Promise<SearchHit[]> {
  if (!backend.apiKey) throw new Error("missing API key (set webSearch.apiKey or BRAVE_API_KEY)");
  const base = backend.endpoint ?? "https://api.search.brave.com/res/v1/web/search";
  const params = new URLSearchParams({ q: query, count: String(Math.min(max, 20)) });
  if (locale.language) params.set("search_lang", locale.language);
  if (locale.region) params.set("country", locale.region);
  const bf = braveFreshness(locale.freshness);
  if (bf) params.set("freshness", bf);
  const url = `${base}?${params.toString()}`;
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
  locale: SearchLocale,
  signal: AbortSignal,
  _ctx: ToolContext,
): Promise<SearchHit[]> {
  if (!backend.apiKey) throw new Error("missing API key (set webSearch.apiKey or SERPER_API_KEY)");
  const base = backend.endpoint ?? "https://google.serper.dev/search";
  const body: Record<string, unknown> = { q: query, num: Math.min(max, 20) };
  if (locale.language) body.hl = locale.language;
  if (locale.region) body.gl = locale.region;
  const tbs = serperTbs(locale.freshness);
  if (tbs) body.tbs = tbs;
  const res = await fetch(base, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-api-key": backend.apiKey },
    body: JSON.stringify(body),
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
  locale: SearchLocale,
  signal: AbortSignal,
  _ctx: ToolContext,
): Promise<SearchHit[]> {
  if (!backend.apiKey) throw new Error("missing API key (set webSearch.apiKey or GOOGLE_API_KEY)");
  if (!backend.cx) throw new Error("missing CSE id (set webSearch.cx or GOOGLE_CSE_ID)");
  const base = backend.endpoint ?? "https://www.googleapis.com/customsearch/v1";
  // Google CSE caps `num` at 10 per request.
  const params = new URLSearchParams({
    key: backend.apiKey,
    cx: backend.cx,
    q: query,
    num: String(Math.min(max, 10)),
  });
  // `lr` restricts by document language (lang_zh), `hl` sets the UI language,
  // `gl` biases to a country; together they anchor relevance for the query's
  // language instead of relying on server-side locale inference.
  if (locale.language) {
    params.set("lr", `lang_${locale.language}`);
    params.set("hl", locale.language);
  }
  if (locale.region) params.set("gl", locale.region);
  const dr = googleDateRestrict(locale.freshness);
  if (dr) params.set("dateRestrict", dr);
  const url = `${base}?${params.toString()}`;
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
