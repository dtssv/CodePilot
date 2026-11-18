import type { ToolContext } from "../../types.js";
import { htmlToText } from "../../web_fetch.js";
import { braveFreshness } from "../backend.js";
import type { SearchHit, SearchLocale } from "../types.js";

export async function braveSearch(
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
  const json = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (json.web?.results ?? []).map((r) => ({
    title: htmlToText(r.title ?? ""),
    url: r.url ?? "",
    snippet: htmlToText(r.description ?? ""),
  }));
}
