// Permission rules: allow/deny/ask a tool call.
// Syntax: "read_file"; "mcp__github__*" (wildcard); "bash(npm test *)" (glob);
// "bash(/^git status/)" (regex on primary arg).
// Evaluation (first match wins): deny → ask → allow → mode defaults →
// dangerous-command scan → ask.

import { resolve } from "node:path";
import type {
  CodepilotConfig,
  PermissionMode,
  PermissionRequest,
  PermissionDecision,
} from "../types.js";
import type { ToolDef } from "../tools/types.js";
import {
  checkDangerousCommand,
  assertPathAllowed,
  detectSandboxBackend,
  isWriteOutsideSandbox,
  isInsideWorkingSet,
  sensitivePathHit,
  gitMetadataWriteHit,
  writableRootForTarget,
  type ResolvedSandbox,
} from "../sandbox/sandbox.js";
import {
  isReadOnlyCommand,
  parseCommand,
  extractRedirectWriteTargets,
} from "./commandSafety.js";
import {
  suggestBashRule,
  isSandboxEscalation,
  bashSensitiveReadHit,
  extractPrimaryArg,
  extractWritePaths,
  firstSegmentMatch,
  bashAllowRule,
  firstMatch,
  READ_ONLY_RULE,
  describeReason,
} from "./bashRules.js";

export interface PermissionCheckResult {
  decision: PermissionDecision;
  reason: string;
}

export type RuleEffect = "allow" | "ask" | "deny";

/** The three rule lists the engine evaluates. A narrower shape than
 * {@link PermissionRules} (which also carries the boundary policy + working
 * directories) so these always-present buckets don't drag the policy fields in. */
export interface RuleBuckets {
  allow: string[];
  ask: string[];
  deny: string[];
}

export class PermissionEngine {
  private mode: PermissionMode;
  private configRules: RuleBuckets;
 /** Rules added at runtime via "always" decisions. Never persisted implicitly. */
  private sessionRules: RuleBuckets;
 /** Active sandbox policy + cwd. Used for in-root write auto-allow and for
 * detecting out-of-root writes that need a sandbox-expand prompt.
 * `osEnforced` is true only when an OS backend actually jails bash. */
  private sandbox?: { policy: ResolvedSandbox; cwd: string; osEnforced: boolean };
 /** `auto`-mode classifier denial tracking. A misfiring classifier must be able
  * to hand control back to the human: once the consecutive or total denial cap
  * is crossed, {@link classifierShouldDefer} returns true and the caller prompts
  * instead of trusting the classifier. */
  private classifierConsecutiveDenials = 0;
  private classifierTotalDenials = 0;
  private readonly autoMaxConsecutiveDenials: number;
  private readonly autoMaxTotalDenials: number;
 /** When true, persisted (config / project) allow rules are IGNORED during
  * matching — only deny / ask rules and the hard floors apply. Set for a
  * high-risk model so a broad allow a human saved for everyday work cannot
  * silently vouch for a destructive call the risky model issues. Session
  * "always" allows are additionally dropped when `alsoDropSessionAllows`. */
  private ignorePersistedAllows = false;
  private alsoDropSessionAllows = false;
 /** Boundary policy for paths outside the working set + the extra working
  * directories configured for it. The working set the policy tests is cwd ∪
  * these dirs ∪ sandbox writable roots ∪ delivery roots. */
  private workspaceBoundary: "ask" | "deny-write" | "deny-read-write" = "ask";
  private additionalWorkingDirs: string[] = [];
 /** Delivery roots the session has granted (session.ts owns the list). The
  * engine keeps a copy so the boundary check counts them as in-set. */
  private deliveryRoots: string[] = [];
  /** Interactive memory write policy. Default `"explicit"`. */
  private memoryAgentWrite: "explicit" | "free";

  constructor(
    config: Pick<
      CodepilotConfig,
      "permissionMode" | "autoApprove" | "permissions" | "permissionAuto" | "memory"
    > = {},
  ) {
    this.mode = config.permissionMode ?? "ask";
    this.memoryAgentWrite = config.memory?.agentWrite === "free" ? "free" : "explicit";
    this.configRules = {
      allow: [...(config.permissions?.allow ?? []), ...(config.autoApprove ?? [])],
      ask: [...(config.permissions?.ask ?? [])],
      deny: [...(config.permissions?.deny ?? [])],
    };
    this.sessionRules = { allow: [], ask: [], deny: [] };
    this.autoMaxConsecutiveDenials = config.permissionAuto?.maxConsecutiveDenials ?? 3;
    this.autoMaxTotalDenials = config.permissionAuto?.maxTotalDenials ?? 10;
    this.workspaceBoundary = config.permissions?.workspaceBoundary ?? "ask";
    this.additionalWorkingDirs = [...(config.permissions?.additionalWorkingDirectories ?? [])];
  }

  /** True when the `auto` classifier has denied enough that we should stop
   * trusting it and prompt the human instead. Checked before consulting the
   * classifier for a soft ask. */
  classifierShouldDefer(): boolean {
    if (this.classifierConsecutiveDenials >= this.autoMaxConsecutiveDenials) return true;
    if (this.autoMaxTotalDenials > 0 && this.classifierTotalDenials >= this.autoMaxTotalDenials) {
      return true;
    }
    return false;
  }

  /** Record a classifier verdict for denial tracking. A deny advances both the
   * consecutive and total counters; any non-deny (allow / uncertain / a human
   * override) resets the consecutive streak. */
  recordClassifierVerdict(denied: boolean): void {
    if (denied) {
      this.classifierConsecutiveDenials += 1;
      this.classifierTotalDenials += 1;
    } else {
      this.classifierConsecutiveDenials = 0;
    }
  }

  /** Test/introspection: current classifier denial counters. */
  classifierDenialState(): { consecutive: number; total: number } {
    return {
      consecutive: this.classifierConsecutiveDenials,
      total: this.classifierTotalDenials,
    };
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

  /** Update the delivery roots the engine counts as in-boundary (session owns
   * the authoritative list; this is a mirror for the boundary check). */
  setDeliveryRoots(roots: readonly string[]): void {
    this.deliveryRoots = [...roots];
  }

  /** Add an extra working directory to the in-boundary set (e.g. a user "allow
   * this directory" grant). Idempotent. */
  addWorkingDirectory(dir: string): void {
    const d = resolve(dir);
    if (!this.additionalWorkingDirs.some((x) => resolve(x) === d)) {
      this.additionalWorkingDirs.push(d);
    }
  }

  /** The in-boundary roots the `workspaceBoundary` policy tests against (besides
   * cwd): extra working dirs + sandbox writable roots + delivery roots. */
  private workingSetRoots(): string[] {
    const roots: string[] = [...this.additionalWorkingDirs, ...this.deliveryRoots];
    if (this.sandbox?.policy.writableRoots) roots.push(...this.sandbox.policy.writableRoots);
    return roots;
  }

  /** Current workspace-boundary policy (introspection / tests). */
  getWorkspaceBoundary(): "ask" | "deny-write" | "deny-read-write" {
    return this.workspaceBoundary;
  }

  setWorkspaceBoundary(policy: "ask" | "deny-write" | "deny-read-write"): void {
    this.workspaceBoundary = policy;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

 /** Snapshot of all active rules (config + session), for UI display. Always
  * shows the full set regardless of high-risk stripping — the display tells the
  * user what is configured; {@link matchRules} is what preflight evaluates. */
  rules(): RuleBuckets {
    return {
      allow: [...this.sessionRules.allow, ...this.configRules.allow],
      ask: [...this.sessionRules.ask, ...this.configRules.ask],
      deny: [...this.sessionRules.deny, ...this.configRules.deny],
    };
  }

  /** Rule set used for preflight MATCHING. deny/ask are always the full set.
   * allow is stripped of persisted (config/project) rules — and optionally of
   * session "always" rules too — when a high-risk model is active, so a saved
   * blanket allow cannot vouch for the risky model's calls. */
  private matchRules(): RuleBuckets {
    if (!this.ignorePersistedAllows) return this.rules();
    const allow = this.alsoDropSessionAllows ? [] : [...this.sessionRules.allow];
    return {
      allow,
      ask: [...this.sessionRules.ask, ...this.configRules.ask],
      deny: [...this.sessionRules.deny, ...this.configRules.deny],
    };
  }

  /** Mark the active model as high-risk: persisted allow rules are ignored
   * during matching (deny/ask + floors still apply). `dropSessionAllows` also
   * ignores this-session "always allow" grants. Idempotent; call when the model
   * changes. */
  setIgnorePersistedAllows(ignore: boolean, opts?: { dropSessionAllows?: boolean }): void {
    this.ignorePersistedAllows = ignore;
    this.alsoDropSessionAllows = ignore && !!opts?.dropSessionAllows;
  }

  /** Whether persisted allow rules are currently ignored (high-risk model). */
  isIgnoringPersistedAllows(): boolean {
    return this.ignorePersistedAllows;
  }

  /** Record an "always"-style decision as a narrowed session rule (e.g.
  * `bash(npm test *)` via {@link suggestRule}, not a bare tool name), so only
  * matching calls are auto-allowed this session. Never persisted; lives only as
  * long as this PermissionEngine/Session. deny rules still override (checked
  * first, absolute). */
  addSessionRule(rule: string, effect: RuleEffect = "allow"): void {
    this.sessionRules[effect].push(rule);
    if (this.onRuleAdded) {
      try {
        this.onRuleAdded(rule, effect);
      } catch {
        /* a listener must never break rule bookkeeping */
      }
    }
  }

 /** Listener fired whenever a session rule is added (via an "always" grant or a
  * CRUD hot-load). Lets the owner re-evaluate in-flight permission prompts that
  * the new rule now covers — the pending-batch unlock. At most one listener. */
  private onRuleAdded?: (rule: string, effect: RuleEffect) => void;
  setOnRuleAdded(fn: ((rule: string, effect: RuleEffect) => void) | undefined): void {
    this.onRuleAdded = fn;
  }

 /** Add a config-scoped rule to the LIVE engine (hot-apply a CRUD edit). Fires
  * the rule-added listener so pending prompts a new allow covers unlock. The
  * caller persists it to disk separately; this only updates the in-memory set. */
  addConfigRule(rule: string, effect: RuleEffect): void {
    if (!this.configRules[effect].includes(rule)) {
      this.configRules[effect].push(rule);
    }
    if (this.onRuleAdded) {
      try {
        this.onRuleAdded(rule, effect);
      } catch {
        /* a listener must never break rule bookkeeping */
      }
    }
  }

 /** Remove a config-scoped rule from the LIVE engine (hot-apply a CRUD delete).
  * No-op when absent. */
  removeConfigRule(rule: string, effect: RuleEffect): void {
    const arr = this.configRules[effect];
    const i = arr.indexOf(rule);
    if (i >= 0) arr.splice(i, 1);
  }

  /** Remove the last `count` session rules of `effect` (LIFO) — used by the
  * Session's turn-scoped override cleanup (`allowed-tools` grants live one
  * turn). Removes all of that effect if `count` exceeds the count (no error). */
  removeLastSessionRules(effect: RuleEffect, count: number): void {
    if (count <= 0) return;
    const arr = this.sessionRules[effect];
    const toRemove = Math.min(count, arr.length);
    arr.splice(arr.length - toRemove, toRemove);
  }

  /**
  * Derive the "always allow" grant rule, narrowed to the invocation: bash →
  * safe leading prefix glob (BANNED_PREFIXES get an exact rule); file tools →
  * containing directory; else → bare tool name. Session-scoped; deny overrides.
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

    // Per-command sandbox escalation (bash `escalate_sandbox: true`): run THIS
    // one command without the OS jail. Always forces confirmation — never
    // auto-allowed, even under yolo/allow rules. Deny (above) still wins.
    if (bash && isSandboxEscalation(input)) return "ask";

 // Sensitive-path floor — applies even with sandbox off / yolo mode, above
 // every allow rule. A write/delete onto a system/credential path (/etc,
 // ~/.ssh, …) forces "ask" (not hard deny). The tool-layer counterpart of
 // checkDangerousCommand for bash.
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
      // bash naming a credential path the file tools refuse to read (~/.ssh,
      // ~/.aws/credentials, …). Checked before allow rules and the read-only /
      // sandbox auto-allows: bwrap binds `/` read-only, so the jail alone does
      // not stop the read.
      if (bash && primary && bashSensitiveReadHit(primary, cwd)) return "ask";
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

    // Workspace-boundary policy. Under deny-write/deny-read-write, a path
    // OUTSIDE the working set is hard-denied (no prompt, even under yolo).
    // Default `ask` falls through to the sandbox-expand "ask" below. Covers
    // file write/read tools and bash redirection targets.
    if (this.workspaceBoundary !== "ask") {
      const cwd = this.sandbox?.cwd ?? process.cwd();
      const roots = this.workingSetRoots();
      const outside = (p: string): boolean => !isInsideWorkingSet(p, cwd, roots);
      // Writes (both policies deny them). Only write-tier file tools and bash
      // redirections count — a read tool's `path` is not a write.
      const writePaths =
        tool.permission === "write" && tool.name !== "bash"
          ? extractWritePaths(tool.name, input)
          : [];
      const bashWrites = bash && primary ? extractRedirectWriteTargets(primary) : [];
      for (const p of [...writePaths, ...bashWrites]) {
        if (outside(p)) {
          return {
            decision: "deny",
            reason: `write outside the workspace boundary (${this.workspaceBoundary}): ${p}`,
          };
        }
      }
      // Reads (only `deny-read-write`). Bash command text is not scanned for
      // read paths — too ambiguous; the sandbox read guard still applies.
      if (this.workspaceBoundary === "deny-read-write" && tool.permission === "read" && primary) {
        if (outside(primary)) {
          return {
            decision: "deny",
            reason: `read outside the workspace boundary (deny-read-write): ${primary}`,
          };
        }
      }
    }

 // Out-of-sandbox writes always ask (even under yolo / allow rules / auto-edit)
 // so the user can grant the folder before the tool-layer path guard rejects it.
 // apply_patch may touch several paths — any one outside is enough to ask.
 // A path already inside the working set (cwd / extra working dirs / delivery
 // roots) is exempt: the user has declared it in-boundary, so don't re-prompt.
    {
      const cwd = this.sandbox?.cwd ?? process.cwd();
      const roots = this.workingSetRoots();
      const writePaths = extractWritePaths(tool.name, input);
      const candidates = writePaths.length > 0 ? writePaths : primary ? [primary] : [];
      for (const p of candidates) {
        if (isInsideWorkingSet(p, cwd, roots)) continue;
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
 // `matchRules` strips persisted allows under a high-risk model so a saved
 // blanket grant cannot auto-approve the risky model's calls.
    const matchAllow = this.matchRules().allow;
    const allow = bash
      ? bashAllowRule(matchAllow, primary!, bash)
      : firstMatch(matchAllow, tool.name, primary, input);
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
 // memory_write: default (`agentWrite: "explicit"`) asks for every
 // write so the model cannot silently grow the store mid-task. Legacy
 // `"free"` keeps project-scope silent; user scope always asks (except yolo).
    if (tool.name === "memory_write") {
      if (this.mode === "yolo") {
        return { decision: "allow", reason: "memory_write allowed under yolo" };
      }
      if (this.memoryAgentWrite === "explicit") {
        return "ask";
      }
      const scope = (input as { scope?: unknown } | null)?.scope;
      if (scope === "user") {
        return "ask";
      }
      return { decision: "allow", reason: "memory_write (project scope) is silent and auto-allowed" };
    }
    if (tool.permission === "read") {
      return { decision: "allow", reason: "read-only tool" };
    }
    // Self-declared destructive MCP tool: the server annotated it
    // `destructiveHint`, so it is NOT a side-effect-free network call and must
    // not be silently auto-allowed. Force an interactive ask (soft — auto mode
    // may still adjudicate, and an explicit allow rule matched above already
    // won). yolo is explicit user intent, so it is exempt and falls through to
    // the auto-allow below. A lying server can only omit this hint, so honouring
    // it never grants privilege — it only ever adds friction.
    if (tool.mcpMeta?.destructiveHint === true && this.mode !== "yolo") {
      return "ask";
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

 // Sandbox-confined bash: an OS-sandboxed command is already jailed, so
 // prompting adds friction without safety. Auto-allow ordinary commands and
 // still prompt genuinely dangerous ones (rm -rf, force-push, …), which can
 // damage even inside the jail. Without a sandbox, fall through to "ask".
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

  /**
   * Classify WHY {@link preflight} would ask, so `auto`/`dont-ask` differ:
   * "hard" = a safety floor forced it (auto must never allow; dont-ask denies);
   * "soft" = no floor (auto may adjudicate; dont-ask denies).
   */
  askSeverity(tool: ToolDef, input: unknown): "hard" | "soft" {
    const primary = extractPrimaryArg(tool.name, input);
    const bash = tool.name === "bash" && primary !== undefined ? parseCommand(primary) : undefined;
    const cwd = this.sandbox?.cwd ?? process.cwd();

    // Per-command sandbox escalation is always a hard floor.
    if (bash && isSandboxEscalation(input)) return "hard";

    // Sensitive / git-metadata write floor (file tools).
    if (tool.permission === "write" && tool.name !== "bash") {
      const writePaths = extractWritePaths(tool.name, input);
      const candidates = writePaths.length > 0 ? writePaths : primary ? [primary] : [];
      for (const p of candidates) {
        if (sensitivePathHit(p, "write", cwd) || gitMetadataWriteHit(p, cwd)) return "hard";
      }
    }

    // Bash command touching a sensitive system root with a mutating/dangerous verb.
    if (bash && primary) {
      for (const root of ["/etc", "/boot", "/System", "/usr/bin", "/usr/sbin", "/bin", "/sbin"]) {
        if (new RegExp(`(^|\\s|=|"|')${root}(/|\\s|$)`).test(primary)) {
          const danger = checkDangerousCommand(primary);
          if (!isReadOnlyCommand(primary) || danger.dangerous) return "hard";
          break;
        }
      }
    }

    // Out-of-sandbox write (needs an explicit folder grant).
    {
      const writePaths = extractWritePaths(tool.name, input);
      const candidates = writePaths.length > 0 ? writePaths : primary ? [primary] : [];
      for (const p of candidates) {
        if (this.sandboxExpandFor(tool, p)) return "hard";
      }
    }

    // An explicit `ask` rule the user authored is their deliberate intent.
    const ask = bash
      ? firstSegmentMatch(this.rules().ask, primary!, bash)
      : firstMatch(this.rules().ask, tool.name, primary, input);
    if (ask) return "hard";

    // Any dangerous command is a hard floor, matched allow rule or not.
    if (bash && primary && checkDangerousCommand(primary).dangerous) return "hard";

    return "soft";
  }

  /** Build a permission request to send to the user / frontend. */
  buildRequest(requestId: string, tool: ToolDef, input: unknown): PermissionRequest {
    const primary = extractPrimaryArg(tool.name, input);
    const writePaths = extractWritePaths(tool.name, input);
    let reason = describeReason(tool.permission, tool.name, input);
    if (tool.name === "memory_write") {
      const scope =
        (input as { scope?: unknown } | null)?.scope === "user" ? "user" : "project";
      reason =
        scope === "user"
          ? "memory_write (scope=user, cross-repo): durable note will apply in other projects too."
          : "memory_write (scope=project): durable note for this project only.";
    }
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
   * Mutates `req` in place; safe no-op when the job is unknown.
   */
  async enrichForDisplay(req: PermissionRequest, cwd: string): Promise<void> {
    if (!req.input || typeof req.input !== "object") return;
    const o = req.input as Record<string, unknown>;

    // apply_patch: show file list instead of the raw multi-KB patch blob.
    if (req.toolName === "apply_patch" && typeof o.patch === "string") {
      const { pathsFromApplyPatch } = await import("../tools/apply_patch.js");
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
    const { attachJobCommandForDisplay } = await import("../tools/bashJobs.js");
    const enriched = (await attachJobCommandForDisplay(cwd, o)) as Record<
      string,
      unknown
    >;
    const command = typeof enriched.command === "string" ? enriched.command : undefined;
    const status = typeof enriched.status === "string" ? enriched.status : undefined;
    if (!command) {
      req.reason = `${req.reason} (unknown job ${o.job_id})`;
      return;
    }
    req.input = enriched;
    const statusBit = status ? ` (${status})` : "";
    if (req.toolName === "bash_kill") {
      req.reason = `Stop background job ${o.job_id}${statusBit}: ${command}`;
    } else if (req.toolName === "write_stdin") {
      req.reason = `Send stdin to background job ${o.job_id}${statusBit}: ${command}`;
    } else {
      req.reason = `Read output of background job ${o.job_id}${statusBit}: ${command}`;
    }
  }

 /**
   * Directory to grant when a file write tool targets a path outside the
   * sandbox. Bash is not scanned (the OS jail enforces); expand happens on a
   * write-tool allow or delivery-root approval.
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
