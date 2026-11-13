// Trust-on-first-use gate for PROJECT-sourced MCP servers. A server defined in a
// project file (`<cwd>/.codepilot/config.json` or `<cwd>/.mcp.json`) can ship an
// arbitrary command alongside someone else's code, so it must be approved before
// it is ever launched. User-level / managed servers are the user's own and are
// not gated here.
//
// Model mirrors plugin/hook content-trust (a persisted fingerprint file), but
// with INVERTED defaults: a server with no recorded hash is UNTRUSTED (must be
// approved), and a hash mismatch means the config changed since approval (must
// be re-approved). Fail-soft only in the I/O sense (a missing/corrupt store
// loads as empty = nothing trusted yet), never fail-open.

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Fallback trust-file path: `~/.codepilot/mcp-trust.json`. The Session passes a
 * per-project path instead (approval in one repo must not trust a same-named
 * server in another); this default is only for direct/standalone consumers. */
export function defaultMcpTrustPath(): string {
  return join(homedir(), ".codepilot", "mcp-trust.json");
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
 * Hash the security-sensitive parts of a server config: what is executed and
 * with what. `disabled` and purely cosmetic fields do not change what the
 * server can do, so they are excluded — toggling `disabled` must not force
 * re-approval, but changing the command/args/env/url must.
 */
export function mcpServerConfigHash(cfg: unknown): string {
  const c = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
  const sensitive = {
    command: c.command ?? null,
    args: c.args ?? null,
    env: c.env ?? null,
    url: c.url ?? null,
    type: c.type ?? null,
  };
  return createHash("sha256").update(stableStringify(sensitive)).digest("hex");
}

/**
 * Persisted map of `serverName → approved config hash`. A project-sourced
 * server is launched only when its current config hash is recorded here.
 */
export class McpTrustStore {
  private hashes: Map<string, string> | null = null;

  constructor(private readonly trustFile: string = defaultMcpTrustPath()) {}

  /** Load the trusted hashes. Safe to call repeatedly; re-reads the file. */
  async load(): Promise<void> {
    this.hashes = new Map();
    try {
      const text = await readFile(this.trustFile, "utf-8");
      const data = JSON.parse(text) as { servers?: Record<string, string> };
      for (const [name, hash] of Object.entries(data.servers ?? {})) {
        if (typeof hash === "string" && hash.length > 0) this.hashes.set(name, hash);
      }
    } catch {
      /* missing/corrupt → empty (nothing trusted yet; never fail-open) */
    }
  }

  /**
   * Trusted iff the server has a recorded hash AND it matches the current
   * config hash. No record → not trusted (needs first-run approval); a
   * mismatch → not trusted (config changed since approval).
   */
  isTrusted(name: string, currentHash: string): boolean {
    return this.hashes?.get(name) === currentHash;
  }

  /** Record (or update) a server's approved config hash and persist. */
  async approve(name: string, hash: string): Promise<void> {
    if (!this.hashes) await this.load();
    this.hashes!.set(name, hash);
    await this.persist();
  }

  /** Drop a server's recorded hash (e.g. on removal) and persist. */
  async revoke(name: string): Promise<void> {
    if (!this.hashes) await this.load();
    if (this.hashes!.delete(name)) await this.persist();
  }

  private async persist(): Promise<void> {
    const servers: Record<string, string> = {};
    for (const [name, hash] of this.hashes ?? []) servers[name] = hash;
    await mkdir(dirname(this.trustFile), { recursive: true });
    await writeFile(this.trustFile, JSON.stringify({ servers }, null, 2), "utf-8");
  }
}

/** A project-sourced MCP server and whether it is currently approved to launch.
 * `summary` is a short, secret-free description for display. */
export interface ProjectMcpServer {
  name: string;
  summary: string;
  trusted: boolean;
}

/** Short, secret-free one-line summary of a server config (command/args or url). */
function summarizeServer(cfg: Record<string, unknown>): string {
  if (typeof cfg.url === "string" && cfg.url.trim()) {
    const typ = typeof cfg.type === "string" ? cfg.type : "http";
    return `${typ} · ${cfg.url}`;
  }
  const cmd = typeof cfg.command === "string" ? cfg.command : "";
  const args = Array.isArray(cfg.args)
    ? (cfg.args as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const line = [cmd, ...args].filter(Boolean).join(" ").trim();
  return line || (typeof cfg.type === "string" ? cfg.type : "stdio");
}

/** List PROJECT-sourced MCP servers (from `<cwd>/.codepilot/config.json` and
 * `<cwd>/.mcp.json`) with their current approval status. `projectNames` is the
 * set of project-sourced server names; `effective` is the merged/effective
 * config map used both to hash (for the trust check) and to summarize. */
export async function listProjectMcpServers(
  projectNames: Set<string>,
  effective: Record<string, Record<string, unknown>>,
  trustFile: string,
): Promise<ProjectMcpServer[]> {
  const store = new McpTrustStore(trustFile);
  await store.load();
  const out: ProjectMcpServer[] = [];
  for (const name of projectNames) {
    const cfg = effective[name];
    if (!cfg || typeof cfg !== "object") continue;
    out.push({
      name,
      summary: summarizeServer(cfg),
      trusted: store.isTrusted(name, mcpServerConfigHash(cfg)),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Approve a project-sourced MCP server at its CURRENT effective config, so it
 * may launch. Records the config hash; a later command change re-closes the
 * gate. Throws if the server is not actually project-sourced (nothing to gate)
 * so a caller cannot accidentally "approve" a user-level server into the store. */
export async function approveProjectMcpServer(
  name: string,
  projectNames: Set<string>,
  effective: Record<string, Record<string, unknown>>,
  trustFile: string,
): Promise<void> {
  if (!projectNames.has(name)) {
    throw new Error(`MCP server "${name}" is not defined in a project file`);
  }
  const cfg = effective[name];
  if (!cfg || typeof cfg !== "object") {
    throw new Error(`MCP server "${name}" has no resolved config`);
  }
  const store = new McpTrustStore(trustFile);
  await store.approve(name, mcpServerConfigHash(cfg));
}
