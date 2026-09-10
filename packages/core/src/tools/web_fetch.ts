// web_fetch: fetch a URL and return readable text.
//
// Zero-dependency: uses Node's global fetch. HTML is stripped to text with
// a small, deterministic pipeline (drop script/style, tags → whitespace,
// entity decode, whitespace collapse). Large pages spill to an artifact.
//
// Two policy levers (driven by `config.webFetch`):
//   - **Per-domain allowlist/blocklist**: domains in `blockedDomains` are
//     always refused; domains in `allowedDomains` are fetched without an
//     interactive prompt (the permission engine still runs, but a matching
//     allow entry short-circuits it). Unlisted domains fall through to the
//     normal permission flow.
//   - **15-minute disk cache**: identical URLs within the TTL return the
//     cached text instead of re-fetching. Cache lives under
//     `<cwd>/.codepilot/cache/web_fetch/<hash>.json` and is shared across
//     sessions in the same project. Set `cacheTtlMinutes: 0` to disable.

import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDef } from "./types.js";
import type { WebFetchConfig } from "../types.js";

const schema = z.object({
  url: z.string().url().describe("http(s) URL to fetch."),
  max_chars: z
    .number()
    .int()
    .positive()
    .max(100_000)
    .optional()
    .describe("Cap on returned characters (default 20_000; full page spills to an artifact)."),
  /** Bypass the cache for this single call (e.g. when the user suspects the
   *  page changed). The fresh result is still cached. */
  no_cache: z.boolean().optional().describe("Bypass the cache for this call (default false)."),
});

const ARTIFACT_THRESHOLD = 8_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MIN = 15;
const CACHE_DIR_REL = ".codepilot/cache/web_fetch";
/** Cap cache entries per project to bound disk usage. LRU-ish: oldest
 *  mtime evicted first when over the cap. */
const MAX_CACHE_ENTRIES = 200;

interface CacheEntry {
  url: string;
  fetchedAt: string; // ISO
  status: number;
  finalUrl?: string;
  contentType: string;
  text: string;
}

function cacheDir(cwd: string): string {
  return join(cwd, CACHE_DIR_REL);
}

function cachePath(cwd: string, url: string): string {
  const h = createHash("sha256").update(url).digest("hex").slice(0, 24);
  return join(cacheDir(cwd), `${h}.json`);
}

async function readCache(cwd: string, url: string, ttlMs: number): Promise<CacheEntry | null> {
  if (ttlMs <= 0) return null;
  const p = cachePath(cwd, url);
  if (!existsSync(p)) return null;
  try {
    const e = JSON.parse(await readFile(p, "utf-8")) as CacheEntry;
    const age = Date.now() - new Date(e.fetchedAt).getTime();
    if (age > ttlMs) return null;
    return e;
  } catch {
    return null;
  }
}

async function writeCache(cwd: string, entry: CacheEntry): Promise<void> {
  try {
    await mkdir(cacheDir(cwd), { recursive: true });
    await writeFile(cachePath(cwd, entry.url), JSON.stringify(entry), "utf-8");
    await pruneCache(cwd);
  } catch {
    /* best-effort */
  }
}

async function pruneCache(cwd: string): Promise<void> {
  const dir = cacheDir(cwd);
  if (!existsSync(dir)) return;
  try {
    const files = await readdir(dir);
    if (files.length <= MAX_CACHE_ENTRIES) return;
    const statted = await Promise.all(
      files.map(async (f) => {
        try {
          const s = await stat(join(dir, f));
          return { f, mtime: s.mtimeMs };
        } catch {
          return { f, mtime: Infinity };
        }
      })
    );
    statted.sort((a, b) => a.mtime - b.mtime);
    const toRemove = statted.slice(0, statted.length - MAX_CACHE_ENTRIES);
    for (const { f } of toRemove) {
      await rm(join(dir, f), { force: true });
    }
  } catch {
    /* ignore */
  }
}

/** Check the per-domain allowlist/blocklist. Returns an error message when
 *  the domain is blocked, or null when allowed. */
function domainGate(url: string, cfg?: WebFetchConfig): string | null {
  if (!cfg) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return `invalid URL: ${url}`;
  }
  const blocked = cfg.blockedDomains ?? [];
  for (const d of blocked) {
    const dl = d.toLowerCase();
    if (host === dl || host.endsWith("." + dl)) {
      return `domain "${host}" is blocked by config (matched "${d}")`;
    }
  }
  // allowedDomains, when non-empty, is an allowlist. We don't hard-deny
  // unlisted domains here — that's the permission engine's job via an
  // interactive prompt. We only hard-deny blocked domains.
  return null;
}

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
    "untrusted data without inspecting them.\n\n" +
    "Results are cached for 15 minutes by default (configurable via " +
    "`webFetch.cacheTtlMinutes`); pass `no_cache: true` to force a fresh fetch. " +
    "Domains in `webFetch.blockedDomains` are refused outright.",
  inputSchema: schema,
  permission: "network",
  async execute(input, ctx) {
    const cfg = ctx.config?.webFetch;
    // 1. Per-domain gate.
    const blocked = domainGate(input.url, cfg);
    if (blocked) {
      return { content: `web_fetch refused: ${blocked}`, isError: true };
    }
    // 2. Cache lookup.
    const ttlMs = (cfg?.cacheTtlMinutes ?? DEFAULT_CACHE_TTL_MIN) * 60_000;
    if (!input.no_cache) {
      const hit = await readCache(ctx.cwd, input.url, ttlMs);
      if (hit) {
        return renderResult(hit.text, hit.status, hit.finalUrl, hit.url, ctx, true);
      }
    }
    // 3. Fetch.
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
      const finalUrl = res.url && res.url !== input.url ? res.url : undefined;
      // 4. Write to cache (even on non-2xx, so a flapping server doesn't
      //    hammer it; the TTL bounds staleness).
      await writeCache(ctx.cwd, {
        url: input.url,
        fetchedAt: new Date().toISOString(),
        status: res.status,
        finalUrl,
        contentType,
        text,
      });
      return renderResult(text, res.status, finalUrl, input.url, ctx, false);
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

/** Shared renderer for cached + fresh results. */
async function renderResult(
  text: string,
  status: number,
  finalUrl: string | undefined,
  url: string,
  ctx: { artifact: (b: string | Uint8Array, h?: string) => Promise<string> },
  cached: boolean
): Promise<{ content: string; isError: boolean; artifactRef?: string }> {
  const cap = 20_000;
  let content = text.slice(0, cap);
  let artifactRef: string | undefined;
  if (text.length > ARTIFACT_THRESHOLD) {
    artifactRef = await ctx.artifact(text, `web_fetch:${url.slice(0, 80)}`);
    content += `\n\n[${text.length - cap} more chars; full content saved to artifact ${artifactRef}]`;
  }
  const finalUrlLine = finalUrl ? `\nfinal URL: ${finalUrl}` : "";
  const cacheTag = cached ? " (cached)" : "";
  return {
    content: `[HTTP ${status}${cacheTag}]${finalUrlLine}\n\n${content}`,
    isError: status < 200 || status >= 300,
    artifactRef,
  };
}

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
