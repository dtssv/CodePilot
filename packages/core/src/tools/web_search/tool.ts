import { z } from "zod";
import type { ToolDef } from "../types.js";
import { sanitizeUntrustedMcpText } from "../../mcp/mcpResultSanitize.js";
import {
  isRetriableSearchError,
  listAutoSearchBackends,
  resolveSearchLocale,
  type ResolvedSearchBackend,
} from "./backend.js";
import { filterSearchHitsByDomain, formatSearchResultsForModel } from "./filter.js";
import { braveSearch } from "./providers/brave.js";
import { customSearch } from "./providers/custom.js";
import { duckDuckGoSearch } from "./providers/duckduckgo.js";
import { googleSearch } from "./providers/google.js";
import { serperSearch } from "./providers/serper.js";
import { formatFetchError, SEARCH_TIMEOUT_MS, type SearchHit } from "./types.js";

const schema = z.object({
  query: z.string().min(1).describe("Search query"),
  max_results: z.number().int().min(1).max(20).optional().describe("Max results (default 8)"),
  language: z
    .string()
    .optional()
    .describe(
      "Override result language (ISO-639-1, e.g. 'zh', 'en', 'ja'). " +
        "Defaults to auto-detect from the query script, else webSearch.language.",
    ),
  region: z
    .string()
    .optional()
    .describe(
      "Override result region (ISO-3166-1 alpha-2, e.g. 'cn', 'us', 'jp'). " +
        "Defaults to auto-detect from the query script, else webSearch.region.",
    ),
  freshness: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe("Restrict results to this recency window (overrides webSearch.freshness)."),
  allowed_domains: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Only keep results whose host matches one of these domains (e.g. ['docs.python.org', 'github.com']). " +
        "Merged with webSearch.allowedDomains when both are set.",
    ),
  blocked_domains: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Drop results whose host matches one of these domains. " +
        "Merged with webSearch.blockedDomains when both are set.",
    ),
});

export const webSearchTool: ToolDef<typeof schema> = {
  name: "web_search",
  description:
    "Web search → markdown-linked titles/URLs/snippets; follow up with `web_fetch` for page body. " +
    "Prefer for current docs/errors over training data. Default backend is keyless best-effort. " +
    "Results are auto-anchored to the query's language (a Chinese query returns Chinese-language results); " +
    "configure webSearch.language/region/freshness to override. " +
    "Use allowed_domains / blocked_domains to restrict sources. " +
    "When answering from search results you MUST cite with markdown hyperlinks " +
    "([title](url)) next to claims and include a Sources section — never dump bare URLs. " +
    "Include the current year in queries about recent docs/events.",
  inputSchema: schema,
  permission: "network",
  async execute(input, ctx) {
    const backends = listAutoSearchBackends(ctx.config?.webSearch);
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
    const allowed = [
      ...(ctx.config?.webSearch?.allowedDomains ?? []),
      ...(input.allowed_domains ?? []),
    ];
    const blocked = [
      ...(ctx.config?.webSearch?.blockedDomains ?? []),
      ...(input.blocked_domains ?? []),
    ];

    async function runOne(backend: ResolvedSearchBackend): Promise<SearchHit[]> {
      switch (backend.provider) {
        case "brave":
          return braveSearch(input.query, max, backend, locale, controller.signal, ctx);
        case "serper":
          return serperSearch(input.query, max, backend, locale, controller.signal, ctx);
        case "google":
          return googleSearch(input.query, max, backend, locale, controller.signal, ctx);
        case "custom":
          return customSearch(input.query, max, backend.custom, locale, controller.signal, {
            storedKey: backend.apiKey,
            env: backend.env,
          });
        default:
          return duckDuckGoSearch(input.query, max, locale, controller.signal);
      }
    }

    try {
      let lastErr: unknown;
      let used: ResolvedSearchBackend | undefined;
      let hits: SearchHit[] = [];
      for (let i = 0; i < backends.length; i++) {
        const backend = backends[i]!;
        try {
          hits = await runOne(backend);
          used = backend;
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          const more = i < backends.length - 1;
          if (!more || !isRetriableSearchError(err)) break;
        }
      }
      if (lastErr || !used) {
        const backend = backends[0]!;
        const msg = formatFetchError(lastErr ?? new Error("no backend"), SEARCH_TIMEOUT_MS);
        const hint =
          backend.provider === "duckduckgo"
            ? " DuckDuckGo is often blocked; set BRAVE_API_KEY / SERPER_API_KEY, configure webSearch.provider=custom, or web_fetch a known URL."
            : " Try web_fetch with a direct URL, or another webSearch.provider.";
        return {
          content: `web_search (${backend.provider}) failed: ${msg}.${hint}`,
          isError: true,
        };
      }
      hits = filterSearchHitsByDomain(hits, allowed, blocked).slice(0, max);
      if (hits.length === 0) {
        return { content: `no results for "${input.query}".` };
      }
      const langRegion = [locale.language, locale.region].filter(Boolean).join("-");
      const locTag = [langRegion, locale.freshness].filter(Boolean).join(", ");
      const body = formatSearchResultsForModel(input.query, hits, {
        via:
          used.provider === "duckduckgo" ? undefined : (used.engineId ?? used.provider),
        localeTag: locTag || undefined,
      });
      return { content: sanitizeUntrustedMcpText(body) };
    } finally {
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};
