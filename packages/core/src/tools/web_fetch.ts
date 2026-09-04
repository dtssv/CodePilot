// web_fetch: fetch a URL and return readable text.
//
// Zero-dependency: uses Node's global fetch. HTML is stripped to text with
// a small, deterministic pipeline (drop script/style, tags → whitespace,
// entity decode, whitespace collapse). Large pages spill to an artifact.

import { z } from "zod";
import type { ToolDef } from "./types.js";

const schema = z.object({
  url: z.string().url().describe("http(s) URL to fetch."),
  max_chars: z
    .number()
    .int()
    .positive()
    .max(100_000)
    .optional()
    .describe("Cap on returned characters (default 20_000; full page spills to an artifact)."),
});

const ARTIFACT_THRESHOLD = 8_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 5 * 1024 * 1024;

export const webFetchTool: ToolDef<typeof schema> = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its content as text. HTML pages are converted to " +
    "readable plain text (scripts/styles stripped). Follows redirects and reports " +
    "the final URL. Large pages spill to an artifact — the result keeps the head " +
    "plus an `art_<hash>` ref.\n\n" +
    "When to use: reading documentation, release notes, issues, API references.\n" +
    "When NOT to use: searching the web (use `web_search`), or fetching URLs you " +
    "cannot justify as relevant to the task. Never fetch URLs constructed from " +
    "untrusted data without inspecting them. The request goes out with no " +
    "credentials and a 30s timeout.",
  inputSchema: schema,
  permission: "network",
  async execute(input, ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const res = await fetch(input.url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": "CodePilot (+https://github.com/codepilot) web_fetch",
          accept: "text/html,application/json,text/plain,*/*",
        },
      });
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_BYTES) {
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      }
      const raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
      const contentType = res.headers.get("content-type") ?? "";
      let text = raw;
      if (contentType.includes("text/html")) {
        text = htmlToText(raw);
      }
      const cap = input.max_chars ?? 20_000;
      let content = text.slice(0, cap);
      let artifactRef: string | undefined;
      if (text.length > ARTIFACT_THRESHOLD) {
        artifactRef = await ctx.artifact(text, `web_fetch:${input.url.slice(0, 80)}`);
        content += `\n\n[${text.length - cap} more chars; full content saved to artifact ${artifactRef}]`;
      }
      const finalUrl = res.url && res.url !== input.url ? `\nfinal URL: ${res.url}` : "";
      return {
        content: `[HTTP ${res.status}${finalUrl ? "" : ""}]${finalUrl}\n\n${content}`,
        isError: !res.ok,
        artifactRef,
      };
    } catch (err) {
      const msg = (err as Error).name === "AbortError"
        ? `timed out after ${FETCH_TIMEOUT_MS}ms`
        : (err as Error).message;
      return { content: `web_fetch failed for ${input.url}: ${msg}`, isError: true };
    } finally {
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};

/** Minimal, deterministic HTML → text. Not a browser; good enough for docs. */
export function htmlToText(html: string): string {
  let s = html;
  // Drop non-content blocks entirely.
  s = s.replace(/<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Block-level boundaries become newlines.
  s = s.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|pre|blockquote|table)>/gi, "\n");
  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, "\n");
  // List items get a bullet.
  s = s.replace(/<li\b[^>]*>/gi, "- ");
  // Links keep their link text only.
  s = s.replace(/<a\b[^>]*>/gi, "").replace(/<\/a>/gi, "");
  // All remaining tags become spaces.
  s = s.replace(/<[^>]+>/g, " ");
  // Entities.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
  // Whitespace collapse.
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n\s*\n+/g, "\n\n");
  return s.trim();
}
