// web_search: best-effort web search without an API key.
//
// Uses the DuckDuckGo HTML endpoint and parses the result list. This is a
// convenience channel, not a guaranteed SLA: the endpoint can rate-limit or
// change shape, in which case the tool returns an explicit error (never
// silent empty results). Teams that need reliable search should configure
// an MCP search server instead.

import { z } from "zod";
import type { ToolDef } from "./types.js";
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

export const webSearchTool: ToolDef<typeof schema> = {
  name: "web_search",
  description:
    "Search the web (DuckDuckGo) and return titles, URLs and snippets. Use it to " +
    "find current documentation, library versions, or error messages; then open " +
    "the most promising hit with `web_fetch`. Best-effort: rate limits or markup " +
    "changes surface as explicit errors — fall back to `web_fetch` on a known URL " +
    "in that case. For current facts, prefer this over your training data.",
  inputSchema: schema,
  permission: "network",
  async execute(input, ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; CodePilot)" },
      });
      if (!res.ok) {
        return {
          content: `web_search failed: HTTP ${res.status} (possibly rate-limited). Try web_fetch with a direct URL.`,
          isError: true,
        };
      }
      const html = await res.text();
      const hits = parseDuckDuckGoHtml(html).slice(0, input.max_results ?? 8);
      if (hits.length === 0) {
        return {
          content: `no results for "${input.query}" (or the result page changed shape).`,
        };
      }
      const lines = hits.map(
        (h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`
      );
      return { content: `Results for "${input.query}":\n\n${lines.join("\n\n")}` };
    } catch (err) {
      const msg = (err as Error).name === "AbortError"
        ? `timed out after ${SEARCH_TIMEOUT_MS}ms`
        : (err as Error).message;
      return { content: `web_search failed: ${msg}`, isError: true };
    } finally {
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};

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
