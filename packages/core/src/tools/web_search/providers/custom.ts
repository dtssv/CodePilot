import type { CustomSearchTemplate } from "../../../types.js";
import { htmlToText } from "../../web_fetch.js";
import type { SearchHit, SearchLocale } from "../types.js";

/**
 * Resolve `${ENV}` references against process env, then optional `fallbacks`
 * (from `webSearch.env`), then `storedKey` (`webSearch.apiKey`) as a
 * last-resort fill so a pasted key satisfies a catalog template's
 * conventional env var without exporting it in the shell.
 */
export function interpolateEnv(
  s: string,
  env: NodeJS.ProcessEnv = process.env,
  opts?: { fallbacks?: Record<string, string>; storedKey?: string },
): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name: string) => {
    const fromEnv = env[name];
    if (fromEnv) return fromEnv;
    const fromCfg = opts?.fallbacks?.[name];
    if (fromCfg) return fromCfg;
    return opts?.storedKey ?? "";
  });
}

/**
 * Substitute `{query}`/`{max}`/`{language}`/`{region}` placeholders. When
 * `encode` is true (URLs) each value is URL-encoded; otherwise (JSON bodies)
 * it is JSON-escaped so the result stays valid JSON.
 */
export function fillPlaceholders(
  template: string,
  values: { query: string; max: number; language?: string; region?: string },
  encode: boolean,
): string {
  const enc = (v: string): string => {
    if (encode) return encodeURIComponent(v);
    const j = JSON.stringify(v);
    return j.slice(1, j.length - 1);
  };
  return template
    .replace(/\{query\}/g, enc(values.query))
    .replace(/\{max\}/g, String(values.max))
    .replace(/\{language\}/g, enc(values.language ?? ""))
    .replace(/\{region\}/g, enc(values.region ?? ""));
}

/** Follow a dot-path (e.g. `data.items`) into a JSON value; undefined if absent. */
export function dotPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Collect unique `${ENV}` names referenced by a custom search template. */
export function listTemplateEnvVars(tpl: CustomSearchTemplate | undefined): string[] {
  if (!tpl) return [];
  const chunks = [tpl.url, tpl.body, ...Object.values(tpl.headers ?? {})];
  const found = new Set<string>();
  for (const chunk of chunks) {
    if (!chunk) continue;
    for (const m of chunk.matchAll(/\$\{([A-Z0-9_]+)\}/gi)) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found];
}

export async function customSearch(
  query: string,
  max: number,
  tpl: CustomSearchTemplate | undefined,
  locale: SearchLocale,
  signal: AbortSignal,
  opts?: { storedKey?: string; env?: Record<string, string> },
): Promise<SearchHit[]> {
  if (!tpl?.url) {
    throw new Error("missing webSearch.custom.url (define the custom search template)");
  }
  const values = { query, max, language: locale.language, region: locale.region };
  const interp = (s: string, encode: boolean): string =>
    interpolateEnv(fillPlaceholders(s, values, encode), process.env, {
      fallbacks: opts?.env,
      storedKey: opts?.storedKey,
    });
  const url = interp(tpl.url, true);
  const method = tpl.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [k, v] of Object.entries(tpl.headers ?? {})) {
    headers[k] = interp(v, true);
  }
  const body =
    method === "POST" && tpl.body !== undefined ? interp(tpl.body, false) : undefined;
  const res = await fetch(url, { method, signal, headers, body });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as unknown;
  const arr = dotPath(json, tpl.resultsPath);
  if (!Array.isArray(arr)) {
    const where = tpl.resultsPath ? `at "${tpl.resultsPath}"` : "(response root)";
    throw new Error(`custom search: no results array ${where}`);
  }
  const f = {
    title: tpl.fields?.title ?? "title",
    url: tpl.fields?.url ?? "url",
    snippet: tpl.fields?.snippet ?? "snippet",
  };
  return arr.map((r) => ({
    title: htmlToText(String(dotPath(r, f.title) ?? "")),
    url: String(dotPath(r, f.url) ?? ""),
    snippet: htmlToText(String(dotPath(r, f.snippet) ?? "")),
  }));
}
