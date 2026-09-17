// Hook trust mechanism (codex-style hash-based review).
//
// Arbitrary `command` hooks can execute any shell code. The trust mechanism
// requires the user to approve each unique command string (identified by its
// SHA-256 hash) before it runs. Approved hashes are persisted to
// `.codepilot/hook_trust.json`. Unapproved hooks are skipped with a warning
// (fail-safe: don't execute untrusted code).
//
// `http`/`mcp_tool`/`prompt`/`agent` handlers are exempt (they delegate to
// already-vetted infrastructure, not arbitrary shell code) — see
// `hooks-handlers.ts`.

import { createHash } from "node:crypto";
import type { HookEntry } from "./hooks.js";

/** Compute the SHA-256 hash of a command string (for hook trust). */
export function hashCommand(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

/**
 * Manages the set of approved command hashes, persisted to a JSON file.
 *
 * The store is loaded lazily: `load()` reads the file, `isTrusted()`
 * returns `true` for non-command hooks and when no trust file is configured
 * (backwards-compatible default — trust is opt-in).
 */
export class HookTrustStore {
  private hashes: Set<string> | null = null;

  constructor(private readonly trustFile: string | null = null) {}

  /** Load approved hook hashes from the trust file. */
  async load(): Promise<void> {
    if (!this.trustFile) {
      this.hashes = new Set();
      return;
    }
    try {
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(this.trustFile, "utf-8");
      const data = JSON.parse(text) as { approved?: string[] };
      this.hashes = new Set(data.approved ?? []);
    } catch {
      this.hashes = new Set();
    }
  }

  /** Check if a command hook is trusted (hash approved). Returns true when
   *  trust is not configured (backwards-compatible default) or for
   *  non-command hooks. */
  isTrusted(hook: HookEntry): boolean {
    // Non-command hooks are always trusted.
    if (!hook.command) return true;
    if (!this.hashes) return true; // trust not configured
    return this.hashes.has(hashCommand(hook.command));
  }

  /** Approve a command hook's hash and persist to the trust file. */
  async approve(command: string): Promise<void> {
    if (!this.trustFile) return;
    if (!this.hashes) this.hashes = new Set();
    this.hashes.add(hashCommand(command));
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(this.trustFile), { recursive: true });
      await writeFile(
        this.trustFile,
        JSON.stringify({ approved: [...this.hashes] }, null, 2),
        "utf-8",
      );
    } catch {
      /* best-effort persistence */
    }
  }

  /** Get the set of approved command hashes (for UI display). */
  getApproved(): Set<string> {
    return this.hashes ?? new Set();
  }
}
