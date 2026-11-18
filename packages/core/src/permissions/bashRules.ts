import { homedir } from "node:os";
import { sensitivePathHit } from "../sandbox/sandbox.js";
import { isReadOnlySegment, type ParsedCommand } from "./commandSafety.js";
import type { PermissionLevel } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

/**
 * Strip leading `cd`/`echo` prefixes from a bash command so allow rules
 * match the real probe (e.g. `cd x && grep …` → `grep …`). Never drops a
 * trailing dangerous segment — deny rules still see the normalised rest.
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

/**
 * Programs that must never be widened into a prefix grant: they run arbitrary
 * code (shells/`-c`, `eval`), escalate privilege (sudo), or destroy data (rm).
 * An "always allow" on one covers only the exact command line.
 */
const BANNED_PREFIXES: ReadonlySet<string> = new Set([
  "rm", "rmdir", "sudo", "doas", "su",
  "bash", "sh", "zsh", "fish", "dash", "ksh",
  "eval", "exec", "source", ".",
  "python", "python3", "python2", "node", "deno", "bun", "ruby", "perl", "php",
  "env", "xargs", "find", "chmod", "chown", "dd", "mkfs", "kill", "killall",
]);

/** Multi-word CLIs where the first subcommand is part of the meaningful
 * prefix (`git status`, `npm run`, not just `git` / `npm`). */
const SUBCOMMAND_CLIS: ReadonlySet<string> = new Set([
  "git", "npm", "pnpm", "yarn", "cargo", "go", "docker", "kubectl", "gh",
  "pip", "pip3", "brew", "apt", "apt-get", "systemctl", "make",
]);

/** Shell-word split that keeps quoted spans intact. */
function shellWords(command: string): string[] {
  return command.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g) ?? [];
}

/**
 * Build the session allow rule for "always allow" on a bash command. Safe
 * programs widen to a prefix glob; banned programs get a wildcard-free exact
 * rule. Input is the already-normalised primary.
 */
export function suggestBashRule(primary: string): string {
  const words = shellWords(primary).map((w) => w.replace(/^(['"])([\s\S]*)\1$/, "$2"));
  const prog = words[0];
  // No parseable program, or a program that must not widen: grant exactly this
  // command line (no wildcard → matches only an identical invocation).
  if (!prog || /^[A-Za-z_][A-Za-z0-9_]*=/.test(prog) || BANNED_PREFIXES.has(prog)) {
    return `bash(${primary})`;
  }
  const prefixWords = SUBCOMMAND_CLIS.has(prog) && words[1] && !words[1].startsWith("-")
    ? words.slice(0, 2)
    : [prog];
  return `bash(${prefixWords.join(" ")} *)`;
}

/** Whether a bash input requests per-command sandbox escalation (run this one
 * command without the OS jail). A plain boolean field on the bash input; kept
 * here so the preflight gate and the bash tool read it the same way. */
export function isSandboxEscalation(input: unknown): boolean {
  return (
    !!input &&
    typeof input === "object" &&
    (input as Record<string, unknown>).escalate_sandbox === true
  );
}

/**
 * The sensitive read root a bash command names, or null. A token heuristic
 * (`~` / `$HOME` expanded, flags skipped) — it can be evaded by globbing or
 * string building, so it only adds an ask on top of the OS sandbox; it is not
 * the sole guard.
 */
export function bashSensitiveReadHit(command: string, cwd: string): string | null {
  const home = homedir();
  for (const raw of command.split(/[\s'"=;|&<>()`]+/)) {
    if (!raw || raw.startsWith("-")) continue;
    let token = raw;
    if (token === "~" || token.startsWith("~/")) token = home + token.slice(1);
    else if (token.startsWith("${HOME}")) token = home + token.slice(7);
    else if (token.startsWith("$HOME")) token = home + token.slice(5);
    if (token.startsWith("$")) continue;
    const hit = sensitivePathHit(token, "read", cwd);
    if (hit) return hit;
  }
  return null;
}

/** Public wrapper over the internal primary-argument extractor, for callers
 * (e.g. the permission classifier) that need the command / path / url / query a
 * call centres on without re-implementing the per-tool field mapping. */
export function primaryArgOf(toolName: string, input: unknown): string | undefined {
  return extractPrimaryArg(toolName, input);
}

/** Tools' primary argument extractor. */
export function extractPrimaryArg(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  if (toolName === "apply_patch" && typeof o.patch === "string") {
    return pathsFromPatchHeaders(o.patch)[0];
  }
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

/** All write targets for tools that may touch multiple paths. */
export function extractWritePaths(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  if (toolName === "apply_patch" && typeof o.patch === "string") {
    return pathsFromPatchHeaders(o.patch);
  }
  if (typeof o.path === "string" && o.path) return [o.path];
  return [];
}

/** Header-only path scan (mirrors apply_patch.pathsFromApplyPatch, inlined
 * to keep permissions free of a hard import cycle at module init). */
function pathsFromPatchHeaders(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    for (const prefix of ["*** Add File: ", "*** Update File: ", "*** Delete File: "]) {
      if (line.startsWith(prefix)) {
        const p = line.slice(prefix.length).trim();
        if (p) paths.push(p);
        break;
      }
    }
  }
  return paths;
}

export const READ_ONLY_RULE = "(read-only command)";

/** First rule matching the whole command or any command it may run (chained,
 * nested in a substitution, or exec'd by a wrapper such as `sudo`/`sh -c`). */
export function firstSegmentMatch(rules: string[], command: string, parsed: ParsedCommand): string | null {
  const whole = firstMatch(rules, "bash", command, { command });
  if (whole) return whole;
  for (const seg of parsed.commands) {
    const hit = firstMatch(rules, "bash", seg, { command: seg });
    if (hit) return hit;
  }
  return null;
}

/** The allow rule that covers `command`, or null. A blanket `bash` grant
 * covers anything; scoped rules must cover each chained command (read-only
 * ones need no rule) and cannot vouch for substitutions or file writes. */
export function bashAllowRule(rules: string[], command: string, parsed: ParsedCommand): string | null {
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

export function firstMatch(
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
export function describeReason(
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
      if (toolName === "bash_kill") return `Stop a background shell job (SIGTERM).`;
      if (toolName === "write_stdin") {
        return `Send input to a background shell job's stdin.`;
      }
      return `Tool ${toolName} will execute a shell command.`;
    case "network":
      return `Tool ${toolName} will access the network.`;
  }
  void input;
  return `Tool ${toolName} requires permission.`;
}
