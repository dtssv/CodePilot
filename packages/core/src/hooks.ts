// Hook system: user-configured shell/HTTP handlers on agent lifecycle events. user-configured shell commands
// that run at agent lifecycle points and can observe or block tool execution.
//
// Module layout:
// hooks.ts — this file: types + HookEngine (event registration + run*)
// hooks-handlers.ts — the five handler types (command/http/mcp_tool/prompt/
// agent) + decision interpretation (interpretDecision,
// extractJson, matchDiscriminator)
// hooks-trust.ts — hash-based command trust store (HookTrustStore)
//
// Supported events (with matchers):
// - SessionStart matcher: source (startup | resume | clear | compact | fork)
// - UserPromptSubmit matcher: none (fires for every user prompt)
// - PreToolUse matcher: tool_name regex ("*" matches all)
// - PostToolUse matcher: tool_name regex
// - PreCompact matcher: trigger (manual | auto)
// - PostCompact matcher: trigger (manual | auto)
// - SubagentStop matcher: agent_type (explore | worker | custom name) —
//   can BLOCK like Stop (exit 2 / decision JSON); sub-agent continues with
//   feedback, capped by `stopHookBlockCap`.
// - Notification matcher: "*" (legacy, fire-and-forget)
// - Stop matcher: "*" — can BLOCK ending the turn (exit 2 / decision JSON).
//   Session continues the agent loop with the reason as feedback, capped by
//   `stopHookBlockCap` (default 8). Payload includes `stop_hook_active`.
//   Built-in `stopVerify` (default "prompt") runs before user Stop hooks.
//
// Exit codes / JSON decision:
// - exit 0 = OK (allow / proceed)
// - exit 2 = BLOCK (PreToolUse blocks the tool call; PreCompact blocks
// compaction; UserPromptSubmit blocks the prompt; Stop blocks ending the
// turn). stderr becomes the reason shown to the model.
// - other non-zero = warning (surfaced in the tool result / event log,
// never fatal).
// - STDOUT JSON: hooks may emit a JSON object on stdout for richer
// control. See `hooks-handlers.ts` `interpretDecision` for the schema.

import type { HooksConfig, HookEntryConfig } from "./types.js";
import { HookTrustStore, hashCommand } from "./hooks-trust.js";
import {
  dispatchHook,
  interpretDecision,
  matchDiscriminator,
  type HookResolvers,
  type HookRawResult,
} from "./hooks-handlers.js";

// Re-export the trust + handler helpers so existing `from "./hooks.js"`
// imports keep resolving.
export { hashCommand, HookTrustStore } from "./hooks-trust.js";
export {
  interpretDecision,
  extractJson,
  matchDiscriminator,
  dispatchHook,
  runCommandHook,
  runHttpHook,
  runMcpToolHook,
  runPromptHook,
  runAgentHook,
} from "./hooks-handlers.js";
export type {
  HookDecision,
  HookRawResult,
  HookResolvers,
} from "./hooks-handlers.js";

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "PreCompact"
  | "PostCompact"
  | "SessionStart"
  | "SubagentStop"
  | "Notification"
  | "Stop";

/** All events the engine knows about, in a stable order for iteration. */
export const ALL_HOOK_EVENTS: HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStop",
  "Notification",
  "Stop",
];

export interface HookEntry extends HookEntryConfig {
 /** Optional per-event matcher field name override. Normally inferred
 * from the event type. Rarely needed. */
  matchField?: string;
}

export interface PreHookResult {
  action: "allow" | "block";
  reason?: string;
 /** Rewritten tool input. When present, replaces the
 * original input before execution. Only the first hook's replacement
 * wins; subsequent hooks see the rewritten input. */
  updatedInput?: unknown;
  warnings: string[];
}

export interface PostHookResult {
 /** Extra text appended to the tool result the model sees. */
  feedback?: string;
  warnings: string[];
}

export interface UserPromptHookResult {
 /** Allow the prompt through (possibly rewritten). */
  action: "allow" | "block";
 /** Rewritten prompt (only honoured on the first hook that returns one). */
  rewrittenPrompt?: string;
  reason?: string;
  warnings: string[];
}

export interface SimpleHookResult {
  warnings: string[];
}

/**
 * The default matcher field for each event type. Events not listed here
 * match against "*" (i.e. every hook for that event fires).
 */
const DEFAULT_MATCH_FIELD: Partial<Record<HookEvent, string>> = {
  PreToolUse: "tool",
  PostToolUse: "tool",
  SessionStart: "source",
  PreCompact: "trigger",
  PostCompact: "trigger",
  SubagentStop: "agent_type",
};

export class HookEngine {
  private readonly hooks: Record<HookEvent, HookEntry[]>;
  private trust: HookTrustStore;
 /** Optional resolvers for non-command/http handler types. Wired by the
 * session when MCP, provider, or sub-agent infrastructure is available. */
  private resolvers: HookResolvers = {};
 /** Told once per command about hooks skipped as untrusted, so a guard the
 * user relies on doesn't go silently inactive. */
  onWarning?: (message: string) => void;
  private warnedUntrusted = new Set<string>();
 /** When set, command hooks run under this OS sandbox policy (opt-in via
  * config.hookSandbox). Undefined = legacy unsandboxed behaviour. */
  private commandSandbox?: import("./sandbox.js").ResolvedSandbox;

  constructor(
    config: HooksConfig | undefined,
    private readonly cwd: string,
  ) {
    this.hooks = {
      SessionStart: config?.SessionStart ?? [],
      UserPromptSubmit: config?.UserPromptSubmit ?? [],
      PreToolUse: config?.PreToolUse ?? [],
      PostToolUse: config?.PostToolUse ?? [],
      PreCompact: config?.PreCompact ?? [],
      PostCompact: config?.PostCompact ?? [],
      SubagentStop: config?.SubagentStop ?? [],
      Notification: config?.Notification ?? [],
      Stop: config?.Stop ?? [],
    };
    this.trust = new HookTrustStore();
  }

  /** Enable OS-sandboxing of command hooks (opt-in). Pass the session's
   * resolved sandbox policy; undefined/`off` leaves hooks unsandboxed. */
  setCommandSandbox(policy: import("./sandbox.js").ResolvedSandbox | undefined): void {
    this.commandSandbox = policy && policy.mode !== "off" ? policy : undefined;
  }

 // ---- Hook trust (hash-based review, ) ----
 //
 // Arbitrary `command` hooks can execute any shell code. The trust
 // mechanism requires the user to approve each unique command string
 // (identified by its SHA-256 hash) before it runs. Approved hashes are
 // persisted to `.codepilot/hook_trust.json`. Unapproved hooks are
 // skipped with a warning (fail-safe: don't execute untrusted code).
 //
 // `http`/`mcp_tool`/`prompt`/`agent` handlers are exempt (they delegate
 // to already-vetted infrastructure, not arbitrary shell code).

 /** Set the trust file path (typically `<cwd>/.codepilot/hook_trust.json`).
 * When set, command hooks are gated on hash approval. Call
 * `loadTrustedHashes` after setting this. */
  setTrustFile(path: string): void {
    this.trust = new HookTrustStore(path);
  }

 /** Load approved hook hashes from the trust file. */
  async loadTrustedHashes(): Promise<void> {
    await this.trust.load();
  }

 /** Check if a command hook is trusted (hash approved). Returns true when
 * trust is not configured (backwards-compatible default). */
  isTrusted(hook: HookEntry): boolean {
    return this.trust.isTrusted(hook);
  }

 /** Approve a command hook's hash and persist to the trust file. */
  async approveHook(command: string): Promise<void> {
    await this.trust.approve(command);
  }

 /** Get the set of approved command hashes (for UI display). */
  getTrustedHashes(): Set<string> {
    return this.trust.getApproved();
  }

  hasHooks(event: HookEvent): boolean {
    return this.hooks[event].length > 0;
  }

 /** List configured hooks for an event (for `/hooks` introspection). */
  listHooks(event: HookEvent): HookEntry[] {
    return this.hooks[event].slice();
  }

 /** Run PreToolUse hooks. First blocking hook wins. A hook may also
 * rewrite the tool input via JSON `{"updatedInput": {...}}`. */
  async runPreToolUse(
    toolName: string,
    input: unknown,
  ): Promise<PreHookResult> {
    const warnings: string[] = [];
    let current = input;
    let updated: unknown | undefined;
    for (const h of this.matching("PreToolUse", toolName, { tool: toolName })) {
      const r = await this.runHook(h, {
        event: "PreToolUse",
        tool: toolName,
        input: current,
        cwd: this.cwd,
      });
      const decision = interpretDecision(r);
      if (decision.action === "block") {
        return {
          action: "block",
          reason:
            decision.reason ?? `blocked by PreToolUse hook (${h.command})`,
          warnings,
        };
      }
      if (decision.updatedInput !== undefined && updated === undefined) {
        updated = decision.updatedInput;
        current = updated;
      }
      if (r.code !== 0 && r.code !== null) {
        warnings.push(
          `PreToolUse hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`,
        );
      }
      if (r.timedOut)
        warnings.push(`PreToolUse hook "${h.command}" timed out`);
    }
    return { action: "allow", updatedInput: updated, warnings };
  }

 /** Run PostToolUse hooks; concatenates any stdout feedback. */
  async runPostToolUse(
    toolName: string,
    input: unknown,
    result: string,
    isError: boolean,
  ): Promise<PostHookResult> {
    const warnings: string[] = [];
    const feedback: string[] = [];
    for (const h of this.matching("PostToolUse", toolName, { tool: toolName })) {
      const r = await this.runHook(h, {
        event: "PostToolUse",
        tool: toolName,
        input,
        result: result.slice(0, 50_000),
        isError,
        cwd: this.cwd,
      });
      const decision = interpretDecision(r);
      if (decision.feedback) feedback.push(decision.feedback);
      else if (r.stdout.trim()) feedback.push(r.stdout.trim());
      if (r.code !== 0 && r.code !== null) {
        warnings.push(
          `PostToolUse hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`,
        );
      }
      if (r.timedOut)
        warnings.push(`PostToolUse hook "${h.command}" timed out`);
    }
    return { feedback: feedback.join("\n") || undefined, warnings };
  }

 /**
 * Run UserPromptSubmit hooks. The first hook that returns a rewritten
 * prompt wins; subsequent hooks see the rewritten text. A blocking hook
 * stops the prompt from reaching the model.
 */
  async runUserPromptSubmit(prompt: string): Promise<UserPromptHookResult> {
    const warnings: string[] = [];
    let current = prompt;
    let rewritten: string | undefined;
    for (const h of this.matching("UserPromptSubmit", "*", {})) {
      const r = await this.runHook(h, {
        event: "UserPromptSubmit",
        prompt: current,
        cwd: this.cwd,
      });
      const decision = interpretDecision(r);
      if (decision.action === "block") {
        return {
          action: "block",
          reason:
            decision.reason ??
            `blocked by UserPromptSubmit hook (${h.command})`,
          warnings,
        };
      }
      if (decision.rewrittenPrompt !== undefined && rewritten === undefined) {
        rewritten = decision.rewrittenPrompt;
        current = rewritten;
      }
      if (r.code !== 0 && r.code !== null) {
        warnings.push(
          `UserPromptSubmit hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`,
        );
      }
      if (r.timedOut)
        warnings.push(`UserPromptSubmit hook "${h.command}" timed out`);
    }
    return { action: "allow", rewrittenPrompt: rewritten, warnings };
  }

 /** Run PreCompact hooks. A blocking hook stops compaction. */
  async runPreCompact(
    trigger: "manual" | "auto",
    customInstructions?: string,
  ): Promise<PreHookResult> {
    const warnings: string[] = [];
    for (const h of this.matching("PreCompact", trigger, { trigger })) {
      const r = await this.runHook(h, {
        event: "PreCompact",
        trigger,
        custom_instructions: customInstructions,
        cwd: this.cwd,
      });
      const decision = interpretDecision(r);
      if (decision.action === "block") {
        return {
          action: "block",
          reason:
            decision.reason ?? `blocked by PreCompact hook (${h.command})`,
          warnings,
        };
      }
      if (r.code !== 0 && r.code !== null) {
        warnings.push(
          `PreCompact hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`,
        );
      }
      if (r.timedOut) warnings.push(`PreCompact hook "${h.command}" timed out`);
    }
    return { action: "allow", warnings };
  }

 /** Run PostCompact hooks. Cannot block; fire-and-forget feedback. */
  async runPostCompact(
    trigger: "manual" | "auto",
    compactSummary: string,
  ): Promise<SimpleHookResult> {
    const warnings: string[] = [];
    for (const h of this.matching("PostCompact", trigger, { trigger })) {
      const r = await this.runHook(h, {
        event: "PostCompact",
        trigger,
        compact_summary: compactSummary.slice(0, 50_000),
        cwd: this.cwd,
      });
      if (r.code !== 0 && r.code !== null) {
        warnings.push(
          `PostCompact hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`,
        );
      }
      if (r.timedOut) warnings.push(`PostCompact hook "${h.command}" timed out`);
    }
    return { warnings };
  }

 /** Run SessionStart hooks (matcher: source). Fire-and-forget. */
  async runSessionStart(
    source: "startup" | "resume" | "clear" | "compact" | "fork",
  ): Promise<SimpleHookResult> {
    const warnings: string[] = [];
    for (const h of this.matching("SessionStart", source, { source })) {
      const r = await this.runHook(h, {
        event: "SessionStart",
        source,
        cwd: this.cwd,
      });
      if (r.code !== 0 && r.code !== null) {
        warnings.push(
          `SessionStart hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`,
        );
      }
      if (r.timedOut) warnings.push(`SessionStart hook "${h.command}" timed out`);
    }
    return { warnings };
  }

 /**
   * Run SubagentStop hooks (matcher: agent_type). First blocking hook wins
   * (exit 2 or `{"decision":"block","reason":"..."}`), same contract as Stop.
   */
  async runSubagentStop(
    agentType: string,
    conclusion: string,
    extra: Record<string, unknown> = {},
  ): Promise<PreHookResult> {
    const warnings: string[] = [];
    const payload = {
      agent_type: agentType,
      conclusion: conclusion.slice(0, 50_000),
      ...extra,
    };
    const hooks = this.matching("SubagentStop", agentType, payload);
    if (hooks.length === 0) {
      return { action: "allow", warnings };
    }
    for (const h of hooks) {
      const r = await this.runHook(h, {
        event: "SubagentStop",
        cwd: this.cwd,
        ...payload,
      });
      const decision = interpretDecision(r);
      if (decision.action === "block") {
        return {
          action: "block",
          reason:
            decision.reason ??
            (r.stderr.trim() ||
              `blocked by SubagentStop hook (${h.command ?? h.prompt ?? h.agent ?? h.http ?? "handler"})`),
          warnings,
        };
      }
      if (r.code !== 0 && r.code !== null && r.code !== 2) {
        warnings.push(
          `SubagentStop hook "${h.command ?? h.prompt ?? "handler"}" exited ${r.code}: ${r.stderr.trim()}`,
        );
      }
      if (r.timedOut) warnings.push(`SubagentStop hook timed out`);
    }
    return { action: "allow", warnings };
  }

 /** Fire-and-forget notification hooks (legacy). Prefer {@link runStop} for Stop. */
  async runSimple(
    event: "Notification" | "Stop",
    payload: Record<string, unknown>,
  ): Promise<void> {
    for (const h of this.matching(event, "*", payload)) {
      await this.runHook(h, { event, cwd: this.cwd, ...payload });
    }
  }

  /**
   * Run Stop hooks at the end of a prompt. First blocking hook wins (exit 2
   * or `{"decision":"block","reason":"..."}`). When no Stop hooks are
   * configured, returns allow immediately.
   *
   * Payload should include `stop_hook_active` (true when already continuing
   * from a prior Stop block) so handlers can avoid unresolvable loops.
   */
  async runStop(payload: Record<string, unknown> = {}): Promise<PreHookResult> {
    const warnings: string[] = [];
    const hooks = this.matching("Stop", "*", payload);
    if (hooks.length === 0) {
      return { action: "allow", warnings };
    }
    for (const h of hooks) {
      const r = await this.runHook(h, {
        event: "Stop",
        cwd: this.cwd,
        ...payload,
      });
      const decision = interpretDecision(r);
      if (decision.action === "block") {
        return {
          action: "block",
          reason:
            decision.reason ??
            (r.stderr.trim() ||
              `blocked by Stop hook (${h.command ?? h.prompt ?? h.agent ?? h.http ?? "handler"})`),
          warnings,
        };
      }
      if (r.code !== 0 && r.code !== null && r.code !== 2) {
        warnings.push(
          `Stop hook "${h.command ?? h.prompt ?? "handler"}" exited ${r.code}: ${r.stderr.trim()}`,
        );
      }
      if (r.timedOut) warnings.push(`Stop hook timed out`);
    }
    return { action: "allow", warnings };
  }

 /** Wire resolvers for the new handler types. */
  setResolvers(opts: HookResolvers): void {
    this.resolvers = { ...this.resolvers, ...opts };
  }

  /** Current resolvers (for built-in stopVerify and tests). */
  getResolvers(): HookResolvers {
    return this.resolvers;
  }

 // -------------------------------------------------------------------
 // Internals
 // -------------------------------------------------------------------

  private matching(
    event: HookEvent,
    discriminator: string,
    payload: Record<string, unknown>,
  ): HookEntry[] {
    return this.hooks[event].filter((h) => {
 // SessionStart / PreCompact / PostCompact / SubagentStop: matcher
 // is matched against the event's discriminator field.
      if (DEFAULT_MATCH_FIELD[event] || h.matchField) {
        const field = h.matchField ?? DEFAULT_MATCH_FIELD[event];
        const value = field ? payload[field] : discriminator;
        return matchDiscriminator(h.matcher, String(value ?? ""));
      }
 // PreToolUse / PostToolUse: matcher is a regex against the tool name.
 // UserPromptSubmit / Notification / Stop: "*" matches all.
      if (h.matcher === "*" || h.matcher === "") return true;
      try {
        return new RegExp(h.matcher).test(discriminator);
      } catch {
        return h.matcher === discriminator;
      }
    });
  }

  private async runHook(
    hook: HookEntry,
    payload: Record<string, unknown>,
  ): Promise<HookRawResult> {
    const r = await dispatchHook(
      hook,
      payload,
      this.cwd,
      this.resolvers,
      (h) => this.trust.isTrusted(h),
      (cmd) => hashCommand(cmd).slice(0, 8),
      this.commandSandbox,
    );
    if (r.untrusted && hook.command && !this.warnedUntrusted.has(hook.command)) {
      this.warnedUntrusted.add(hook.command);
      this.onWarning?.(`${payload.event ?? "hook"} hook "${hook.command}" skipped: ${r.stderr}`);
    }
    return r;
  }
}
