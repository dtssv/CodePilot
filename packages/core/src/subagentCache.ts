// Disk-backed, content-addressed cache of sub-agent conclusions, keyed by
// (objective + agentType + cwd + model). A cache hit makes a `task` fan-out
// return the stored conclusion instead of re-running, so it is idempotent and
// resumable. Best-effort: a missing/corrupt cache never blocks execution;
// entries older than the TTL (default 24h) are ignored.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CachedConclusion {
  ok: boolean;
  conclusion: string;
  steps: number;
  ts: number;
}

export interface SubagentCacheKey {
  objective: string;
  agentType?: string;
  cwd: string;
  model?: string;
}

/** Default max age for a reused conclusion. A crash-resume happens within
 * minutes/hours, so recent conclusions are safe to replay; but a repeat of the
 * same objective days later should re-run against the (possibly changed)
 * codebase rather than serve a stale answer. */
export const SUBAGENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Disk-backed, content-addressed cache of sub-agent conclusions. */
export class SubagentCache {
  private readonly dir: string;
  private readonly ttlMs: number;
  constructor(projectStateDir: string, ttlMs: number = SUBAGENT_CACHE_TTL_MS) {
    this.dir = join(projectStateDir, "subagent-cache");
    this.ttlMs = ttlMs > 0 ? ttlMs : SUBAGENT_CACHE_TTL_MS;
  }

  private hash(key: SubagentCacheKey): string {
    return createHash("sha256")
      .update(`${key.objective}\u0000${key.agentType ?? ""}\u0000${key.cwd}\u0000${key.model ?? ""}`)
      .digest("hex")
      .slice(0, 32);
  }

  private pathFor(key: SubagentCacheKey): string {
    return join(this.dir, `${this.hash(key)}.json`);
  }

  /** Return a cached SUCCESSFUL, NON-STALE conclusion, or null. Failures are
   * never cached (they should be retried); entries older than the TTL are
   * ignored so a resume replays recent work but a days-later repeat re-runs.
   * Read/parse errors are swallowed. */
  async get(key: SubagentCacheKey): Promise<CachedConclusion | null> {
    try {
      const raw = await readFile(this.pathFor(key), "utf-8");
      const entry = JSON.parse(raw) as CachedConclusion;
      if (!entry.ok) return null;
      if (typeof entry.ts !== "number" || Date.now() - entry.ts > this.ttlMs) return null;
      return entry;
    } catch {
      return null;
    }
  }

  /** Persist a successful conclusion. No-op for failures or on write error. */
  async put(key: SubagentCacheKey, value: CachedConclusion): Promise<void> {
    if (!value.ok) return;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.pathFor(key), JSON.stringify(value), "utf-8");
    } catch {
      /* best-effort */
    }
  }
}
