import type { CustomSearchTemplate, WebSearchConfig, WebSearchProvider } from "../../types.js";
import type { SearchLocale } from "./types.js";

/** Conventional env var holding each backend's API key. */
const ENV_KEY: Record<"brave" | "serper" | "google", string> = {
  brave: "BRAVE_API_KEY",
  serper: "SERPER_API_KEY",
  google: "GOOGLE_API_KEY",
};

/** Resolve the backend + credentials from config and env. */
export function resolveSearchBackend(
  cfg: WebSearchConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): {
  provider: WebSearchProvider;
  apiKey?: string;
  cx?: string;
  endpoint?: string;
  engineId?: string;
  env?: Record<string, string>;
  custom?: CustomSearchTemplate;
} {
  // Explicit provider wins; its key comes from config or the conventional env.
  if (cfg?.provider) {
    if (cfg.provider === "custom") {
      return {
        provider: "custom",
        apiKey: cfg.apiKey,
        endpoint: cfg.endpoint,
        engineId: cfg.engineId,
        env: cfg.env,
        custom: cfg.custom,
      };
    }
    const apiKey =
      cfg.apiKey ?? (cfg.provider === "duckduckgo" ? undefined : env[ENV_KEY[cfg.provider]]);
    return { provider: cfg.provider, apiKey, cx: cfg.cx ?? env.GOOGLE_CSE_ID, endpoint: cfg.endpoint };
  }
  // Auto: pick the first backend that has a key available, else DuckDuckGo.
  if (cfg?.apiKey) return { provider: "brave", apiKey: cfg.apiKey, endpoint: cfg.endpoint };
  if (env.BRAVE_API_KEY) return { provider: "brave", apiKey: env.BRAVE_API_KEY };
  if (env.SERPER_API_KEY) return { provider: "serper", apiKey: env.SERPER_API_KEY };
  if (env.GOOGLE_API_KEY && env.GOOGLE_CSE_ID)
    return { provider: "google", apiKey: env.GOOGLE_API_KEY, cx: env.GOOGLE_CSE_ID };
  return { provider: "duckduckgo" };
}

export type ResolvedSearchBackend = ReturnType<typeof resolveSearchBackend>;

/**
 * Auto-mode fallback chain (explicit `webSearch.provider` skips this).
 * Order: brave → serper → google → duckduckgo.
 */
export function listAutoSearchBackends(
  cfg: WebSearchConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSearchBackend[] {
  if (cfg?.provider) return [resolveSearchBackend(cfg, env)];
  const out: ResolvedSearchBackend[] = [];
  const seen = new Set<string>();
  const push = (b: ResolvedSearchBackend): void => {
    const key = `${b.provider}:${b.apiKey ?? ""}:${b.cx ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(b);
  };
  if (cfg?.apiKey || env.BRAVE_API_KEY) {
    push({
      provider: "brave",
      apiKey: cfg?.apiKey ?? env.BRAVE_API_KEY,
      endpoint: cfg?.endpoint,
    });
  }
  if (env.SERPER_API_KEY) push({ provider: "serper", apiKey: env.SERPER_API_KEY });
  if (env.GOOGLE_API_KEY && env.GOOGLE_CSE_ID) {
    push({ provider: "google", apiKey: env.GOOGLE_API_KEY, cx: env.GOOGLE_CSE_ID });
  }
  push({ provider: "duckduckgo" });
  return out.length > 0 ? out : [{ provider: "duckduckgo" }];
}

/** True when an error looks like auth / rate-limit / server fault worth trying next backend. */
export function isRetriableSearchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(401|403|429|500|502|503|504)\b|rate.?limit|unauthorized|forbidden|quota/i.test(msg);
}

/**
 * Decide the effective locale for a query, with a three-tier priority:
 *   per-call `overrides` (tool input) > `webSearch` config > script auto-detect.
 */
export function resolveSearchLocale(
  query: string,
  cfg: WebSearchConfig | undefined,
  overrides?: { language?: string; region?: string; freshness?: SearchLocale["freshness"] },
): SearchLocale {
  const freshness = overrides?.freshness ?? cfg?.freshness;
  const explicitLang = overrides?.language ?? cfg?.language;
  const explicitRegion = overrides?.region ?? cfg?.region;
  if (explicitLang || explicitRegion) {
    return { language: explicitLang, region: explicitRegion, freshness };
  }
  // Kana/Hangul before Han: Japanese/Korean often mix kanji.
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query))
    return { language: "ja", region: "jp", freshness };
  if (/\p{Script=Hangul}/u.test(query)) return { language: "ko", region: "kr", freshness };
  if (/\p{Script=Han}/u.test(query)) return { language: "zh", region: "cn", freshness };
  return { freshness };
}

/** Google CSE `dateRestrict` token. */
export function googleDateRestrict(f: SearchLocale["freshness"]): string | undefined {
  switch (f) {
    case "day":
      return "d1";
    case "week":
      return "w1";
    case "month":
      return "m1";
    case "year":
      return "y1";
    default:
      return undefined;
  }
}

/** Serper/Google `tbs` recency token. */
export function serperTbs(f: SearchLocale["freshness"]): string | undefined {
  switch (f) {
    case "day":
      return "qdr:d";
    case "week":
      return "qdr:w";
    case "month":
      return "qdr:m";
    case "year":
      return "qdr:y";
    default:
      return undefined;
  }
}

/** Brave `freshness` token (p = past). */
export function braveFreshness(f: SearchLocale["freshness"]): string | undefined {
  switch (f) {
    case "day":
      return "pd";
    case "week":
      return "pw";
    case "month":
      return "pm";
    case "year":
      return "py";
    default:
      return undefined;
  }
}

/** DuckDuckGo/Bing HTML `df` recency token. */
export function htmlDf(f: SearchLocale["freshness"]): string | undefined {
  switch (f) {
    case "day":
      return "d";
    case "week":
      return "w";
    case "month":
      return "m";
    case "year":
      return "y";
    default:
      return undefined;
  }
}

/** DuckDuckGo `kl` region-language token, e.g. `cn-zh`. */
export function ddgKl(loc: SearchLocale): string | undefined {
  if (loc.region && loc.language) return `${loc.region.toLowerCase()}-${loc.language.toLowerCase()}`;
  if (loc.language) return `wt-${loc.language.toLowerCase()}`;
  return undefined;
}
