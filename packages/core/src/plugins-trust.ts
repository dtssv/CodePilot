// Plugin content-trust: hash-based re-approval gate. Hashes the sensitive
// manifest parts (hooks/mcp/runtime) at consent; on load, a mismatch skips
// hooks and MCP servers (fail-safe) until re-confirmed. skills/agents/commands
// are data, not gated. No recorded hash → not gated (legacy-compatible).

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { PluginManifest } from "./plugins.js";

/** Default trust-file path: `~/.codepilot/plugins/.trust.json`. */
export function defaultPluginTrustPath(): string {
  return join(homedir(), ".codepilot", "plugins", ".trust.json");
}

/**
 * Canonical content a plugin is trusted AS: only the sensitive manifest parts
 * (hooks, mcpServers, runtime). Keys are sorted for stable serialization.
 */
export function pluginContentHash(manifest: PluginManifest): string {
  const sensitive = {
    hooks: manifest.hooks ?? null,
    mcpServers: manifest.mcpServers ?? null,
    runtime: manifest.runtime ?? null,
  };
  return createHash("sha256").update(stableStringify(sensitive)).digest("hex");
}

/** Deterministic JSON stringify with sorted object keys (arrays keep order). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Persisted map of `pluginName → trusted sensitive-content hash`, written at
 * install-consent time and consulted on load. Fail-soft: a missing/corrupt file
 * loads as empty, and a missing entry means "never fingerprinted" (not gated).
 */
export class PluginTrustStore {
  private hashes: Map<string, string> | null = null;

  constructor(private readonly trustFile: string = defaultPluginTrustPath()) {}

  /** Load the trusted hashes. Safe to call repeatedly; re-reads the file. */
  async load(): Promise<void> {
    this.hashes = new Map();
    try {
      const text = await readFile(this.trustFile, "utf-8");
      const data = JSON.parse(text) as { plugins?: Record<string, string> };
      for (const [name, hash] of Object.entries(data.plugins ?? {})) {
        if (typeof hash === "string" && hash.length > 0) this.hashes.set(name, hash);
      }
    } catch {
      /* missing/corrupt → empty (fail-soft) */
    }
  }

  /** The recorded hash for a plugin, or null when none (never fingerprinted). */
  recorded(name: string): string | null {
    return this.hashes?.get(name) ?? null;
  }

  /**
   * Trusted if no recorded hash (legacy) or the recorded hash matches the
   * current content hash; false (needs re-confirmation) if they differ.
   */
  isTrusted(name: string, currentHash: string): boolean {
    const rec = this.hashes?.get(name);
    if (rec === undefined) return true;
    return rec === currentHash;
  }

  /** Record (or update) a plugin's trusted content hash and persist. Called at
   * install-consent and on explicit re-confirmation after a change. */
  async record(name: string, hash: string): Promise<void> {
    if (!this.hashes) await this.load();
    this.hashes!.set(name, hash);
    await this.persist();
  }

  /** Drop a plugin's recorded hash (e.g. on uninstall) and persist. */
  async forget(name: string): Promise<void> {
    if (!this.hashes) await this.load();
    if (this.hashes!.delete(name)) await this.persist();
  }

  private async persist(): Promise<void> {
    const plugins: Record<string, string> = {};
    for (const [name, hash] of this.hashes ?? []) plugins[name] = hash;
    await mkdir(dirname(this.trustFile), { recursive: true });
    await writeFile(this.trustFile, JSON.stringify({ plugins }, null, 2), "utf-8");
  }
}
