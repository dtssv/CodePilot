// web_search backend selection + per-backend request shaping (fetch stubbed).

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSearchBackend, resolveSearchLocale, webSearchTool } from "../src/tools/web_search.js";
import { resolveSandbox } from "../src/sandbox.js";
import type { ToolContext } from "../src/tools/types.js";
import type { CodepilotConfig } from "../src/types.js";

function ctx(config?: CodepilotConfig): ToolContext {
  return {
    cwd: "/tmp",
    artifact: async () => "art_x",
    readArtifact: async () => "",
    sandbox: resolveSandbox({ mode: "off" }, "/tmp"),
    config,
  };
}

describe("resolveSearchBackend", () => {
  it("defaults to DuckDuckGo with no config or keys", () => {
    expect(resolveSearchBackend(undefined, {})).toEqual({ provider: "duckduckgo" });
  });

  it("honours an explicit provider and pulls its key from the conventional env", () => {
    const b = resolveSearchBackend({ provider: "brave" }, { BRAVE_API_KEY: "bk" });
    expect(b).toMatchObject({ provider: "brave", apiKey: "bk" });
  });

  it("prefers an explicit apiKey over the env var", () => {
    const b = resolveSearchBackend({ provider: "serper", apiKey: "cfg" }, { SERPER_API_KEY: "env" });
    expect(b).toMatchObject({ provider: "serper", apiKey: "cfg" });
  });

  it("auto-selects brave when BRAVE_API_KEY is present", () => {
    expect(resolveSearchBackend(undefined, { BRAVE_API_KEY: "bk" })).toMatchObject({
      provider: "brave",
      apiKey: "bk",
    });
  });

  it("auto-selects serper, then google (with CSE id)", () => {
    expect(resolveSearchBackend(undefined, { SERPER_API_KEY: "sk" })).toMatchObject({ provider: "serper" });
    expect(
      resolveSearchBackend(undefined, { GOOGLE_API_KEY: "gk", GOOGLE_CSE_ID: "cx1" }),
    ).toMatchObject({ provider: "google", apiKey: "gk", cx: "cx1" });
  });

  it("does not auto-pick google without a CSE id", () => {
    expect(resolveSearchBackend(undefined, { GOOGLE_API_KEY: "gk" })).toEqual({ provider: "duckduckgo" });
  });

  it("fills the google cx from config or env for an explicit provider", () => {
    expect(resolveSearchBackend({ provider: "google", apiKey: "gk", cx: "cfgcx" }, {})).toMatchObject({
      cx: "cfgcx",
    });
    expect(resolveSearchBackend({ provider: "google", apiKey: "gk" }, { GOOGLE_CSE_ID: "envcx" })).toMatchObject({
      cx: "envcx",
    });
  });

  it("carries the custom template for provider=custom", () => {
    const b = resolveSearchBackend(
      { provider: "custom", custom: { url: "https://x/s?q={query}" } },
      {},
    );
    expect(b).toMatchObject({ provider: "custom", custom: { url: "https://x/s?q={query}" } });
  });
});

describe("resolveSearchLocale", () => {
  it("auto-detects Chinese (Han) → zh/cn", () => {
    expect(resolveSearchLocale("灵异搞笑小说 推荐", undefined)).toMatchObject({
      language: "zh",
      region: "cn",
    });
  });

  it("auto-detects Japanese kana → ja/jp and Korean → ko/kr", () => {
    expect(resolveSearchLocale("おすすめの小説", undefined)).toMatchObject({
      language: "ja",
      region: "jp",
    });
    expect(resolveSearchLocale("추천 소설", undefined)).toMatchObject({
      language: "ko",
      region: "kr",
    });
  });

  it("leaves a Latin query unconstrained (no silent region lock-in)", () => {
    const loc = resolveSearchLocale("rust async runtime", undefined);
    expect(loc.language).toBeUndefined();
    expect(loc.region).toBeUndefined();
  });

  it("an explicit config language/region overrides auto-detection", () => {
    expect(
      resolveSearchLocale("灵异小说", { language: "en", region: "us" }),
    ).toMatchObject({ language: "en", region: "us" });
  });

  it("carries freshness from config regardless of script", () => {
    expect(resolveSearchLocale("rust", { freshness: "year" })).toMatchObject({
      freshness: "year",
    });
    expect(resolveSearchLocale("小说", { freshness: "month" })).toMatchObject({
      language: "zh",
      region: "cn",
      freshness: "month",
    });
  });

  it("a per-call override beats config and auto-detection", () => {
    // Override language wins over both config and the Chinese auto-detect.
    expect(
      resolveSearchLocale("灵异小说", { language: "fr", region: "fr" }, { language: "en", region: "us" }),
    ).toMatchObject({ language: "en", region: "us" });
    // Override freshness wins over config freshness.
    expect(
      resolveSearchLocale("rust", { freshness: "year" }, { freshness: "day" }),
    ).toMatchObject({ freshness: "day" });
  });

  it("an override of region alone disables CJK auto-detect (no silent language)", () => {
    const loc = resolveSearchLocale("灵异小说", undefined, { region: "sg" });
    expect(loc.region).toBe("sg");
    expect(loc.language).toBeUndefined();
  });
});

describe("webSearchTool locale params on the wire", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("anchors a Chinese query on Brave (search_lang/country)", async () => {
    let seen = "";
    vi.stubGlobal("fetch", async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    });
    await webSearchTool.execute(
      { query: "灵异搞笑小说 起点 番茄 推荐 2024 2025 热门" },
      ctx({ webSearch: { provider: "brave", apiKey: "bk" } }),
    );
    expect(seen).toContain("search_lang=zh");
    expect(seen).toContain("country=cn");
  });

  it("maps config freshness to the Brave freshness token", async () => {
    let seen = "";
    vi.stubGlobal("fetch", async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    });
    await webSearchTool.execute(
      { query: "rust release notes" },
      ctx({ webSearch: { provider: "brave", apiKey: "bk", freshness: "year" } }),
    );
    expect(seen).toContain("freshness=py");
  });

  it("sends lr/hl/gl to Google CSE for a Chinese query", async () => {
    let seen = "";
    vi.stubGlobal("fetch", async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    await webSearchTool.execute(
      { query: "灵异小说推荐" },
      ctx({ webSearch: { provider: "google", apiKey: "gk", cx: "cx1" } }),
    );
    expect(seen).toContain("lr=lang_zh");
    expect(seen).toContain("hl=zh");
    expect(seen).toContain("gl=cn");
  });

  it("does NOT add locale params for a Latin query (unchanged behaviour)", async () => {
    let seen = "";
    vi.stubGlobal("fetch", async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    });
    await webSearchTool.execute(
      { query: "typescript generics" },
      ctx({ webSearch: { provider: "brave", apiKey: "bk" } }),
    );
    expect(seen).not.toContain("search_lang");
    expect(seen).not.toContain("country");
  });

  it("applies per-call tool params (language/region/freshness) over auto-detect", async () => {
    let seen = "";
    vi.stubGlobal("fetch", async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    });
    // A Latin query that would normally be unconstrained, forced to zh/cn + day.
    await webSearchTool.execute(
      { query: "ghost comedy novels", language: "zh", region: "cn", freshness: "day" },
      ctx({ webSearch: { provider: "brave", apiKey: "bk" } }),
    );
    expect(seen).toContain("search_lang=zh");
    expect(seen).toContain("country=cn");
    expect(seen).toContain("freshness=pd");
  });

  it("a per-call language overrides a Chinese query's auto-detect", async () => {
    let seen = "";
    vi.stubGlobal("fetch", async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    });
    await webSearchTool.execute(
      { query: "灵异搞笑小说 推荐", language: "en", region: "us" },
      ctx({ webSearch: { provider: "brave", apiKey: "bk" } }),
    );
    expect(seen).toContain("search_lang=en");
    expect(seen).toContain("country=us");
  });

  it("tags the output header with the active locale", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ web: { results: [{ title: "T", url: "https://x.io", description: "d" }] } }),
        { status: 200 },
      ),
    );
    const r = await webSearchTool.execute(
      { query: "灵异小说" },
      ctx({ webSearch: { provider: "brave", apiKey: "bk" } }),
    );
    expect(r.content).toContain("[zh-cn]");
  });
});

describe("webSearchTool backends", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("parses Brave JSON and sends the subscription-token header", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(
        JSON.stringify({
          web: { results: [{ title: "Brave Hit", url: "https://ex.com", description: "desc" }] },
        }),
        { status: 200 },
      );
    });

    const r = await webSearchTool.execute(
      { query: "rust async" },
      ctx({ webSearch: { provider: "brave", apiKey: "bk" } }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("via brave");
    expect(r.content).toContain("Brave Hit");
    expect(r.content).toContain("https://ex.com");
    expect(seen?.url).toContain("api.search.brave.com");
    expect(seen?.headers["x-subscription-token"]).toBe("bk");
  });

  it("parses Serper JSON (POST with x-api-key)", async () => {
    let method: string | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      method = init.method;
      return new Response(
        JSON.stringify({ organic: [{ title: "S", link: "https://s.io", snippet: "snip" }] }),
        { status: 200 },
      );
    });
    const r = await webSearchTool.execute(
      { query: "q" },
      ctx({ webSearch: { provider: "serper", apiKey: "sk" } }),
    );
    expect(method).toBe("POST");
    expect(r.content).toContain("https://s.io");
    expect(r.content).toContain("via serper");
  });

  it("parses Google CSE JSON and requires a cx", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ items: [{ title: "G", link: "https://g.co", snippet: "x" }] }), {
        status: 200,
      }),
    );
    const ok = await webSearchTool.execute(
      { query: "q" },
      ctx({ webSearch: { provider: "google", apiKey: "gk", cx: "cx1" } }),
    );
    expect(ok.content).toContain("https://g.co");

    const missing = await webSearchTool.execute(
      { query: "q" },
      ctx({ webSearch: { provider: "google", apiKey: "gk" } }),
    );
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("CSE id");
  });

  it("returns an explicit error (not silent) when a backend has no key", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const r = await webSearchTool.execute(
      { query: "q" },
      ctx({ webSearch: { provider: "brave" } }), // no key in config or env
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("missing API key");
  });

  it("surfaces an HTTP error from the backend", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 429 }));
    const r = await webSearchTool.execute(
      { query: "q" },
      ctx({ webSearch: { provider: "brave", apiKey: "bk" } }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("HTTP 429");
  });

  it("falls back to DuckDuckGo scraping when no backend is configured", async () => {
    // Hermetic: a real backend key in the ambient env must not hijack the
    // default path.
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("SERPER_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("GOOGLE_CSE_ID", "");
    let url: string | undefined;
    vi.stubGlobal("fetch", async (u: string) => {
      url = u;
      return new Response(
        `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://d.dev")}">DDG Title</a>` +
          `<a class="result__snippet">a snippet</a>`,
        { status: 200 },
      );
    });
    const r = await webSearchTool.execute({ query: "q" }, ctx());
    expect(url).toContain("html.duckduckgo.com");
    expect(r.content).toContain("DDG Title");
    expect(r.content).toContain("https://d.dev");
    expect(r.content).not.toContain("via"); // DDG default shows no "(via …)"
  });

  it("custom GET: fills url placeholders, interpolates ${ENV} headers, maps nested results", async () => {
    vi.stubEnv("MY_SEARCH_KEY", "secret-123");
    let seen: { url: string; headers: Record<string, string>; method?: string } | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, method: init.method };
      return new Response(
        JSON.stringify({ data: { items: [{ name: "Hit One", link: "https://c.dev/a", desc: "a snip" }] } }),
        { status: 200 },
      );
    });
    const r = await webSearchTool.execute(
      { query: "rust async" },
      ctx({
        webSearch: {
          provider: "custom",
          custom: {
            url: "https://api.example.com/s?q={query}&n={max}",
            headers: { Authorization: "Bearer ${MY_SEARCH_KEY}" },
            resultsPath: "data.items",
            fields: { title: "name", url: "link", snippet: "desc" },
          },
        },
      }),
    );
    expect(r.isError).toBeFalsy();
    expect(seen?.method ?? "GET").toBe("GET");
    expect(seen?.url).toBe("https://api.example.com/s?q=rust%20async&n=8");
    expect(seen?.headers.Authorization).toBe("Bearer secret-123");
    expect(r.content).toContain("via custom");
    expect(r.content).toContain("Hit One");
    expect(r.content).toContain("https://c.dev/a");
  });

  it("custom POST: fills body placeholders and reads a root-array response", async () => {
    let body: string | undefined;
    let method: string | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = init.body as string;
      method = init.method;
      return new Response(
        JSON.stringify([{ title: "P", url: "https://p.io", snippet: "s" }]),
        { status: 200 },
      );
    });
    const r = await webSearchTool.execute(
      { query: 'he said "hi"' },
      ctx({
        webSearch: {
          provider: "custom",
          custom: {
            method: "POST",
            url: "https://api.example.com/s",
            body: '{"q":"{query}","n":{max}}',
          },
        },
      }),
    );
    expect(method).toBe("POST");
    // The query is JSON-escaped inside the body (quotes preserved as valid JSON).
    expect(JSON.parse(body!)).toEqual({ q: 'he said "hi"', n: 8 });
    expect(r.content).toContain("https://p.io");
  });

  it("custom: explicit error when the results array is missing", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    const r = await webSearchTool.execute(
      { query: "q" },
      ctx({ webSearch: { provider: "custom", custom: { url: "https://x/s", resultsPath: "data.items" } } }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no results array");
  });

  it("falls back to Bing HTML when DuckDuckGo is unreachable", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("SERPER_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("GOOGLE_CSE_ID", "");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      urls.push(u);
      if (u.includes("duckduckgo")) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: new Error("Connect Timeout Error"),
        });
      }
      return new Response(
        `<li class="b_algo"><h2><a href="https://b.dev/page">Bing Title</a></h2><p>bing snip</p></li>`,
        { status: 200 },
      );
    });
    const r = await webSearchTool.execute({ query: "q" }, ctx());
    expect(r.isError).toBeFalsy();
    expect(urls.some((u) => u.includes("duckduckgo"))).toBe(true);
    expect(urls.some((u) => u.includes("bing.com"))).toBe(true);
    expect(r.content).toContain("Bing Title");
    expect(r.content).toContain("https://b.dev/page");
  });
});
