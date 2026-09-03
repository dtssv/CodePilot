// Permission matching: decides whether a tool invocation needs to be asked,
// auto-allowed or auto-denied. Uses a small set of rules:
//   - permission mode yolo  -> always allow
//   - tool is `read`        -> always allow
//   - tool is `write` & mode auto-edit -> allow
//   - tool name in autoApprove list     -> allow
//   - bash command matches one of the autoApprove regexes -> allow
//   - otherwise            -> ask

import type {
  CodepilotConfig,
  PermissionMode,
  PermissionRequest,
  PermissionDecision,
} from "./types.js";
import type { ToolDef, PermissionLevel } from "./tools/types.js";

export interface PermissionCheckResult {
  decision: PermissionDecision;
  reason: string;
}

export class PermissionEngine {
  private mode: PermissionMode;
  private autoApprove: string[];

  constructor(config: Pick<CodepilotConfig, "permissionMode" | "autoApprove"> = {}) {
    this.mode = config.permissionMode ?? "ask";
    this.autoApprove = config.autoApprove ?? [];
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /** Fast check used by the agent loop. */
  preflight(
    tool: ToolDef,
    input: unknown
  ): PermissionCheckResult | "ask" {
    if (this.mode === "yolo") {
      return { decision: "allow", reason: "permission mode is yolo" };
    }
    if (tool.permission === "read") {
      return { decision: "allow", reason: "read-only tool" };
    }
    if (tool.permission === "write" && this.mode === "auto-edit") {
      return { decision: "allow", reason: "auto-edit mode" };
    }
    if (this.autoApprove.some((rule) => matchRule(rule, tool.name, input))) {
      return { decision: "allow", reason: "matched autoApprove rule" };
    }
    return "ask";
  }

  /** Build a permission request to send to the user / frontend. */
  buildRequest(
    requestId: string,
    tool: ToolDef,
    input: unknown
  ): PermissionRequest {
    return {
      requestId,
      toolName: tool.name,
      input,
      reason: describeReason(tool.permission, tool.name, input),
    };
  }
}

/** Test-friendly helper: applies a single rule. */
export function matchRule(
  rule: string,
  toolName: string,
  input: unknown
): boolean {
  if (rule === toolName) return true;
  if (rule.startsWith("/") && rule.endsWith("/")) {
    // Regex rule — for bash commands.
    let body = rule.slice(1, -1);
    let flags = "";
    if (body.startsWith("^") === false) {
      // Anchor implicitly for safety.
      body = "^(?:.*\\s)?" + body;
    }
    try {
      const re = new RegExp(body, flags);
      const cmd = extractCommand(input);
      if (cmd !== undefined && re.test(cmd)) return true;
    } catch {
      /* invalid regex; skip */
    }
    return false;
  }
  // Wildcard `*` glob-ish on the tool name.
  if (rule.includes("*")) {
    const re = new RegExp("^" + rule.split("*").map(escapeRegex).join(".*") + "$");
    return re.test(toolName);
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractCommand(input: unknown): string | undefined {
  if (input && typeof input === "object" && "command" in input) {
    const c = (input as { command: unknown }).command;
    if (typeof c === "string") return c;
  }
  return undefined;
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
