// Search-engine catalog: a list of ready-made web_search backends (GitHub JSON
// + daily cache + bundled seed), each a `custom` HTTP template so any JSON
// search API can be configured by picking it from the catalog instead of
// hand-writing the template. Mirrors providerCatalog.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CustomSearchTemplate } from "./types.js";
import { loadCatalogDocument } from "./remoteCatalog.js";

/** One catalog entry: a named, ready-to-use custom search backend. */
export interface SearchEngineTemplate {
  /** Stable id, e.g. `brave`, `serper`, `searxng`. */
  id: string;
  displayName: string;
  /** One-line hint shown in the settings / setup UI. */
  description?: string;
  /** Where to obtain an API key, if any. */
  signupUrl?: string;
  /** True when the engine needs an API key (surfaced as a key field in UI). */
  needsKey?: boolean;
  /** Conventional env var holding the key, interpolated into the template. */
  keyEnvVar?: string;
  /** The HTTP template written to `webSearch.custom` when this engine is chosen. */
  template: CustomSearchTemplate;
}

interface SearchEnginesDoc {
  version?: number;
  updatedAt?: string;
  engines?: SearchEngineTemplate[];
}

function bundledSearchEngines(): SearchEngineTemplate[] {
  // Prefer the on-disk bundled JSON (dev / npm install), but fall back to the
  // inlined copy below so the seed survives Bun's `--compile` binary, where the
  // relative readFileSync has no backing file in the virtual FS.
  try {
    const path = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "catalog",
      "search-engines.json",
    );
    const doc = JSON.parse(readFileSync(path, "utf-8")) as SearchEnginesDoc;
    if (Array.isArray(doc.engines) && doc.engines.length > 0) return doc.engines;
  } catch {
    // fall through to the inlined seed
  }
  return INLINE_SEED;
}

/**
 * Inlined copy of `catalog/search-engines.json`. Kept in sync with that file;
 * it is the offline seed for the compiled binary (and any environment where the
 * bundled JSON is unreadable). The GitHub catalog still overrides it daily.
 */
const INLINE_SEED: SearchEngineTemplate[] = [
  {
    id: "brave",
    displayName: "Brave Search",
    description: "2000/mo free · brave.com/search/api",
    signupUrl: "https://brave.com/search/api",
    needsKey: true,
    keyEnvVar: "BRAVE_API_KEY",
    template: {
      method: "GET",
      url: "https://api.search.brave.com/res/v1/web/search?q={query}&count={max}",
      headers: { "X-Subscription-Token": "${BRAVE_API_KEY}" },
      resultsPath: "web.results",
      fields: { title: "title", url: "url", snippet: "description" },
    },
  },
  {
    id: "serper",
    displayName: "Serper (Google results)",
    description: "2500 free · serper.dev",
    signupUrl: "https://serper.dev",
    needsKey: true,
    keyEnvVar: "SERPER_API_KEY",
    template: {
      method: "POST",
      url: "https://google.serper.dev/search",
      headers: { "X-API-KEY": "${SERPER_API_KEY}", "Content-Type": "application/json" },
      body: '{"q":"{query}","num":{max}}',
      resultsPath: "organic",
      fields: { title: "title", url: "link", snippet: "snippet" },
    },
  },
  {
    id: "tavily",
    displayName: "Tavily",
    description: "AI-optimized search · tavily.com",
    signupUrl: "https://tavily.com",
    needsKey: true,
    keyEnvVar: "TAVILY_API_KEY",
    template: {
      method: "POST",
      url: "https://api.tavily.com/search",
      headers: { "Content-Type": "application/json" },
      body: '{"api_key":"${TAVILY_API_KEY}","query":"{query}","max_results":{max}}',
      resultsPath: "results",
      fields: { title: "title", url: "url", snippet: "content" },
    },
  },
  {
    id: "searxng",
    displayName: "SearXNG (self-hosted)",
    description: "point at your own SearXNG instance",
    needsKey: false,
    template: {
      method: "GET",
      url: "${SEARXNG_URL}/search?q={query}&format=json",
      resultsPath: "results",
      fields: { title: "title", url: "url", snippet: "content" },
    },
  },
  {
    id: "bocha",
    displayName: "博查 Bocha (中文)",
    description: "中文搜索 API · bochaai.com",
    signupUrl: "https://open.bochaai.com",
    needsKey: true,
    keyEnvVar: "BOCHA_API_KEY",
    template: {
      method: "POST",
      url: "https://api.bochaai.com/v1/web-search",
      headers: { Authorization: "Bearer ${BOCHA_API_KEY}", "Content-Type": "application/json" },
      body: '{"query":"{query}","count":{max}}',
      resultsPath: "data.webPages.value",
      fields: { title: "name", url: "url", snippet: "snippet" },
    },
  },
];

/** Offline / boot fallback (bundled JSON). Prefer {@link listSearchEngines}. */
export const SEARCH_ENGINES: readonly SearchEngineTemplate[] = bundledSearchEngines();

function mergeEngines(
  base: readonly SearchEngineTemplate[],
  overlay: SearchEngineTemplate[],
): SearchEngineTemplate[] {
  const map = new Map<string, SearchEngineTemplate>();
  for (const e of base) map.set(e.id, e);
  for (const e of overlay) {
    if (e?.id) map.set(e.id, e);
  }
  return [...map.values()];
}

/**
 * GitHub catalog (update once per day; keep local forever on failure). Returns
 * the bundled seed merged with the remote list so a picker always has options
 * even offline.
 */
export async function listSearchEngines(opts?: { force?: boolean }): Promise<SearchEngineTemplate[]> {
  try {
    const { data } = await loadCatalogDocument<SearchEnginesDoc>("search-engines", opts);
    const remote = Array.isArray(data.engines) ? data.engines : [];
    return mergeEngines(SEARCH_ENGINES, remote);
  } catch {
    return [...SEARCH_ENGINES];
  }
}
