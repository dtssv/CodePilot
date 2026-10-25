/**
 * Remote catalogs (connectors, provider templates, …).
 *
 * - Serve from local cache forever when present (weak/offline safe).
 * - At most one update attempt per local calendar day.
 * - Failed update → keep previous cache (or bundled seed); do not clear it.
 *
 * Source: GitHub `catalog/*.json` (override with CODEPILOT_CATALOG_BASE_URL).
 * Disk: `~/.codepilot/catalog/`. Bundled offline copy: `packages/core/catalog/`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE =
  "https://raw.githubusercontent.com/dtssv/CodePilot/main/catalog";

export type CatalogName =
  | "connectors"
  | "provider-templates"
  | "mcp-markets"
  | "manifest";

export interface CacheFile<T> {
  /** Last time content was successfully replaced. */
  fetchedAt: number;
  /** Last network attempt (success or fail) — drives once-per-day retry. */
  lastAttemptAt: number;
  source: string;
  data: T;
}

const memory = new Map<string, CacheFile<unknown>>();

function catalogBaseUrl(): string {
  const env = process.env.CODEPILOT_CATALOG_BASE_URL?.trim();
  return (env && env.replace(/\/+$/, "")) || DEFAULT_BASE;
}

function cacheDir(): string {
  return join(homedir(), ".codepilot", "catalog");
}

function cachePath(name: CatalogName): string {
  return join(cacheDir(), `${name}.json`);
}

function bundledPath(name: CatalogName): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "catalog", `${name}.json`);
}

function fileName(name: CatalogName): string {
  return `${name}.json`;
}

function sameLocalDay(a: number, b = Date.now()): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** True when we should hit the network (no cache, or last attempt not today). */
export function shouldAttemptDailyUpdate(cache: { lastAttemptAt?: number; fetchedAt: number } | null): boolean {
  if (!cache) return true;
  const anchor = cache.lastAttemptAt ?? cache.fetchedAt;
  return !sameLocalDay(anchor);
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function writeCache<T>(
  name: CatalogName,
  source: string,
  data: T,
  times: { fetchedAt: number; lastAttemptAt: number },
): Promise<CacheFile<T>> {
  const envelope: CacheFile<T> = {
    fetchedAt: times.fetchedAt,
    lastAttemptAt: times.lastAttemptAt,
    source,
    data,
  };
  memory.set(name, envelope as CacheFile<unknown>);
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(cachePath(name), JSON.stringify(envelope, null, 2) + "\n", "utf-8");
  return envelope;
}

async function markAttemptOnly<T>(name: CatalogName, existing: CacheFile<T>): Promise<void> {
  const now = Date.now();
  await writeCache(name, existing.source, existing.data, {
    fetchedAt: existing.fetchedAt,
    lastAttemptAt: now,
  });
}

async function fetchRemoteJson(name: CatalogName): Promise<unknown | null> {
  const url = `${catalogBaseUrl()}/${fileName(name)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "CodePilot-catalog/1" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function readLocalCache<T>(name: CatalogName): Promise<CacheFile<T> | null> {
  const mem = memory.get(name) as CacheFile<T> | undefined;
  if (mem?.data != null) return mem;
  const disk = await readJsonFile<CacheFile<T>>(cachePath(name));
  if (disk?.data != null) {
    // Back-compat: older caches without lastAttemptAt
    if (typeof disk.lastAttemptAt !== "number") disk.lastAttemptAt = disk.fetchedAt;
    memory.set(name, disk as CacheFile<unknown>);
    return disk;
  }
  return null;
}

async function seedFromBundled<T>(name: CatalogName): Promise<CacheFile<T> | null> {
  const bundled = await readJsonFile<T>(bundledPath(name));
  if (bundled == null) return null;
  // fetchedAt=0 so the next load (or same load path) still attempts a remote update today.
  return writeCache(name, `bundled:${fileName(name)}`, bundled, {
    fetchedAt: 0,
    lastAttemptAt: 0,
  });
}

/**
 * Load catalog: always return local data when available.
 * Once per calendar day, try GitHub; on failure keep serving the old file.
 */
export async function loadCatalogDocument<T>(
  name: CatalogName,
  opts?: { force?: boolean },
): Promise<{ data: T; source: "memory" | "cache" | "remote" | "bundled" }> {
  const force = opts?.force === true;
  let local = await readLocalCache<T>(name);
  if (!local) {
    local = await seedFromBundled<T>(name);
  }

  const attempt = force || shouldAttemptDailyUpdate(local);
  if (attempt) {
    const remote = await fetchRemoteJson(name);
    if (remote != null) {
      const now = Date.now();
      await writeCache(name, `${catalogBaseUrl()}/${fileName(name)}`, remote as T, {
        fetchedAt: now,
        lastAttemptAt: now,
      });
      return { data: remote as T, source: "remote" };
    }
    if (local) {
      await markAttemptOnly(name, local);
    }
  }

  if (local?.data != null) {
    const src = local.source.startsWith("bundled:") ? "bundled" : "cache";
    return { data: local.data, source: memory.has(name) && src === "cache" ? "memory" : src };
  }

  throw new Error(`Catalog unavailable: ${name}`);
}

/** Force a network refresh today (still keeps old data if fetch fails). */
export async function refreshAllCatalogs(): Promise<{
  connectors: string;
  providers: string;
  markets: string;
}> {
  const c = await loadCatalogDocument("connectors", { force: true });
  const p = await loadCatalogDocument("provider-templates", { force: true });
  const m = await loadCatalogDocument("mcp-markets", { force: true });
  return { connectors: c.source, providers: p.source, markets: m.source };
}

export function resetCatalogMemoryForTests(): void {
  memory.clear();
}

export function catalogCacheExists(name: CatalogName): boolean {
  return existsSync(cachePath(name));
}
