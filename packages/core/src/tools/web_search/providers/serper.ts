import type { ToolContext } from "../../types.js";
import { htmlToText } from "../../web_fetch.js";
import { serperTbs } from "../backend.js";
import type { SearchHit, SearchLocale } from "../types.js";

export async function serperSearch(
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
  const json = (await res.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  return (json.organic ?? []).map((r) => ({
    title: htmlToText(r.title ?? ""),
    url: r.link ?? "",
    snippet: htmlToText(r.snippet ?? ""),
  }));
}
