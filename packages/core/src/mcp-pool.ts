/**
 * Process-wide shared MCP managers.
 *
 * Session init used to `await npx …` on every resume — that made sidebar
 * clicks feel stuck for several seconds. Sessions now share one manager per
 * identical `mcpServers` config (ref-counted) and can start it in the
 * background without blocking resume.
 */

import { McpManager } from "./mcp.js";
import type { McpServerConfig } from "./types.js";
import type { McpTransportContext } from "./mcp-types.js";

interface PoolEntry {
  key: string;
  manager: McpManager;
  refs: number;
  /** In-flight start; waiters share the same promise. */
  ready: Promise<McpManager>;
}

const pool = new Map<string, PoolEntry>();

/** Stable key for an active servers map (order-independent). */
export function mcpServersKey(servers: Record<string, McpServerConfig>): string {
  const keys = Object.keys(servers).sort();
  const norm: Record<string, McpServerConfig> = {};
  for (const k of keys) norm[k] = servers[k]!;
  return JSON.stringify(norm);
}

/**
 * Acquire (or start) a shared manager for `servers`. Caller must
 * {@link releaseSharedMcp} exactly once when the session no longer needs it.
 */
export async function acquireSharedMcp(
  servers: Record<string, McpServerConfig>,
  ctx?: McpTransportContext,
): Promise<McpManager | null> {
  const names = Object.keys(servers);
  if (names.length === 0) return null;
  // Separate pools for auth vs no-auth so Settings OAuth / sessions with
  // openAuthUrl never reuse a headless manager that cannot authorize.
  const authTag = ctx?.openAuthUrl ? ":auth" : ":noauth";
  const key = mcpServersKey(servers) + authTag;
  const existing = pool.get(key);
  if (existing) {
    existing.refs += 1;
    return existing.ready;
  }

  const manager = new McpManager(servers, ctx);
  const ready = manager.startAll().then(() => manager);
  const entry: PoolEntry = { key, manager, refs: 1, ready };
  pool.set(key, entry);
  try {
    return await ready;
  } catch (err) {
 // startAll already swallows per-server errors; this is unexpected.
    pool.delete(key);
    throw err;
  }
}

/** Drop one ref; stop the manager when the last session releases it. */
export async function releaseSharedMcp(manager: McpManager | null): Promise<void> {
  if (!manager) return;
  for (const [key, entry] of pool) {
    if (entry.manager !== manager) continue;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    pool.delete(key);
    try {
      await entry.manager.stopAll();
    } catch {
 /* ignore */
    }
    return;
  }
 // Not pooled (tests / legacy) — stop directly.
  try {
    await manager.stopAll();
  } catch {
 /* ignore */
  }
}

/** Test helper. */
export function resetMcpPoolForTests(): void {
  pool.clear();
}
