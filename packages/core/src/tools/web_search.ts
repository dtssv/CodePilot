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
      const e = err as Error;
      const msg = e.name === "AbortError" ? `timed out after ${SEARCH_TIMEOUT_MS}ms` : e.message;
      return {
        content: `web_search (${backend.provider}) failed: ${msg}. Try web_fetch with a direct URL.`,
        isError: true,
      };
    } finally {
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};

// --------------------------------------------------------------- backends

async function duckDuckGoSearch(query: string, _max: number, signal: AbortSignal): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal,
    headers: { "user-agent": "Mozilla/5.0 (compatible; CodePilot)" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (possibly rate-limited)`);
  }
  return parseDuckDuckGoHtml(await res.text());
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
