// Custom sub-agent discovery and loading (claude-code `.claude/agents/` equivalent).
//
// A custom agent is a Markdown file with YAML frontmatter. The frontmatter
// declares the agent's identity, tool allowlist, model, and behaviour; the
// markdown body is the agent's system-prompt supplement (appended to the
// shared static prefix when the agent runs).
//
// Discovery sources (highest priority first, mirroring claude-code):
//   1. <cwd>/.codepilot/agents/*.md       (project-local, committed to the repo)
//   2. ~/.codepilot/agents/*.md           (user-global)
//
// Frontmatter fields (all optional except `name` and `description`):
//   name         string   required — unique identifier, lowercase + hyphens
//   description  string   required — the routing signal; the parent agent reads
//                                   this to decide when to delegate to this agent
//   tools        string[] optional — allowlist of tool names; inherits all
//                                   available sub-agent tools when omitted
//   disallowedTools string[] — denylist, applied after the allowlist
//   model        string   optional — "sonnet" | "opus" | "haiku" | full model id | "inherit"
//   maxTurns     number   optional — max agentic turns for this sub-agent
//   permissionMode string — "ask" | "auto-edit" | "yolo" (default: auto-edit)
//
// The body is plain markdown. It is injected as `extra` when the sub-agent
// runs, so it supplements (not replaces) the shared static prefix.
//
// Routing: the parent agent's system prompt advertises custom agents by name
// + description. The parent calls `task({ agent_type: "<name>", objective: ... })`
// to delegate. We look up the custom agent by name; if found, we build a
// sub-agent runner that uses its frontmatter config + body.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";

export interface CustomAgent {
  /** Canonical name (from frontmatter, or the file stem as fallback). */
  name: string;
  /** One-line description — the routing signal for the parent agent. */
  description: string;
  /** Optional tool allowlist. */
  tools?: string[];
  /** Optional tool denylist (applied after the allowlist). */
  disallowedTools?: string[];
  /** Model override: alias, full id, or "inherit". */
  model?: string;
  /** Max agentic turns. */
  maxTurns?: number;
  /** Permission mode override for this sub-agent. */
  permissionMode?: "ask" | "auto-edit" | "yolo";
  /** Full markdown body (frontmatter stripped). */
  body: string;
  /** Absolute path to the .md file on disk. */
  path: string;
  /** Which source this agent came from. */
  source: "project" | "user";
}

export interface DiscoverOptions {
  /** Override the project-local agents directory (defaults to `<cwd>/.codepilot/agents`). */
  projectDir?: string;
  /** Override the user-global agents directory (defaults to `~/.codepilot/agents`). */
  userDir?: string;
}

/**
 * Discover custom agents from project + user sources. Project agents take
 * precedence over user agents with the same name. Returns a map keyed by
 * agent name for O(1) lookup.
 */
export async function discoverCustomAgents(
  cwd: string,
  opts: DiscoverOptions = {}
): Promise<Map<string, CustomAgent>> {
  const projectDir = opts.projectDir ?? join(cwd, ".codepilot", "agents");
  const userDir = opts.userDir ?? join(homedir(), ".codepilot", "agents");
  const out = new Map<string, CustomAgent>();
  // User agents first (lower priority), then project agents overwrite.
  for (const [source, dir] of [["user", userDir], ["project", projectDir]] as const) {
    const found = await loadAgentsFromDir(dir, source);
    for (const a of found) out.set(a.name, a);
  }
  return out;
}

async function loadAgentsFromDir(
  dir: string,
  source: "project" | "user"
): Promise<CustomAgent[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: CustomAgent[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (!st.isFile()) continue;
      const text = await readFile(path, "utf-8");
      const agent = parseAgentFile(text, path, source);
      if (agent) out.push(agent);
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

/**
 * Parse a .md file into a CustomAgent. Returns null when required
 * frontmatter (`name`, `description`) is missing or malformed.
 */
export function parseAgentFile(
  text: string,
  path: string,
  source: "project" | "user"
): CustomAgent | null {
  const { frontmatter, body } = splitFrontmatter(text);
  if (!frontmatter) return null;
  const name = (frontmatter.name as string | undefined)?.trim();
  const description = (frontmatter.description as string | undefined)?.trim();
  if (!name || !description) return null;
  // Validate name format: lowercase letters, digits, hyphens.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  return {
    name,
    description,
    tools: toStringArray(frontmatter.tools),
    disallowedTools: toStringArray(frontmatter.disallowedTools ?? frontmatter.disallowed_tools),
    model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
    maxTurns: typeof frontmatter.maxTurns === "number" ? frontmatter.maxTurns : undefined,
    permissionMode: asPermissionMode(frontmatter.permissionMode ?? frontmatter.permission_mode),
    body: body.trim(),
    path,
    source,
  };
}

// ---------------------------------------------------------------------------
// Minimal frontmatter parser (no YAML dependency — we only need a flat
// key: value block, plus `tools:` and `disallowedTools:` as YAML lists).
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  [k: string]: unknown;
}

function splitFrontmatter(text: string): { frontmatter: ParsedFrontmatter | null; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return { frontmatter: null, body: text };
  // Find the closing ---.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { frontmatter: null, body: text };
  const yaml = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  return { frontmatter: parseSimpleYaml(yaml), body };
}

/**
 * Parse a tiny subset of YAML: `key: value` and `key:` followed by a
 * block list of `- item` lines. Values may be unquoted, single-quoted,
 * or double-quoted. This covers everything claude-code's agent files use.
 */
function parseSimpleYaml(yaml: string): ParsedFrontmatter {
  const out: ParsedFrontmatter = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1]!;
    const rest = m[2]!.trim();
    // Block list: `key:` followed by lines starting with `- `.
    if (rest === "") {
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const itemLine = lines[i]!;
        const im = itemLine.match(/^\s+-\s+(.*)$/);
        if (!im) break;
        items.push(stripQuotes(im[1]!.trim()));
        i++;
      }
      out[key] = items.length > 0 ? items : "";
      continue;
    }
    // Inline scalar.
    out[key] = coerceScalar(stripQuotes(rest));
    i++;
  }
  return out;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function coerceScalar(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function toStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (typeof v === "string" && v.trim().length > 0) {
    return v.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return undefined;
}

function asPermissionMode(v: unknown): "ask" | "auto-edit" | "yolo" | undefined {
  if (typeof v !== "string") return undefined;
  if (v === "ask" || v === "auto-edit" || v === "yolo") return v;
  return undefined;
}

/**
 * Render custom agents as a system-prompt block advertising them to the
 * parent agent. The parent reads this to decide when to delegate via
 * `task({ agent_type: "<name>" })`.
 */
export function renderCustomAgentsBlock(agents: Map<string, CustomAgent>): string {
  if (agents.size === 0) return "";
  const lines: string[] = [];
  lines.push("## Custom Sub-Agents");
  lines.push("");
  lines.push("You can delegate work to these custom sub-agents via `task({ agent_type: \"<name>\", objective: \"...\" })`. Choose the agent whose `description` best matches the work.");
  lines.push("");
  for (const a of agents.values()) {
    const tools = a.tools ? ` (tools: ${a.tools.join(", ")})` : "";
    lines.push(`- **${a.name}**${tools} — ${a.description}`);
  }
  lines.push("");
  lines.push("When you delegate, the sub-agent runs with its own system prompt (the body of its definition file) and the tool set declared in its frontmatter. Write the `objective` so the sub-agent can act with no further context.");
  return lines.join("\n");
}
