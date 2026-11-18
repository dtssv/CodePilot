import type { SearchHit } from "./types.js";

/** Host of a result URL, lowercased without a leading `www.`. */
export function hitHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/** Whether `host` matches a domain filter entry (exact or subdomain). */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const d = domain.replace(/^www\./i, "").toLowerCase().replace(/^\./, "");
  if (!d) return false;
  return host === d || host.endsWith(`.${d}`);
}

/**
 * Apply allow/block domain filters. Allow-list wins as inclusion; block-list
 * then drops matches. Empty allow = no inclusion filter.
 */
export function filterSearchHitsByDomain(
  hits: SearchHit[],
  allowed?: string[],
  blocked?: string[],
): SearchHit[] {
  const allow = (allowed ?? []).map((d) => d.trim()).filter(Boolean);
  const block = (blocked ?? []).map((d) => d.trim()).filter(Boolean);
  return hits.filter((h) => {
    const host = hitHost(h.url);
    if (!host) return false;
    if (allow.length > 0 && !allow.some((d) => hostMatchesDomain(host, d))) return false;
    if (block.length > 0 && block.some((d) => hostMatchesDomain(host, d))) return false;
    return true;
  });
}

/**
 * Format hits for the model: markdown links + citation reminder so the agent
 * cites sources instead of dumping bare URLs.
 */
export function formatSearchResultsForModel(
  query: string,
  hits: SearchHit[],
  opts?: { via?: string; localeTag?: string },
): string {
  const via = opts?.via ? ` (via ${opts.via})` : "";
  const loc = opts?.localeTag ? ` [${opts.localeTag}]` : "";
  const lines = hits.map((h, i) => {
    const title = h.title.trim() || h.url;
    const link = `[${title}](${h.url})`;
    const snip = h.snippet.trim();
    return snip ? `${i + 1}. ${link}\n   ${snip}` : `${i + 1}. ${link}`;
  });
  return (
    `Results for "${query}"${via}${loc}:\n\n` +
    `${lines.join("\n\n")}\n\n` +
    `CITATION REQUIREMENTS (mandatory):\n` +
    `- Cite claims with markdown links: [descriptive title](https://…), placed next to the claim (not only at the end).\n` +
    `- Prefer a final "Sources:" section listing the URLs you relied on as markdown hyperlinks.\n` +
    `- Link to the supporting page — never to a search-results page; no bare URLs; no citations inside code fences.\n` +
    `- For full page content, follow up with \`web_fetch\` on the chosen URL(s).`
  );
}
