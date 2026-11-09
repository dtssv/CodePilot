// Search-engine catalog: a list of ready-made web_search backends (GitHub JSON
// + daily cache + bundled seed), each a `custom` HTTP template so any JSON
// search API can be configured by picking it from the catalog instead of
// hand-writing the template. Mirrors providerCatalog.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CustomSearchTemplate } from "./types.js";
import { loadCatalogDocument } from "./remoteCatalog.js";

/** One catalog entry: a named, ready-to-use custom search backend. */
export interface SearchEngineTemplate {
  /** Stable id, e.g. `brave`, `serper`, `searxng`. */
  id: string;
  displayName: string;
  /** One-line hint shown in the settings / setup UI. */
  description?: string;
  /** Where to obtain an API key, if any. */
  signupUrl?: string;
  /** True when the engine needs an API key (surfaced as a key field in UI). */
  needsKey?: boolean;
  /** Conventional env var holding the key, interpolated into the template. */
  keyEnvVar?: string;
  /** The HTTP template written to `webSearch.custom` when this engine is chosen. */
  template: CustomSearchTemplate;
}

interface SearchEnginesDoc {
  version?: number;
  updatedAt?: string;
  engines?: SearchEngineTemplate[];
}

function bundledSearchEngines(): SearchEngineTemplate[] {
  try {
    const path = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "catalog",
      "search-engines.json",
    );
    const doc = JSON.parse(readFileSync(path, "utf-8")) as SearchEnginesDoc;
    return Array.isArray(doc.engines) ? doc.engines : [];
  } catch {
    return [];
  }
}

/** Offline / boot fallback (bundled JSON). Prefer {@link listSearchEngines}. */
export const SEARCH_ENGINES: readonly SearchEngineTemplate[] = bundledSearchEngines();

function mergeEngines(
  base: readonly SearchEngineTemplate[],
  overlay: SearchEngineTemplate[],
): SearchEngineTemplate[] {
  const map = new Map<string, SearchEngineTemplate>();
  for (const e of base) map.set(e.id, e);
  for (const e of overlay) {
    if (e?.id) map.set(e.id, e);
  }
  return [...map.values()];
}

/**
 * GitHub catalog (update once per day; keep local forever on failure). Returns
 * the bundled seed merged with the remote list so a picker always has options
 * even offline.
 */
export async function listSearchEngines(opts?: { force?: boolean }): Promise<SearchEngineTemplate[]> {
  try {
    const { data } = await loadCatalogDocument<SearchEnginesDoc>("search-engines", opts);
    const remote = Array.isArray(data.engines) ? data.engines : [];
    return mergeEngines(SEARCH_ENGINES, remote);
  } catch {
    return [...SEARCH_ENGINES];
  }
}
