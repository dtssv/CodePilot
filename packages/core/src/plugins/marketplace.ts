import type { MarketplaceEntry } from "./types.js";

/**
 * Fetch a marketplace index from a URL (JSON array or `{ plugins: [...] }`).
 * Simple HTTP GET. Callers should show the install `source` for consent
 * before installing (see {@link describeMarketplaceEntry}).
 */
export async function fetchMarketplaceIndex(url: string): Promise<MarketplaceEntry[]> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "CodePilot-plugins/1" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`marketplace index fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as unknown;
  return coercePluginIndex(data);
}

/** Normalise a fetched index into `MarketplaceEntry[]`. Accepts either a bare
 * array or a `{ plugins: [...] }` document (the shape of the bundled catalog).
 * Entries missing the required `name`/`source` are dropped, so one malformed
 * row never poisons the whole list. */
function coercePluginIndex(data: unknown): MarketplaceEntry[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { plugins?: unknown })?.plugins)
      ? (data as { plugins: unknown[] }).plugins
      : null;
  if (!rows) throw new Error("marketplace index is not an array or { plugins: [] }");
  const out: MarketplaceEntry[] = [];
  for (const r of rows) {
    const e = r as Partial<MarketplaceEntry>;
    if (typeof e.name !== "string" || typeof e.source !== "string") continue;
    out.push({
      name: e.name,
      description: typeof e.description === "string" ? e.description : "",
      source: e.source,
      version: typeof e.version === "string" ? e.version : undefined,
      author: typeof e.author === "string" ? e.author : undefined,
      tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : undefined,
    });
  }
  return out;
}

/**
 * The default plugin marketplace, served from the remote catalog with an
 * offline seed (degrades to the shipped list on failure). Pass
 * `{ force: true }` to refresh today.
 */
export async function listPluginMarket(opts?: { force?: boolean }): Promise<MarketplaceEntry[]> {
  try {
    const { loadCatalogDocument } = await import("../config/remoteCatalog.js");
    const { data } = await loadCatalogDocument<{ plugins?: unknown }>("plugins", opts);
    return coercePluginIndex(data);
  } catch {
    return [];
  }
}

/**
 * Search the marketplace index for entries matching a query. Matches
 * against name, description, and tags (case-insensitive substring).
 */
export function searchMarketplace(
  index: MarketplaceEntry[],
  query: string
): MarketplaceEntry[] {
  const q = query.toLowerCase();
  return index.filter((e) => {
    return (
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  });
}

/** A human-readable one-line summary of where a marketplace entry installs
 * FROM, for a confirmation prompt before install. Surfacing the source is the
 * trust gate: the index is third-party content, so the caller should show
 * this and get consent before `installPlugin(entry.source)`. */
export function describeMarketplaceEntry(entry: MarketplaceEntry): string {
  const kind = /^(https?:\/\/|git@)/.test(entry.source) ? "git" : "local path";
  const ver = entry.version ? ` v${entry.version}` : "";
  const by = entry.author ? ` by ${entry.author}` : "";
  return `${entry.name}${ver}${by} — installs from ${kind}: ${entry.source}`;
}