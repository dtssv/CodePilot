// web_search backend selection + per-backend request shaping (fetch stubbed).

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSearchBackend, webSearchTool } from "../src/tools/web_search.js";
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
