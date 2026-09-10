// Hook system (claude-code style, extended): user-configured shell commands
// that run at agent lifecycle points and can observe or block tool execution.
//
// Supported events (claude-code-aligned, with matchers):
//   - SessionStart       matcher: source (startup | resume | clear | compact | fork)
//   - UserPromptSubmit   matcher: none (fires for every user prompt)
//   - PreToolUse         matcher: tool_name regex ("*" matches all)
//   - PostToolUse        matcher: tool_name regex
//   - PreCompact         matcher: trigger (manual | auto)
//   - PostCompact        matcher: trigger (manual | auto)
//   - SubagentStop       matcher: agent_type (explore | worker | custom name)
//   - Notification       matcher: "*" (legacy, fire-and-forget)
//   - Stop               matcher: "*" (legacy, fire-and-forget)
//
// Hook input (JSON on stdin):
//   - Always: { event, cwd, session_id?, timestamp }
//   - PreToolUse  : { ..., tool, input }
//   - PostToolUse : { ..., tool, input, result, isError }
//   - UserPromptSubmit: { ..., prompt }
//   - PreCompact  : { ..., trigger, custom_instructions? }
//   - PostCompact : { ..., trigger, compact_summary }
//   - SubagentStop: { ..., agent_type, conclusion }
//   - SessionStart: { ..., source }
//   - Notification: { ..., message }
//   - Stop        : { ..., reason }
//
// Exit codes / JSON decision (claude-code compatible):
//   - exit 0 = OK (allow / proceed)
//   - exit 2 = BLOCK (PreToolUse blocks the tool call; PreCompact blocks
//     compaction; UserPromptSubmit blocks the prompt). stderr becomes the
//     reason shown to the model.
//   - other non-zero = warning (surfaced in the tool result / event log,
//     never fatal).
//   - STDOUT JSON: hooks may emit a JSON object on stdout for richer
//     control. Recognised shapes:
//       { "decision": "block", "reason": "..." }   — block (any event
//          that supports blocking; takes precedence over exit code 0)
//       { "decision": "allow" }                    — explicit allow
//       PostToolUse: { "feedback": "..." }         — append to tool result
//       UserPromptSubmit: { "prompt": "..." }      — replace the prompt
//          (only the first hook's replacement wins; subsequent hooks see
//          the rewritten text)
//       PreToolUse: { "updatedInput": {...} }      — rewrite the tool input
//          (codex-style; the replacement is re-validated against the tool's
//          schema before execution)
//
// Hooks are spawned through the host shell directly (NOT the sandbox) —
// they are user-authored configuration, the same trust level as the
// config file itself.
//
// Backward compatibility: the original 4-event config shape
// (PreToolUse/PostToolUse/Notification/Stop) is fully supported. New
// events are opt-in. The `matcher` field keeps its regex semantics for
// tool-name events; for source/trigger/agent_type events it is matched
// against that event's discriminator field.

import { spawn } from "node:child_process";
import type { HooksConfig, HookEntryConfig } from "./types.js";

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
   *  from the event type. Rarely needed. */
  matchField?: string;
}

export interface PreHookResult {
  action: "allow" | "block";
  reason?: string;
  /** Rewritten tool input (codex-style). When present, replaces the
   *  original input before execution. Only the first hook's replacement
   *  wins; subsequent hooks see the rewritten input. */
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

const HOOK_TIMEOUT_MS = 10_000;

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

  constructor(
    config: HooksConfig | undefined,
    private readonly cwd: string
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
  }

  hasHooks(event: HookEvent): boolean {
    return this.hooks[event].length > 0;
  }

  /** List configured hooks for an event (for `/hooks` introspection). */
  listHooks(event: HookEvent): HookEntry[] {
    return this.hooks[event].slice();
  }

  /** Run PreToolUse hooks. First blocking hook wins. A hook may also
   *  rewrite the tool input via JSON `{"updatedInput": {...}}`. */
  async runPreToolUse(toolName: string, input: unknown): Promise<PreHookResult> {
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
          reason: decision.reason ?? `blocked by PreToolUse hook (${h.command})`,
          warnings,
        };
      }
      if (decision.updatedInput !== undefined && updated === undefined) {
        updated = decision.updatedInput;
        current = updated;
      }
      if (r.code !== 0 && r.code !== null) {
        warnings.push(`PreToolUse hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`);
      }
      if (r.timedOut) warnings.push(`PreToolUse hook "${h.command}" timed out`);
    }
    return { action: "allow", updatedInput: updated, warnings };
  }

  /** Run PostToolUse hooks; concatenates any stdout feedback. */
  async runPostToolUse(
    toolName: string,
    input: unknown,
    result: string,
    isError: boolean
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
        warnings.push(`PostToolUse hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`);
      }
      if (r.timedOut) warnings.push(`PostToolUse hook "${h.command}" timed out`);
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
          reason: decision.reason ?? `blocked by UserPromptSubmit hook (${h.command})`,
          warnings,
        };
      }
      if (decision.rewrittenPrompt !== undefined && rewritten === undefined) {
        rewritten = decision.rewrittenPrompt;
        current = rewritten;
      }
      if (r.code !== 0 && r.code !== null) {
        warnings.push(`UserPromptSubmit hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`);
      }
      if (r.timedOut) warnings.push(`UserPromptSubmit hook "${h.command}" timed out`);
    }
    return { action: "allow", rewrittenPrompt: rewritten, warnings };
  }

  /** Run PreCompact hooks. A blocking hook stops compaction. */
  async runPreCompact(
    trigger: "manual" | "auto",
    customInstructions?: string
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
          reason: decision.reason ?? `blocked by PreCompact hook (${h.command})`,
          warnings,
        };
      }
      if (r.code !== 0 && r.code !== null) {
        warnings.push(`PreCompact hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`);
      }
      if (r.timedOut) warnings.push(`PreCompact hook "${h.command}" timed out`);
    }
    return { action: "allow", warnings };
  }

  /** Run PostCompact hooks. Cannot block; fire-and-forget feedback. */
  async runPostCompact(
    trigger: "manual" | "auto",
    compactSummary: string
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
        warnings.push(`PostCompact hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`);
      }
      if (r.timedOut) warnings.push(`PostCompact hook "${h.command}" timed out`);
    }
    return { warnings };
  }

  /** Run SessionStart hooks (matcher: source). Fire-and-forget. */
  async runSessionStart(source: "startup" | "resume" | "clear" | "compact" | "fork"): Promise<SimpleHookResult> {
    const warnings: string[] = [];
    for (const h of this.matching("SessionStart", source, { source })) {
      const r = await this.runHook(h, {
        event: "SessionStart",
        source,
        cwd: this.cwd,
      });
      if (r.code !== 0 && r.code !== null) {
        warnings.push(`SessionStart hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`);
      }
      if (r.timedOut) warnings.push(`SessionStart hook "${h.command}" timed out`);
    }
    return { warnings };
  }

  /** Run SubagentStop hooks (matcher: agent_type). Fire-and-forget. */
  async runSubagentStop(
    agentType: string,
    conclusion: string
  ): Promise<SimpleHookResult> {
    const warnings: string[] = [];
    for (const h of this.matching("SubagentStop", agentType, { agent_type: agentType })) {
      const r = await this.runHook(h, {
        event: "SubagentStop",
        agent_type: agentType,
        conclusion: conclusion.slice(0, 50_000),
        cwd: this.cwd,
      });
      if (r.code !== 0 && r.code !== null) {
        warnings.push(`SubagentStop hook "${h.command}" exited ${r.code}: ${r.stderr.trim()}`);
      }
      if (r.timedOut) warnings.push(`SubagentStop hook "${h.command}" timed out`);
    }
    return { warnings };
  }

  /** Fire-and-forget notification/stop hooks (legacy). */
  async runSimple(event: "Notification" | "Stop", payload: Record<string, unknown>): Promise<void> {
    for (const h of this.matching(event, "*", payload)) {
      await this.runHook(h, { event, cwd: this.cwd, ...payload });
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private matching(
    event: HookEvent,
    discriminator: string,
    payload: Record<string, unknown>
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

  private runHook(
    hook: HookEntry,
    payload: Record<string, unknown>
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    // HTTP handler: POST the payload to the configured URL and interpret
    // the response body as the decision JSON (same schema as command stdout).
    if (hook.http) {
      return this.runHttpHook(hook, payload);
    }
    // Command handler (default).
    const command = hook.command;
    if (!command) {
      return Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "hook has neither `command` nor `http`",
        timedOut: false,
      });
    }
    return new Promise((resolve) => {
      const shell = process.platform === "win32"
        ? (process.env.COMSPEC ?? "cmd.exe")
        : "/bin/sh";
      const args = process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"];
      let child;
      try {
        child = spawn(shell, [...args, command], {
          cwd: this.cwd,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        resolve({ code: 1, stdout: "", stderr: (err as Error).message, timedOut: false });
        return;
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, hook.timeout ?? HOOK_TIMEOUT_MS);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: 1, stdout: "", stderr: e.message, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(out).toString("utf-8").slice(0, 10_000),
          stderr: Buffer.concat(err).toString("utf-8").slice(0, 10_000),
          timedOut,
        });
      });
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  /** POST the hook payload to an HTTP endpoint and interpret the response. */
  private async runHttpHook(
    hook: HookEntry,
    payload: Record<string, unknown>
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const url = hook.http!;
    const body = JSON.stringify(payload);
    try {
      const { request } = await import("node:https");
      const { request: httpRequest } = await import("node:http");
      const u = new URL(url);
      const isHttps = u.protocol === "https:";
      const reqFn = isHttps ? request : httpRequest;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), hook.timeout ?? HOOK_TIMEOUT_MS);
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = reqFn(
          {
            method: "POST",
            hostname: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: u.pathname + u.search,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "Content-Length": String(Buffer.byteLength(body)),
              ...(hook.httpHeaders ?? {}),
            },
            signal: ac.signal,
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () => {
              resolve({
                status: r.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf-8"),
              });
            });
          },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      clearTimeout(timer);
      // 4xx → treat as block (exit 2); 5xx → warning (exit 1); 2xx → OK.
      if (res.status >= 400 && res.status < 500) {
        return { code: 2, stdout: res.body, stderr: res.body, timedOut: false };
      }
      if (res.status >= 500) {
        return { code: 1, stdout: "", stderr: `hook http ${res.status}: ${res.body.slice(0, 200)}`, timedOut: false };
      }
      return { code: 0, stdout: res.body, stderr: "", timedOut: false };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // AbortError → timed out
      if (msg.includes("aborted") || msg.includes("AbortError")) {
        return { code: 1, stdout: "", stderr: "hook http timed out", timedOut: true };
      }
      return { code: 1, stdout: "", stderr: msg, timedOut: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Decision interpretation
// ---------------------------------------------------------------------------

interface HookDecision {
  action: "allow" | "block";
  reason?: string;
  feedback?: string;
  rewrittenPrompt?: string;
  /** PreToolUse: replacement input object. */
  updatedInput?: unknown;
}

/**
 * Parse a hook's stdout (and exit code) into a structured decision.
 * Exit 2 always wins as "block". Otherwise we look for a JSON object on
 * stdout; if present, its fields override the exit-code interpretation.
 */
function interpretDecision(r: {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): HookDecision {
  if (r.code === 2) {
    return { action: "block", reason: r.stderr.trim() || undefined };
  }
  // Try to parse stdout as JSON. Be tolerant: ignore leading/trailing
  // whitespace and non-JSON lines (common when a hook prints a log line
  // before the JSON).
  const json = extractJson(r.stdout);
  if (json) {
    const action = json.decision === "block" ? "block" : "allow";
    const reason = typeof json.reason === "string" ? json.reason : undefined;
    const feedback = typeof json.feedback === "string" ? json.feedback : undefined;
    const rewrittenPrompt = typeof json.prompt === "string" ? json.prompt : undefined;
    const updatedInput = "updatedInput" in json ? json.updatedInput : undefined;
    return { action, reason, feedback, rewrittenPrompt, updatedInput };
  }
  return { action: "allow" };
}

/** Extract the first JSON object from a string. Returns null if none. */
function extractJson(s: string): Record<string, unknown> | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  // Find the matching closing brace (naive — hooks are short).
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Match a discriminator value against a matcher. For SessionStart etc.,
 * the matcher may be "*" (all), a bare value ("startup"), or a regex
 * ("/^compact/"). This mirrors claude-code's matcher semantics.
 */
function matchDiscriminator(matcher: string, value: string): boolean {
  if (matcher === "*" || matcher === "") return true;
  // Regex form: /pattern/
  if (matcher.startsWith("/") && matcher.endsWith("/") && matcher.length > 1) {
    try {
      return new RegExp(matcher.slice(1, -1)).test(value);
    } catch {
      return false;
    }
  }
  // Bare value: exact match (case-insensitive, since these are enums).
  return matcher.toLowerCase() === value.toLowerCase();
}
