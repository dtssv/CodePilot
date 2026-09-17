// Hook handler execution + decision interpretation.
//
// Extracted from `hooks.ts`: the five handler types (command, http, mcp_tool,
// prompt, agent) and the JSON-decision parser that turns handler stdout /
// exit codes into structured `{ action, reason, feedback, updatedInput }`
// results. Keeping these here lets `HookEngine` read as a clean event loop.
//
// Handler contract (see `hooks.ts` header for the full spec):
//   - command : spawn `<shell> -c <command>`, payload on stdin
//   - http    : POST payload to URL, response body = decision JSON
//   - mcp_tool: invoke `<server>:<tool>`, text result = decision JSON
//   - prompt  : send payload to small model, response = decision JSON
//   - agent   : spawn sub-agent with payload as objective
//
// All handlers return a uniform `{ code, stdout, stderr, timedOut }` shape;
// `interpretDecision` maps that onto `HookDecision`.

import { spawn } from "node:child_process";
import type { HookEntry } from "./hooks.js";

export const HOOK_TIMEOUT_MS = 10_000;

/** Uniform raw result from any handler type. */
export interface HookRawResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Resolvers for the non-command/http handler types. Wired by the session
 *  when MCP, provider, or sub-agent infrastructure is available. */
export interface HookResolvers {
  mcp?: (tool: string, payload: Record<string, unknown>) => Promise<string>;
  prompt?: (prompt: string, payload: Record<string, unknown>) => Promise<string>;
  agent?: (objective: string, payload: Record<string, unknown>) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Command handler (default)
// ---------------------------------------------------------------------------

/** Spawn the hook command through the host shell (NOT the sandbox — hooks
 *  are user-authored config at the same trust level as the config file).
 *  Payload is written to stdin as JSON; stdout/stderr are captured. */
export function runCommandHook(
  command: string,
  payload: Record<string, unknown>,
  cwd: string,
  timeout: number = HOOK_TIMEOUT_MS,
): Promise<HookRawResult> {
  return new Promise((resolve) => {
    const shell =
      process.platform === "win32"
        ? (process.env.COMSPEC ?? "cmd.exe")
        : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"];
    let child;
    try {
      child = spawn(shell, [...args, command], {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        code: 1,
        stdout: "",
        stderr: (err as Error).message,
        timedOut: false,
      });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeout);
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

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/** POST the hook payload to an HTTP endpoint and interpret the response. */
export async function runHttpHook(
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> | undefined,
  timeout: number = HOOK_TIMEOUT_MS,
): Promise<HookRawResult> {
  const body = JSON.stringify(payload);
  try {
    const { request } = await import("node:https");
    const { request: httpRequest } = await import("node:http");
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const reqFn = isHttps ? request : httpRequest;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    const res = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
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
              ...(headers ?? {}),
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
      },
    );
    clearTimeout(timer);
    // 4xx → treat as block (exit 2); 5xx → warning (exit 1); 2xx → OK.
    if (res.status >= 400 && res.status < 500) {
      return { code: 2, stdout: res.body, stderr: res.body, timedOut: false };
    }
    if (res.status >= 500) {
      return {
        code: 1,
        stdout: "",
        stderr: `hook http ${res.status}: ${res.body.slice(0, 200)}`,
        timedOut: false,
      };
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

// ---------------------------------------------------------------------------
// MCP / prompt / agent handlers
// ---------------------------------------------------------------------------

/** MCP tool handler: invoke `<server>:<tool>` with the payload as args.
 *  The tool's text result is interpreted as the decision JSON. */
export async function runMcpToolHook(
  tool: string,
  payload: Record<string, unknown>,
  resolver: HookResolvers["mcp"],
): Promise<HookRawResult> {
  if (!resolver) {
    return {
      code: 1,
      stdout: "",
      stderr: "mcp_tool hook: no MCP resolver configured",
      timedOut: false,
    };
  }
  try {
    const result = await resolver(tool, payload);
    return { code: 0, stdout: result, stderr: "", timedOut: false };
  } catch (err) {
    return { code: 1, stdout: "", stderr: (err as Error).message, timedOut: false };
  }
}

/** Prompt handler: send the payload to the small model and interpret
 *  the response text as the decision JSON. */
export async function runPromptHook(
  prompt: string,
  payload: Record<string, unknown>,
  resolver: HookResolvers["prompt"],
): Promise<HookRawResult> {
  if (!resolver) {
    return {
      code: 1,
      stdout: "",
      stderr: "prompt hook: no prompt resolver configured",
      timedOut: false,
    };
  }
  try {
    const result = await resolver(prompt, payload);
    return { code: 0, stdout: result, stderr: "", timedOut: false };
  } catch (err) {
    return { code: 1, stdout: "", stderr: (err as Error).message, timedOut: false };
  }
}

/** Agent handler: spawn a sub-agent with the payload as objective. */
export async function runAgentHook(
  objective: string,
  payload: Record<string, unknown>,
  resolver: HookResolvers["agent"],
): Promise<HookRawResult> {
  if (!resolver) {
    return {
      code: 1,
      stdout: "",
      stderr: "agent hook: no agent resolver configured",
      timedOut: false,
    };
  }
  try {
    const result = await resolver(objective, payload);
    return { code: 0, stdout: result, stderr: "", timedOut: false };
  } catch (err) {
    return { code: 1, stdout: "", stderr: (err as Error).message, timedOut: false };
  }
}

// ---------------------------------------------------------------------------
// Dispatch: pick the right handler for a hook entry
// ---------------------------------------------------------------------------

/** Execute a single hook entry, dispatching to the right handler type.
 *  Returns the uniform raw result. `isTrusted` is consulted only for command
 *  hooks; other handler types are exempt (they delegate to vetted infra). */
export async function dispatchHook(
  hook: HookEntry,
  payload: Record<string, unknown>,
  cwd: string,
  resolvers: HookResolvers,
  isTrusted: (hook: HookEntry) => boolean,
  hashPrefix: (command: string) => string,
): Promise<HookRawResult> {
  // HTTP handler: POST the payload to the configured URL and interpret
  // the response body as the decision JSON.
  if (hook.http) {
    return runHttpHook(hook.http, payload, hook.httpHeaders, hook.timeout);
  }
  // MCP tool handler: invoke an MCP server tool.
  if (hook.mcpTool) {
    return runMcpToolHook(hook.mcpTool, payload, resolvers.mcp);
  }
  // Prompt handler: send the payload to the small model.
  if (hook.prompt) {
    return runPromptHook(hook.prompt, payload, resolvers.prompt);
  }
  // Agent handler: spawn a sub-agent.
  if (hook.agent) {
    return runAgentHook(hook.agent, payload, resolvers.agent);
  }
  // Command handler (default).
  const command = hook.command;
  if (!command) {
    return {
      code: 1,
      stdout: "",
      stderr:
        "hook has no handler (command, http, mcp_tool, prompt, or agent)",
      timedOut: false,
    };
  }
  // Trust check: skip unapproved command hooks with a warning.
  if (!isTrusted(hook)) {
    return {
      code: 0,
      stdout: "",
      stderr: `hook command not trusted (hash ${hashPrefix(command)} not approved). Approve via /hooks or .codepilot/hook_trust.json.`,
      timedOut: false,
    };
  }
  return runCommandHook(command, payload, cwd, hook.timeout);
}

// ---------------------------------------------------------------------------
// Decision interpretation
// ---------------------------------------------------------------------------

export interface HookDecision {
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
export function interpretDecision(r: HookRawResult): HookDecision {
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
    const feedback =
      typeof json.feedback === "string" ? json.feedback : undefined;
    const rewrittenPrompt =
      typeof json.prompt === "string" ? json.prompt : undefined;
    const updatedInput = "updatedInput" in json ? json.updatedInput : undefined;
    return { action, reason, feedback, rewrittenPrompt, updatedInput };
  }
  return { action: "allow" };
}

/** Extract the first JSON object from a string. Returns null if none. */
export function extractJson(s: string): Record<string, unknown> | null {
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
export function matchDiscriminator(matcher: string, value: string): boolean {
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
