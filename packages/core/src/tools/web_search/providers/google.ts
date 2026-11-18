import type { ToolContext } from "../../types.js";
import { htmlToText } from "../../web_fetch.js";
import { googleDateRestrict } from "../backend.js";
import type { SearchHit, SearchLocale } from "../types.js";

export async function googleSearch(
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
  const params = new URLSearchParams({
    key: backend.apiKey,
    cx: backend.cx,
    q: query,
    num: String(Math.min(max, 10)),
  });
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
  const json = (await res.json()) as {
    items?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  return (json.items ?? []).map((r) => ({
    title: htmlToText(r.title ?? ""),
    url: r.link ?? "",
    snippet: htmlToText(r.snippet ?? ""),
  }));
}
