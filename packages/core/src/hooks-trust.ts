// Hook trust mechanism: hash-based review before running side-effecting hooks.
//
// Two hook handler types reach arbitrary, config-specified targets:
//   - `command` runs any shell code;
//   - `http`    POSTs the hook payload (tool inputs, prompts) to any URL and
//               lets the response block/rewrite the action.
// Both are as attacker-controllable as the config that declares them, so both
// require the user to approve each unique *trust subject* (identified by its
// SHA-256 hash) before running. Approved hashes persist to
// `.codepilot/hook_trust.json`; unapproved hooks are skipped with a warning
// (fail-safe: don't run untrusted side effects).
//
// `mcp_tool`/`prompt`/`agent` handlers are exempt: they delegate to
// infrastructure already vetted elsewhere (MCP servers approved at connect
// time, the session's own small model, the curated sub-agent registry) rather
// than to an arbitrary command or URL — see `hooks-handlers.ts`.

import { createHash } from "node:crypto";
import type { HookEntry } from "./hooks.js";

/** Compute the SHA-256 hash of a trust subject (command string or http target). */
export function hashCommand(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

/**
 * The canonical string a hook is trusted *as*. Command hooks are trusted by
 * their exact command; http hooks by their method+URL+sorted headers (headers
 * matter — they can carry an auth token or redirect intent). Returns null for
 * handler types that don't require trust. Keeping this in one place means
 * `isTrusted`, approval, and UI display all agree on what gets hashed.
 */
export function trustSubject(hook: HookEntry): string | null {
  if (hook.command) return hook.command;
  if (hook.http) {
    const headers = hook.httpHeaders ?? {};
    const headerPart = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${headers[k]}`)
      .join("\n");
    return `http POST ${hook.http}${headerPart ? `\n${headerPart}` : ""}`;
  }
  return null;
}

/**
 * Manages the set of approved command hashes, persisted to a JSON file.
 *
 * The store is loaded lazily: `load` reads the file, `isTrusted`
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

 /** Check if a side-effecting hook (command or http) is trusted (its subject
 * hash is approved). Returns true when trust is not configured
 * (backwards-compatible default) or for handler types that don't require
 * trust (mcp_tool/prompt/agent). */
  isTrusted(hook: HookEntry): boolean {
    const subject = trustSubject(hook);
    if (subject === null) return true; // handler type requires no trust
    if (!this.hashes) return true; // trust not configured
    return this.hashes.has(hashCommand(subject));
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
