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
import {
  checkDangerousCommand,
  assertPathAllowed,
  detectSandboxBackend,
  isWriteOutsideSandbox,
  sensitivePathHit,
  gitMetadataWriteHit,
  writableRootForTarget,
  type ResolvedSandbox,
} from "./sandbox.js";
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
 /** Active sandbox policy + cwd. Used for in-root write auto-allow and for
 * detecting out-of-root writes that need a sandbox-expand prompt.
 * `osEnforced` is true only when an OS backend actually jails bash. */
  private sandbox?: { policy: ResolvedSandbox; cwd: string; osEnforced: boolean };

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

 /**
 * Wire the active sandbox policy. Always kept when mode ≠ off so file tools
 * can offer to expand `writablePaths`. Bash auto-allow requires `osEnforced`
 * (an OS backend is actually jailing the shell).
 */
  setSandbox(
    policy: ResolvedSandbox | undefined,
    cwd: string,
    opts?: { osEnforced?: boolean },
  ): void {
    if (!policy || policy.mode === "off") {
      this.sandbox = undefined;
      return;
    }
    const osEnforced =
      opts?.osEnforced ?? detectSandboxBackend() !== "none";
    this.sandbox = { policy, cwd, osEnforced };
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
 * Derive the rule to add when the user clicks "always allow". The grant is
 * NARROWED to the invocation, not widened to the whole tool:
 *
 * - bash: the leading safe prefix of the command as a prefix glob, e.g.
 *   `npm test -- --watch` → `bash(npm test *)`. The prefix is the program
 *   plus (for multi-word CLIs like `npm`/`git`/`cargo`/`pnpm`) its first
 *   subcommand, so `npm test` and `npm run build` get distinct grants. A
 *   command whose program is in BANNED_PREFIXES (rm, sudo, `bash -c`,
 *   interpreters that run arbitrary code, …) is NOT widened at all — it
 *   returns a wildcard-free rule for the exact command line, so the grant
 *   covers only this one invocation and can never auto-approve a different
 *   dangerous command this session.
 * - file tools: the containing directory, e.g. `write_file(/repo/src/*)`, so
 *   a sibling file in the same directory is covered but an unrelated path
 *   still prompts.
 * - everything else (no primary arg, non-path tools): the bare tool name —
 *   there is nothing finer to scope to.
 *
 * deny rules still override (checked first and absolute). The grant is
 * session-scoped and never persisted implicitly.
 */
  static suggestRule(tool: ToolDef, input?: unknown): string {
    if (tool.name === "bash") {
      const primary = extractPrimaryArg("bash", input);
      if (!primary) return "bash";
      return suggestBashRule(primary);
    }
 // File tools scope to the target's directory.
    if (tool.permission === "write" || tool.permission === "read") {
      const paths = extractWritePaths(tool.name, input);
      const target = paths[0] ?? extractPrimaryArg(tool.name, input);
      if (target && (target.includes("/") || target.includes("\\"))) {
        const dir = target.replace(/[\\/][^\\/]*$/, "");
        if (dir) return `${tool.name}(${dir}/*)`;
      }
    }
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

    // Per-command sandbox escalation (bash `escalate_sandbox: true`): the model
    // asked to run THIS one command WITHOUT the OS jail (e.g. a dev server the
    // sandbox's network/fs policy breaks). It always forces an interactive
    // confirmation — never auto-allowed, even under yolo, an active sandbox, or
    // an allow rule. A deny rule (checked above) still wins. The escalation is
    // ephemeral: it applies only to this invocation and never changes the
    // session policy.
    if (bash && isSandboxEscalation(input)) return "ask";

 // Sensitive-path floor — applies EVEN when the sandbox is off or the mode is
 // yolo, and above every allow rule. A write/delete onto a system, boot, or
 // credential path (/etc, ~/.ssh, shell rc files, …) forces an interactive
 // confirmation, mirroring the dangerous-command posture. This is the tool-
 // layer counterpart of checkDangerousCommand for bash: file tools would
 // otherwise have no floor at all when the sandbox is off. Not a hard deny —
 // a user who means it can still confirm (or add an explicit allow/deny rule).
    {
      const cwd = this.sandbox?.cwd ?? process.cwd();
      // write-tier file tools (write_file / edit_file / apply_patch / image_gen);
      // apply_patch delete hunks surface as write paths too.
      if (tool.permission === "write" && tool.name !== "bash") {
        const writePaths = extractWritePaths(tool.name, input);
        const candidates = writePaths.length > 0 ? writePaths : primary ? [primary] : [];
        for (const p of candidates) {
          // System/credential floor + workspace .git floor. The latter has no
          // absolute path (it lives inside the writable workspace) so it needs
          // its own component check; both only force "ask", never hard-deny.
          if (sensitivePathHit(p, "write", cwd) || gitMetadataWriteHit(p, cwd)) return "ask";
        }
      }
      // bash: a command that writes/deletes under a sensitive root. The
      // dangerous-command scan already covers `rm -rf /` and `~`; this adds the
      // finer system/credential roots. We check the raw command for a sensitive
      // absolute path token — conservative, and it only forces "ask".
      if (bash && primary) {
        for (const root of ["/etc", "/boot", "/System", "/usr/bin", "/usr/sbin", "/bin", "/sbin"]) {
          if (new RegExp(`(^|\\s|=|"|')${root}(/|\\s|$)`).test(primary)) {
            const danger = checkDangerousCommand(primary);
            // Only force ask for mutating commands; a plain read (cat /etc/hosts)
            // is fine. Heuristic: the command mutates if it's not read-only.
            if (!isReadOnlyCommand(primary) || danger.dangerous) return "ask";
            break;
          }
        }
      }
    }

 // Out-of-sandbox writes always ask (even under yolo / allow rules / auto-edit)
 // so the user can grant the folder before the tool-layer path guard rejects it.
 // apply_patch may touch several paths — any one outside is enough to ask.
    {
      const writePaths = extractWritePaths(tool.name, input);
      const candidates = writePaths.length > 0 ? writePaths : primary ? [primary] : [];
      for (const p of candidates) {
        if (this.sandboxExpandFor(tool, p)) return "ask";
      }
    }

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
 // memory_write to PROJECT scope is a silent side channel (project-state
 // MEMORY.md); never prompt — same posture as other read-tier bookkeeping
 // tools. Writing USER scope (global ~/.codepilot/MEMORY.md) is different:
 // it is a cross-project rule the agent would otherwise persist silently and
 // re-inject into every future session, so require interactive confirmation
 // for user-scope writes. yolo mode still auto-allows (see below).
    if (tool.name === "memory_write") {
      const scope = (input as { scope?: unknown } | null)?.scope;
      if (scope === "user" && this.mode !== "yolo") {
        return "ask";
      }
      return { decision: "allow", reason: "memory_write (project scope) is silent and auto-allowed" };
    }
    if (tool.permission === "read") {
      return { decision: "allow", reason: "read-only tool" };
    }
    // Network tools (web_search / web_fetch / MCP network) have no local
    // side effects — auto-allow in every mode. Domain denylists on web_fetch
    // still refuse specific hosts inside the tool.
    if (tool.permission === "network") {
      return { decision: "allow", reason: "network tool (no local side effects)" };
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
 // Sandbox-confined writes: when a sandbox is active and every write target
 // resolves inside the sandbox's writable roots, auto-allow. apply_patch
 // must have ALL touched paths inside; any outside already returned "ask"
 // above. bash is handled separately just below.
    if (
      tool.permission === "write" &&
      tool.name !== "bash" &&
      this.sandbox &&
      this.sandbox.policy.mode !== "off"
    ) {
      const writePaths = extractWritePaths(tool.name, input);
      const candidates = writePaths.length > 0 ? writePaths : primary ? [primary] : [];
      if (
        candidates.length > 0 &&
        candidates.every(
          (p) => assertPathAllowed(p, "write", this.sandbox!.policy, this.sandbox!.cwd).ok,
        )
      ) {
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
      this.sandbox?.osEnforced &&
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
    const writePaths = extractWritePaths(tool.name, input);
    let reason = describeReason(tool.permission, tool.name, input);
    if (tool.name === "bash" && primary) {
      const danger = checkDangerousCommand(primary);
      if (danger.dangerous) reason += ` DANGEROUS: ${danger.why}.`;
      if (isSandboxEscalation(input)) {
        const why = (input as Record<string, unknown>).justification;
        reason +=
          ` SANDBOX ESCALATION: this command will run WITHOUT the OS sandbox` +
          ` (full host access for this one command).` +
          (typeof why === "string" && why.trim() ? ` Reason: ${why.trim()}` : "");
      }
    }
    // Flag a sensitive system/credential target so the approval card states the
    // stakes — this is the ask forced by the sensitive-path floor in preflight.
    {
      const cwd = this.sandbox?.cwd ?? process.cwd();
      const candidates = writePaths.length > 0 ? writePaths : primary ? [primary] : [];
      for (const p of candidates) {
        const hit = sensitivePathHit(p, "write", cwd);
        if (hit) {
          reason += ` SENSITIVE PATH: writing under ${hit} (system/credential location).`;
          break;
        }
        const gitHit = gitMetadataWriteHit(p, cwd);
        if (gitHit) {
          reason +=
            ` GIT METADATA: writing under ${gitHit} can corrupt history or plant a hook; ` +
            `use \`git\` subcommands instead.`;
          break;
        }
      }
    }
    if (tool.name === "apply_patch" && writePaths.length > 0) {
      reason = `Apply patch to ${writePaths.length} file(s):\n${writePaths.map((p) => `  ${p}`).join("\n")}`;
    }
    let sandboxExpand: { path: string } | undefined;
    const expandCandidates = writePaths.length > 0 ? writePaths : primary ? [primary] : [];
    for (const p of expandCandidates) {
      sandboxExpand = this.sandboxExpandFor(tool, p);
      if (sandboxExpand) break;
    }
    if (sandboxExpand) {
      reason =
        `Write path is outside the sandbox writable roots. ` +
        `Allow once adds “${sandboxExpand.path}” for this session; ` +
        `Always allow also saves it to sandbox.writablePaths. ` +
        reason;
    }
    return {
      requestId,
      toolName: tool.name,
      input,
      reason,
      ...(sandboxExpand ? { sandboxExpand } : {}),
    };
  }

  /**
   * Enrich a permission request so the UI can show what a `job_id` refers to.
   * `bash_kill` / `write_stdin` only carry `{ job_id }`; without this the
   * approval card is opaque. Mutates `req` in place. Safe no-op when the job
   * is unknown or the tool is unrelated.
   */
  async enrichForDisplay(req: PermissionRequest, cwd: string): Promise<void> {
    if (!req.input || typeof req.input !== "object") return;
    const o = req.input as Record<string, unknown>;

    // apply_patch: show file list instead of the raw multi-KB patch blob.
    if (req.toolName === "apply_patch" && typeof o.patch === "string") {
      const { pathsFromApplyPatch } = await import("./tools/apply_patch.js");
      const files = pathsFromApplyPatch(o.patch);
      req.input = {
        files,
        patch: o.patch,
      };
      if (files.length > 0) {
        req.reason = `Apply patch to ${files.length} file(s):\n${files.map((p) => `  ${p}`).join("\n")}`;
      }
      void cwd;
      return;
    }

    if (
      req.toolName !== "bash_kill" &&
      req.toolName !== "write_stdin" &&
      req.toolName !== "bash_output"
    ) {
      return;
    }
    if (typeof o.job_id !== "string" || !o.job_id) return;
    // Lazy import avoids a permissions ↔ bashJobs cycle at module load.
    const { getJob } = await import("./tools/bashJobs.js");
    const job = await getJob(cwd, o.job_id);
    if (!job) {
      req.reason = `${req.reason} (unknown job ${o.job_id})`;
      return;
    }
    const command = job.meta.displayCommand ?? job.meta.command;
    const status = job.meta.status;
    req.input = {
      ...o,
      command,
      status,
    };
    if (req.toolName === "bash_kill") {
      req.reason = `Stop background job ${o.job_id} (${status}): ${command}`;
    } else if (req.toolName === "write_stdin") {
      req.reason = `Send stdin to background job ${o.job_id} (${status}): ${command}`;
    } else {
      req.reason = `Read output of background job ${o.job_id} (${status}): ${command}`;
    }
  }

 /**
   * Directory to grant when a **file write tool** targets a path outside the
   * sandbox. Bash is not scanned for write paths — the OS jail is the
   * enforcement; expand happens when the user allows a folder on a write
   * tool (or via delivery-root approval, which also expands the jail).
   */
  sandboxExpandFor(
    tool: ToolDef,
    primary: string | undefined,
  ): { path: string } | undefined {
    if (
      !this.sandbox ||
      this.sandbox.policy.mode === "off" ||
      this.sandbox.policy.mode === "read-only" ||
      tool.permission !== "write" ||
      tool.name === "bash" ||
      !primary
    ) {
      return undefined;
    }
    if (!isWriteOutsideSandbox(primary, this.sandbox.policy, this.sandbox.cwd)) {
      return undefined;
    }
    return {
      path: writableRootForTarget(primary, this.sandbox.cwd),
    };
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

/**
 * Programs that must never be widened into a prefix grant. These either run
 * arbitrary code from an argument (shells / interpreters with `-c`, `eval`),
 * escalate privilege (`sudo`, `doas`), or destroy data (`rm`), so an "always
 * allow" on one invocation must not auto-approve a different command sharing
 * the program. For these, the grant covers only the exact command line.
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
 * Build the session allow rule for an "always allow" on a bash command. Safe
 * programs widen to a prefix glob (`bash(npm test *)`); banned programs get a
 * wildcard-free exact rule so only this invocation is covered. The input is
 * the already-normalised primary (leading `cd`/`echo` stripped).
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

/** Tools' primary argument extractor. */
function extractPrimaryArg(toolName: string, input: unknown): string | undefined {
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
function extractWritePaths(toolName: string, input: unknown): string[] {
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
