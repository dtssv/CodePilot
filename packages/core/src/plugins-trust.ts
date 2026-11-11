// Plugin content-trust: a hash-based re-approval gate for a plugin's sensitive
// on-disk content (hooks / MCP servers / runtime) AFTER it was installed and
// consented to.
//
// Why this exists
// ---------------
// Install already asks for consent: `inspectPluginSource` builds a capability
// report and the marketplace index is shown before `installPlugin`. What that
// one-time consent does NOT cover is a plugin whose content is CHANGED on disk
// afterwards — a later edit (or a repo pull) could swap a hook's command or an
// MCP server's spawn target without the user ever re-approving. The sensitive
// components run code / spawn processes, so a silent identity swap there is the
// risk.
//
// Mechanism
// ---------
// We hash only the sensitive parts of the manifest (hooks, mcpServers, runtime)
// and record that hash at install-consent time in a small trust file. On load,
// `mergePluginConfig` re-hashes the current content; if a plugin has a recorded
// hash that no longer matches, its hooks and MCP servers are SKIPPED (fail-safe)
// with a warning until the user re-confirms (which re-records the new hash).
//
// Scope and defaults
// ------------------
// - Only hooks / mcp / runtime are fingerprinted — the capability-bearing
//   components. Skills / agents / commands are data read elsewhere and are not
//   gated here.
// - A plugin with NO recorded hash is treated as un-fingerprinted (legacy /
//   never consented through this path): it is NOT gated, preserving existing
//   behaviour. The gate only ever REVOKES trust for content that drifted from a
//   recorded baseline — it never newly blocks a plugin that was fine before.

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
 * The canonical content a plugin is trusted AS: only the sensitive,
 * code/process-bearing parts of its manifest (hooks, mcpServers, runtime).
 * A change to any of them changes the fingerprint; a change to skills/agents/
 * commands/description does not (those are gated or inert elsewhere).
 *
 * Keys are sorted so the serialization is stable regardless of manifest key
 * order on disk.
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
   * Whether a plugin's sensitive content is trusted:
   * - no recorded hash → true (un-fingerprinted; not gated, legacy-compatible).
   * - recorded hash matches the current content hash → true.
   * - recorded hash differs → false (content drifted; re-confirmation needed).
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
