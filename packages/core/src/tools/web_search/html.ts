import { htmlToText } from "../web_fetch.js";
import type { SearchHit } from "./types.js";

/** Parse the DuckDuckGo HTML results page. Kept exported for tests. */
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkRe =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
  const matches = [...html.matchAll(linkRe)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const rawUrl = m[1] ?? "";
    const title = htmlToText(m[2] ?? "");
    const regionStart = (m.index ?? 0) + m[0].length;
    const regionEnd = i + 1 < matches.length ? matches[i + 1]!.index! : html.length;
    const region = html.slice(regionStart, regionEnd);
    const sm = region.match(snippetRe);
    const snippet = sm ? htmlToText(sm[1] ?? "") : "";
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
