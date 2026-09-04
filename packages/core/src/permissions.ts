// Permission engine: decides whether a tool invocation is auto-allowed,
// auto-denied, or must be asked interactively.
//
// Rule model (claude-code compatible syntax):
//
//   "read_file"                  — bare tool name: matches every invocation
//   "mcp__github__*"             — `*` wildcard over tool names
//   "bash(npm test *)"           — glob/prefix match on the tool's PRIMARY
//                                  argument (bash→command, read_file/
//                                  write_file/edit_file→path, web_fetch→url,
//                                  web_search→query; default: JSON of input)
//   "bash(/^git (status|diff)/)" — regex match on the primary argument
//
// Evaluation order (first match wins):
//
//   1. deny rules   (session + config)  — apply in EVERY mode, incl. yolo
//   2. ask rules                        — force an interactive prompt
//   3. allow rules  (session + config + legacy autoApprove)
//   4. mode defaults: yolo → allow; read-tier → allow;
//      write-tier + auto-edit → allow
//   5. dangerous-command scan (bash)    — forces "ask" even under yolo
//   6. otherwise → "ask"
//
// "always" decisions from the UI are narrowed to a per-invocation RULE
// (addSessionRule) instead of the old behaviour of flipping the whole
// session to yolo. Rules can optionally be persisted to the repo config
// with persistRule().

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  CodepilotConfig,
  PermissionMode,
  PermissionRequest,
  PermissionDecision,
  PermissionRules,
} from "./types.js";
import type { ToolDef, PermissionLevel } from "./tools/types.js";
import { checkDangerousCommand } from "./sandbox.js";

export interface PermissionCheckResult {
  decision: PermissionDecision;
  reason: string;
}

type RuleEffect = "allow" | "ask" | "deny";

export class PermissionEngine {
  private mode: PermissionMode;
  private configRules: Required<PermissionRules>;
  /** Rules added at runtime via "always" decisions. Never persisted implicitly. */
  private sessionRules: Required<PermissionRules>;

  constructor(
    config: Pick<CodepilotConfig, "permissionMode" | "autoApprove" | "permissions"> = {}
  ) {
    this.mode = config.permissionMode ?? "ask";
    this.configRules = {
      allow: [...(config.permissions?.allow ?? []), ...(config.autoApprove ?? [])],
      ask: [...(config.permissions?.ask ?? [])],
      deny: [...(config.permissions?.deny ?? [])],
    };
    this.sessionRules = { allow: [], ask: [], deny: [] };
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /** Snapshot of all active rules (config + session), for UI display. */
  rules(): Required<PermissionRules> {
    return {
      allow: [...this.sessionRules.allow, ...this.configRules.allow],
      ask: [...this.sessionRules.ask, ...this.configRules.ask],
      deny: [...this.sessionRules.deny, ...this.configRules.deny],
    };
  }

  /** Record an "always"-style decision as a narrowed rule for this session. */
  addSessionRule(rule: string, effect: RuleEffect = "allow"): void {
    this.sessionRules[effect].push(rule);
  }

  /**
   * Derive the narrowest sensible rule covering this invocation, e.g.
   * `bash(npm test *)` from `npm test -- --watch`, or `read_file` for tools
   * without a meaningful primary argument.
   */
  static suggestRule(tool: ToolDef, input: unknown): string {
    const primary = extractPrimaryArg(tool.name, input);
    if (primary === undefined) return tool.name;
    if (tool.name === "bash") {
      // Prefix up to the first argument boundary, plus ` *`.
      const tokens = primary.trim().split(/\s+/);
      const prefix = tokens.slice(0, Math.min(tokens.length, 2)).join(" ");
      return `bash(${prefix} *)`;
    }
    return `${tool.name}(${primary} *)`;
  }

  /** Fast check used by the agent loop. */
  preflight(tool: ToolDef, input: unknown): PermissionCheckResult | "ask" {
    const primary = extractPrimaryArg(tool.name, input);

    // 1. deny — absolute, even in yolo.
    const deny = firstMatch(this.rules().deny, tool.name, primary, input);
    if (deny) return { decision: "deny", reason: `matched deny rule "${deny}"` };

    // 2. ask — forces interactive confirmation.
    const ask = firstMatch(this.rules().ask, tool.name, primary, input);
    if (ask) return "ask";

    // 3. allow rules.
    const allow = firstMatch(this.rules().allow, tool.name, primary, input);
    if (allow) return { decision: "allow", reason: `matched allow rule "${allow}"` };

    // 4. mode defaults.
    if (tool.permission === "read") {
      return { decision: "allow", reason: "read-only tool" };
    }
    if (this.mode === "yolo") {
      // Dangerous commands still require interactive confirmation.
      if (tool.name === "bash" && primary) {
        const danger = checkDangerousCommand(primary);
        if (danger.dangerous) return "ask";
      }
      return { decision: "allow", reason: "permission mode is yolo" };
    }
    if (tool.permission === "write" && this.mode === "auto-edit") {
      return { decision: "allow", reason: "auto-edit mode" };
    }

    // 5. dangerous commands always ask when not explicitly allowed.
    if (tool.name === "bash" && primary) {
      const danger = checkDangerousCommand(primary);
      if (danger.dangerous) return "ask";
    }
    return "ask";
  }

  /** Build a permission request to send to the user / frontend. */
  buildRequest(requestId: string, tool: ToolDef, input: unknown): PermissionRequest {
    const primary = extractPrimaryArg(tool.name, input);
    let reason = describeReason(tool.permission, tool.name, input);
    if (tool.name === "bash" && primary) {
      const danger = checkDangerousCommand(primary);
      if (danger.dangerous) reason += ` DANGEROUS: ${danger.why}.`;
    }
    return { requestId, toolName: tool.name, input, reason };
  }
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

/** Tools' primary argument extractor. */
function extractPrimaryArg(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const field =
    toolName === "bash"
      ? "command"
      : toolName === "web_fetch"
        ? "url"
        : toolName === "web_search"
          ? "query"
          : "path" in o
            ? "path"
            : undefined;
  if (field && typeof o[field] === "string") return o[field] as string;
  return undefined;
}

function firstMatch(
  rules: string[],
  toolName: string,
  primary: string | undefined,
  input: unknown
): string | null {
  for (const rule of rules) {
    if (matchRule(rule, toolName, input, primary)) return rule;
  }
  return null;
}

/**
 * Match a single rule. `primary` may be omitted (recomputed from input).
 * Kept exported and total for unit tests.
 */
export function matchRule(
  rule: string,
  toolName: string,
  input: unknown,
  primary?: string
): boolean {
  const scoped = rule.match(/^([A-Za-z0-9_*-]+)\((.*)\)$/s);
  if (scoped) {
    const [, toolPart, argPattern] = scoped;
    if (!matchToolName(toolPart!, toolName)) return false;
    const arg = primary ?? extractPrimaryArg(toolName, input);
    if (arg === undefined) return false;
    const pat = argPattern!.trim();
    if (pat.startsWith("/") && pat.endsWith("/") && pat.length > 1) {
      try {
        return new RegExp(pat.slice(1, -1)).test(arg);
      } catch {
        return false;
      }
    }
    return globMatch(pat, arg);
  }
  return matchToolName(rule, toolName);
}

function matchToolName(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  if (pattern.includes("*")) return globMatch(pattern, toolName);
  return false;
}

/** Anchored glob: `*` → `.*`, `?` → `.`; everything else literal. */
function globMatch(pattern: string, value: string): boolean {
  const re =
    "^" +
    pattern
      .split(/(\*|\?)/)
      .map((part) =>
        part === "*" ? ".*" : part === "?" ? "." : escapeRegex(part)
      )
      .join("") +
    "$";
  try {
    return new RegExp(re, "s").test(value);
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Persist a rule into `<cwd>/.codepilot/config.json` under
 * `permissions.<effect>`. Merges with existing file content; creates the
 * file when missing. Best-effort: throws on malformed existing JSON.
 */
export async function persistRule(
  cwd: string,
  rule: string,
  effect: RuleEffect = "allow"
): Promise<string> {
  const path = join(cwd, ".codepilot", "config.json");
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot persist rule: ${path} is not valid JSON`);
    }
  }
  const perms = (json.permissions ?? {}) as Record<string, unknown>;
  const list = Array.isArray(perms[effect]) ? (perms[effect] as string[]) : [];
  if (!list.includes(rule)) list.push(rule);
  perms[effect] = list;
  json.permissions = perms;
  await mkdir(join(cwd, ".codepilot"), { recursive: true });
  await writeFile(path, JSON.stringify(json, null, 2) + "\n", "utf-8");
  return path;
}

function describeReason(
  level: PermissionLevel,
  toolName: string,
  input: unknown
): string {
  switch (level) {
    case "read":
      return `Read-only tool (${toolName})`;
    case "write":
      return `Tool ${toolName} will modify files.`;
    case "execute":
      return `Tool ${toolName} will execute a shell command.`;
    case "network":
      return `Tool ${toolName} will access the network.`;
  }
  void input;
  return `Tool ${toolName} requires permission.`;
}
