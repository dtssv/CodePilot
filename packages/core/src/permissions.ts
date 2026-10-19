// Permission engine: decides whether a tool invocation is auto-allowed,
// auto-denied, or must be asked interactively.
//
// Permission rule syntax:
//
// "read_file" — bare tool name: matches every invocation
// "mcp__github__*" — `*` wildcard over tool names
// "bash(npm test *)" — glob/prefix match on the tool's PRIMARY
// argument (bash→command, read_file/
// write_file/edit_file→path, web_fetch→url,
// web_search→query; default: JSON of input)
// "bash(/^git (status|diff)/)" — regex match on the primary argument
//
// Evaluation order (first match wins):
//
// 1. deny rules (session + config) — apply in EVERY mode, incl. yolo
// 2. ask rules — force an interactive prompt
// 3. allow rules (session + config + legacy autoApprove)
// 4. mode defaults: yolo → allow; read-tier → allow;
// write-tier + auto-edit → allow
// 5. dangerous-command scan (bash) — forces "ask" even under yolo
// 6. otherwise → "ask"
//
// "always" decisions from the UI add a session rule scoped to the
// invocation's primary argument (e.g. `bash(git status *)`), so only
// matching commands are auto-allowed for the rest of the session — not
// every call to that tool. deny rules still override — they are checked
// first and are absolute.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  CodepilotConfig,
  PermissionMode,
  PermissionRequest,
  PermissionDecision,
  PermissionRules,
} from "./types.js";
import type { ToolDef, PermissionLevel } from "./tools/types.js";
import { checkDangerousCommand, assertPathAllowed, detectSandboxBackend, type ResolvedSandbox } from "./sandbox.js";
import { isReadOnlyCommand, isReadOnlySegment, parseCommand, type ParsedCommand } from "./commandSafety.js";

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
 /** Active sandbox policy + cwd, when the session runs sandboxed. Lets
 * preflight auto-allow writes that land inside the sandbox's writable
 * roots — the process sandbox already confines them, so prompting adds
 * friction without adding safety. Undefined = no sandbox awareness. */
  private sandbox?: { policy: ResolvedSandbox; cwd: string };

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

 /** Wire the active sandbox policy so preflight can auto-allow in-sandbox
 * writes. Called by the Session once the sandbox is resolved. */
  setSandbox(policy: ResolvedSandbox | undefined, cwd: string): void {
 // A policy with no OS backend behind it confines nothing (the command
 // either runs raw or is refused), so it must not earn auto-allows.
    const enforced = policy && policy.mode !== "off" && detectSandboxBackend() !== "none";
    this.sandbox = enforced ? { policy, cwd } : undefined;
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

 /** Record an "always"-style decision as a session rule. When the user
 * picks "always allow", the caller narrows the grant to a rule covering
 * THIS invocation (e.g. `bash(npm test *)` via `suggestRule`) rather than
 * a bare tool name — so only matching calls are auto-allowed for the rest
 * of this session, not every call to that tool. The rule never persists
 * to disk; it lives only as long as this PermissionEngine (i.e. this
 * Session). deny rules still override — they are checked first in
 * preflight and are absolute. */
  addSessionRule(rule: string, effect: RuleEffect = "allow"): void {
    this.sessionRules[effect].push(rule);
  }

 /** Remove the last `count` session rules of the given effect (LIFO).
 * Used by the Session's turn-scoped override cleanup: slash-command
 * `allowed-tools` grants are pushed onto the allow list for one turn
 * and popped here so the next prompt resumes the normal permission
 * posture. If `count` exceeds the number of session rules of that
 * effect, all of them are removed (no error). */
  removeLastSessionRules(effect: RuleEffect, count: number): void {
    if (count <= 0) return;
    const arr = this.sessionRules[effect];
    const toRemove = Math.min(count, arr.length);
    arr.splice(arr.length - toRemove, toRemove);
  }

 /**
 * Derive the rule to add when the user clicks "always allow". The user's
 * intent is "stop asking me about this kind of action for the rest of the
 * session" — so we grant the whole TOOL, not a single command/path. For
 * `bash` that means every subsequent shell command is auto-approved this
 * session; for file tools every write/read. deny rules still override (they
 * are checked first and are absolute), and the grant is session-scoped —
 * it is never persisted to disk, so it dies with this Session.
 */
  static suggestRule(tool: ToolDef, _input?: unknown): string {
    void _input;
    return tool.name;
  }

 /** Fast check used by the agent loop. */
  preflight(tool: ToolDef, input: unknown): PermissionCheckResult | "ask" {
    const primary = extractPrimaryArg(tool.name, input);

    const bash = tool.name === "bash" && primary !== undefined ? parseCommand(primary) : undefined;

 // 1. deny — absolute, even in yolo. For bash, any one of the chained
 // commands matching is enough (`true && rm x` must hit `bash(rm *)`).
    const deny = bash
      ? firstSegmentMatch(this.rules().deny, primary!, bash)
      : firstMatch(this.rules().deny, tool.name, primary, input);
    if (deny) return { decision: "deny", reason: `matched deny rule "${deny}"` };

 // 2. ask — forces interactive confirmation.
    const ask = bash
      ? firstSegmentMatch(this.rules().ask, primary!, bash)
      : firstMatch(this.rules().ask, tool.name, primary, input);
    if (ask) return "ask";

 // 3. allow rules. A scoped bash rule vouches for the command it names,
 // so every chained command must be covered by a rule or be read-only.
    const allow = bash
      ? bashAllowRule(this.rules().allow, primary!, bash)
      : firstMatch(this.rules().allow, tool.name, primary, input);
    if (allow) {
 // Dangerous commands (rm -rf, force-push, drop-table, curl|sh, …) still
 // prompt under a blanket or prefix grant. Only a single command matched
 // by a precise, user-authored rule (e.g. "bash(git push --force *)") is
 // honoured as-is — the user opted into that one.
      if (bash && checkDangerousCommand(primary!).dangerous) {
        const precise = allow !== "bash" && allow !== READ_ONLY_RULE && bash.segments.length === 1;
        if (!precise) return "ask";
      }
      return { decision: "allow", reason: `matched allow rule "${allow}"` };
    }

 // 4. mode defaults.
    if (tool.permission === "read") {
      return { decision: "allow", reason: "read-only tool" };
    }
    if (bash && isReadOnlyCommand(primary!) && !checkDangerousCommand(primary!).dangerous) {
      return { decision: "allow", reason: "read-only command" };
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
 // A search query reveals far less than a URL (which can carry data out),
 // so web_search rides with auto-edit while web_fetch keeps asking.
    if (tool.name === "web_search" && this.mode === "auto-edit") {
      return { decision: "allow", reason: "auto-edit mode" };
    }
 // Sandbox-confined writes: when a sandbox is active and the write target
 // resolves inside the sandbox's writable roots, the process sandbox
 // already guarantees it can't escape — so auto-allow it instead of
 // prompting. Only the write's primary path is checked; a write outside
 // the writable roots still falls through to "ask" (and the sandbox would
 // block it anyway). bash is handled separately just below.
    if (
      tool.permission === "write" &&
      tool.name !== "bash" &&
      this.sandbox &&
      this.sandbox.policy.mode !== "off" &&
      primary !== undefined
    ) {
      const check = assertPathAllowed(primary, "write", this.sandbox.policy, this.sandbox.cwd);
      if (check.ok) {
        return { decision: "allow", reason: "write confined to sandbox writable roots" };
      }
    }

 // Sandbox-confined bash: when an OS sandbox is active, a shell command is
 // already jailed (writes limited to the workspace, sensitive paths denied,
 // network per policy). Prompting for every command is friction without
 // added safety — the sandbox is the safety. So auto-allow ordinary
 // commands and STILL prompt only for genuinely dangerous ones (rm -rf,
 // force-push, drop-table, curl|sh, …), which can do damage even inside the
 // jail (e.g. deleting the workspace). Without a sandbox we stay cautious
 // and fall through to "ask".
    if (
      tool.name === "bash" &&
      this.sandbox &&
      this.sandbox.policy.mode !== "off" &&
      primary !== undefined
    ) {
      const danger = checkDangerousCommand(primary);
      if (danger.dangerous) return "ask";
      return { decision: "allow", reason: "command confined to active sandbox" };
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

/**
 * Strip leading noise prefixes from a bash command so allow rules match the
 * real probe the model intended.
 *
 * Agents commonly emit chains like:
 * `cd /repo && echo "=== label ===" && grep -rn TODO src`
 * Without normalisation, `bash(grep *)` never matches and the session stalls
 * on permission prompts. We only strip `cd` / `echo` prefixes — never drop
 * a trailing dangerous segment (deny rules still see the normalised rest,
 * e.g. `cd x && rm -rf /` → `rm -rf /`).
 */
export function stripLeadingCd(command: string): string {
  return normalizeBashPrimary(command);
}

/** @see stripLeadingCd — kept as the general normaliser name for callers. */
export function normalizeBashPrimary(command: string): string {
  let s = command.trim();
  for (;;) {
    const cd = s.match(/^cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*(?:&&|;)\s+/);
    if (cd) {
      s = s.slice(cd[0].length).trim();
      continue;
    }
 // `echo label && <cmd>` — label may be quoted and contain spaces.
    const echo = s.match(/^echo\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s+/);
    if (echo) {
      s = s.slice(echo[0].length).trim();
      continue;
    }
    break;
  }
  return s;
}

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
  if (field && typeof o[field] === "string") {
    const raw = o[field] as string;
    return toolName === "bash" ? normalizeBashPrimary(raw) : raw;
  }
  return undefined;
}

const READ_ONLY_RULE = "(read-only command)";

/** First rule matching the whole command or any one of its commands. */
function firstSegmentMatch(rules: string[], command: string, parsed: ParsedCommand): string | null {
  const whole = firstMatch(rules, "bash", command, { command });
  if (whole) return whole;
  for (const seg of parsed.segments) {
    const hit = firstMatch(rules, "bash", seg, { command: seg });
    if (hit) return hit;
  }
  return null;
}

/** The allow rule that covers `command`, or null. A blanket `bash` grant
 * covers anything; scoped rules must cover each chained command (read-only
 * ones need no rule) and cannot vouch for substitutions or file writes. */
function bashAllowRule(rules: string[], command: string, parsed: ParsedCommand): string | null {
  const blanket = rules.find((r) => matchToolName(r, "bash"));
  if (blanket) return blanket;
 // A wildcard-free rule spelling out the exact command line (chain and all).
  const exact = firstMatch(rules, "bash", command, { command });
  if (exact && !exact.includes("*") && !exact.startsWith("/")) return exact;
  if (parsed.opaque || parsed.segments.length === 0) return null;
  let first: string | null = null;
  for (const seg of parsed.segments) {
    const hit = firstMatch(rules, "bash", seg, { command: seg }) ?? (isReadOnlySegment(seg) ? READ_ONLY_RULE : null);
    if (!hit) return null;
    if (!first || first === READ_ONLY_RULE) first = hit;
  }
  return first === READ_ONLY_RULE ? null : first;
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
 // Legacy bare-regex form: "/^git (status|log)/" — matches bash commands
 // with the historical implicit word-boundary anchoring.
  if (rule.startsWith("/") && rule.endsWith("/") && rule.length > 1) {
    if (toolName !== "bash") return false;
    const arg = primary ?? extractPrimaryArg(toolName, input);
    if (arg === undefined) return false;
    let body = rule.slice(1, -1);
    if (!body.startsWith("^")) body = "^(?:.*\\s)?" + body;
    try {
      return new RegExp(body).test(arg);
    } catch {
      return false;
    }
  }
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
 // A trailing " *" (prefix rule) also matches the bare prefix itself:
 // "bash(npm test *)" covers both "npm test" and "npm test -- --watch".
    if (pat.endsWith(" *") && arg === pat.slice(0, -2)) return true;
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
 * Persist a rule into a config file under `permissions.<effect>`. Merges
 * with existing file content; creates the file when missing. Best-effort:
 * throws on malformed existing JSON.
 *
 * @param cwd repo root
 * @param rule the rule string
 * @param effect allow / ask / deny
 * @param scope "repo" (default, `<cwd>/.codepilot/config.json`) or
 * "user" (`~/.codepilot/config.json`). Project rules should
 * be committed; user rules follow the developer across
 * projects.
 */
export async function persistRule(
  cwd: string,
  rule: string,
  effect: RuleEffect = "allow",
  scope: "repo" | "user" = "repo"
): Promise<string> {
  const path =
    scope === "user"
      ? join(homedir(), ".codepilot", "config.json")
      : join(cwd, ".codepilot", "config.json");
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
  await mkdir(join(path, ".."), { recursive: true });
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
