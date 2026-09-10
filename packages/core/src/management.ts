/**
 * Runtime management & introspection for the `/mcp`, `/hooks`, `/agents`,
 * `/skills`, and `/context` slash commands (claude-code/codex parity).
 *
 * The TUI/IDE hosts call `describeMcp()`, `describeHooks()`, etc. to get a
 * pre-formatted text block for display, plus the raw structured data for
 * richer UIs. Pure functions over the session's existing state — no side
 * effects, no I/O. Skills and custom agents are (re)discovered on demand
 * so freshly added files show up without a restart.
 *
 * @module management
 */
import type { McpManager, McpToolDescriptor, McpResourceDescriptor, McpPromptDescriptor, McpStartError } from "./mcp.js";
import type { HookEngine, HookEvent, HookEntry } from "./hooks.js";
import { ALL_HOOK_EVENTS } from "./hooks.js";
import { discoverSkills, type Skill } from "./skills.js";
import { discoverCustomAgents, type CustomAgent } from "./customAgents.js";

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export interface McpSummary {
  servers: Array<{
    name: string;
    connected: boolean;
    tools: number;
    resources: number;
    prompts: number;
  }>;
  errors: McpStartError[];
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  prompts: McpPromptDescriptor[];
}

/** Collect MCP server status, advertised tools/resources/prompts, and any
 *  startup errors. Returns an empty summary when MCP is not configured. */
export function describeMcp(mcp: McpManager | null): McpSummary {
  if (!mcp) {
    return { servers: [], errors: [], tools: [], resources: [], prompts: [] };
  }
  const tools = mcp.listAllTools();
  const resources = mcp.listAllResources();
  const prompts = mcp.listAllPrompts();
  const errors = mcp.startErrors();
  // Derive per-server status. A server is "connected" if it has no entry in
  // startErrors; clients that started successfully may still advertise zero
  // tools, so we infer membership from the configs the manager knows about.
  const errored = new Set(errors.map((e) => e.server));
  const names = new Set<string>();
  for (const t of tools) names.add(t.server);
  for (const r of resources) names.add(r.server);
  for (const p of prompts) names.add(p.server);
  for (const e of errors) names.add(e.server);
  const servers = [...names].sort().map((name) => {
    const connected = !errored.has(name);
    return {
      name,
      connected,
      tools: tools.filter((t) => t.server === name).length,
      resources: resources.filter((r) => r.server === name).length,
      prompts: prompts.filter((p) => p.server === name).length,
    };
  });
  return { servers, errors, tools, resources, prompts };
}

/** Human-readable rendering of `describeMcp()` for the TUI notice line. */
export function formatMcp(s: McpSummary): string {
  if (s.servers.length === 0 && s.errors.length === 0) {
    return "No MCP servers configured. Add servers to .codepilot/config.json or .mcp.json.";
  }
  const lines: string[] = ["MCP servers:"];
  for (const srv of s.servers) {
    const status = srv.connected ? "✓ connected" : "✗ failed";
    lines.push(
      `  ${srv.name}  [${status}]  ${srv.tools} tool(s), ${srv.resources} resource(s), ${srv.prompts} prompt(s)`
    );
  }
  if (s.errors.length > 0) {
    lines.push("");
    lines.push("Startup errors:");
    for (const e of s.errors) {
      lines.push(`  ${e.server}: ${e.message}`);
    }
  }
  if (s.tools.length > 0) {
    lines.push("");
    lines.push(`Tools (${s.tools.length}):`);
    for (const t of s.tools.slice(0, 50)) {
      const desc = t.description ? ` — ${t.description.split("\n")[0].slice(0, 60)}` : "";
      lines.push(`  ${t.server}__${t.name}${desc}`);
    }
    if (s.tools.length > 50) lines.push(`  … and ${s.tools.length - 50} more`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface HooksSummary {
  events: Array<{ event: HookEvent; count: number; entries: HookEntry[] }>;
  total: number;
}

/** Collect all configured hooks across every event type. */
export function describeHooks(hooks: HookEngine): HooksSummary {
  const events = ALL_HOOK_EVENTS.map((event) => {
    const entries = hooks.listHooks(event);
    return { event, count: entries.length, entries };
  }).filter((e) => e.count > 0);
  const total = events.reduce((n, e) => n + e.count, 0);
  return { events, total };
}

/** Human-readable rendering of `describeHooks()`. */
export function formatHooks(s: HooksSummary): string {
  if (s.total === 0) {
    return "No hooks configured. Configure hooks in .codepilot/config.json under \"hooks\".";
  }
  const lines: string[] = [`Hooks (${s.total} total):`];
  for (const ev of s.events) {
    lines.push(`  ${ev.event} (${ev.count}):`);
    for (const h of ev.entries) {
      const target = h.command ? `cmd: ${h.command}` : h.http ? `http: ${h.http}` : "(no handler)";
      lines.push(`    [${h.matcher}] ${target}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Custom agents
// ---------------------------------------------------------------------------

export interface AgentsSummary {
  agents: Array<{ name: string; description: string; source: string; model?: string; tools?: string[] }>;
  total: number;
}

/** Discover custom agents (`.codepilot/agents/*.md` + `~/.codepilot/agents/*.md`).
 *  Async because it reads the filesystem. */
export async function describeAgents(cwd: string): Promise<AgentsSummary> {
  const map = await discoverCustomAgents(cwd);
  const agents = [...map.values()]
    .map((a: CustomAgent) => ({
      name: a.name,
      description: a.description,
      source: a.source,
      model: a.model,
      tools: a.tools,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { agents, total: agents.length };
}

/** Human-readable rendering of `describeAgents()`. */
export function formatAgents(s: AgentsSummary): string {
  if (s.total === 0) {
    return "No custom agents. Create .codepilot/agents/<name>.md (frontmatter: name, description).";
  }
  const lines: string[] = [`Custom agents (${s.total}):`];
  for (const a of s.agents) {
    const model = a.model ? ` [model: ${a.model}]` : "";
    const tools = a.tools && a.tools.length > 0 ? ` [tools: ${a.tools.join(", ")}]` : "";
    lines.push(`  ${a.name} (${a.source})${model}${tools}`);
    lines.push(`    ${a.description}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillsSummary {
  skills: Array<{ name: string; description: string; source: string; when?: string }>;
  total: number;
}

/** Discover skills from project, user, and built-in sources. */
export async function describeSkills(cwd: string): Promise<SkillsSummary> {
  const skills = await discoverSkills(cwd);
  const out = skills
    .map((s: Skill) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      when: s.when,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { skills: out, total: out.length };
}

/** Human-readable rendering of `describeSkills()`. */
export function formatSkills(s: SkillsSummary): string {
  if (s.total === 0) {
    return "No skills discovered. Add SKILL.md folders under .codepilot/skills/ or ~/.codepilot/skills/.";
  }
  const lines: string[] = [`Skills (${s.total}):`];
  for (const sk of s.skills) {
    const when = sk.when ? ` (when: ${sk.when})` : "";
    lines.push(`  ${sk.name} [${sk.source}]${when}`);
    lines.push(`    ${sk.description}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ContextSummary {
  totalTokens: number;
  window: number;
  usagePercent: number;
  triggerThreshold: number;
  triggerFraction: number;
  autoCompactEnabled: boolean;
  byEventType: { type: string; tokens: number; count: number }[];
  topFileReads: { path: string; reads: number; tokens: number }[];
  duplicateReads: { path: string; reads: number }[];
}

/** Human-readable rendering of a `ContextSummary` (from `Session.contextReport()`). */
export function formatContext(c: ContextSummary): string {
  const pct = c.usagePercent.toFixed(1);
  const lines: string[] = [
    `Context: ${c.totalTokens.toLocaleString()} / ${c.window.toLocaleString()} tokens (${pct}%)`,
    `  auto-compact: ${c.autoCompactEnabled ? "on" : "off"} (trigger at ${c.triggerThreshold.toLocaleString()} = ${(c.triggerFraction * 100).toFixed(0)}%)`,
  ];
  if (c.byEventType.length > 0) {
    lines.push("  by event type:");
    for (const e of c.byEventType.slice(0, 8)) {
      lines.push(
        `    ${e.type}: ${e.tokens.toLocaleString()} tok (${e.count} event${e.count === 1 ? "" : "s"})`
      );
    }
  }
  if (c.duplicateReads.length > 0) {
    lines.push("  duplicate reads (consider /compact):");
    for (const d of c.duplicateReads.slice(0, 5)) {
      lines.push(`    ${d.path} (read ${d.reads}×)`);
    }
  }
  return lines.join("\n");
}
