// Permissioned leaf-tool execution for nested calls (code_mode tools.call).
 // Same gates as the agent loop (mode → permission → PreToolUse → Zod →
 // execute → PostToolUse), without doom-loop / tool_started transcript noise.

import { randomUUID } from "node:crypto";
import type { AgentMode, PermissionDecision, PermissionRequest, PermissionResolution } from "../types.js";
import { filterToolsByMode } from "./modes.js";
import { PermissionEngine } from "../permissions/permissions.js";
import type { HookEngine } from "../hooks/hooks.js";
import type { ToolContext, ToolDef, ToolRegistry, ToolResult } from "./types.js";

export interface LeafExecuteDeps {
  tools: ToolRegistry;
  mode: AgentMode;
  permissions: PermissionEngine;
  hooks?: HookEngine;
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionResolution>;
  /** Base context (cwd, sandbox, artifacts, …) shared with the outer tool. */
  ctx: ToolContext;
  signal?: AbortSignal;
}

/**
 * Run a registered tool with full permission + hooks. Used by code_mode's
 * `tools.call` so deferred (off-wire) tools do not bypass the safety path
 * that curated helpers intentionally skip.
 */
export async function executeLeafTool(
  name: string,
  input: unknown,
  deps: LeafExecuteDeps,
): Promise<ToolResult> {
  const tool = deps.tools.get(name);
  if (!tool) {
    return { content: `unknown tool: ${name}`, isError: true };
  }

  if (filterToolsByMode([tool], deps.mode).length === 0) {
    return {
      content: `tool ${name} is not allowed in ${deps.mode} mode`,
      isError: true,
    };
  }

  let effectiveInput: unknown = input ?? {};
  const check = deps.permissions.preflight(tool, effectiveInput);
  let decision: PermissionDecision = "allow";
  let denyFeedback: string | undefined;
  let denyFeedbackIsSystem = false;

  if (check === "ask") {
    const permMode = deps.permissions.getMode();
    if (permMode === "dont-ask") {
      decision = "deny";
      denyFeedback =
        `This session is configured to run without permission prompts (dont-ask mode). ` +
        `\`${name}\` has no matching allow rule, so it was refused.`;
      denyFeedbackIsSystem = true;
    } else if (!deps.onPermissionRequest) {
      decision = "deny";
    } else {
      const reqId = `perm_${randomUUID()}`;
      const req = deps.permissions.buildRequest(reqId, tool, effectiveInput);
      await deps.permissions.enrichForDisplay(req, deps.ctx.cwd).catch(() => undefined);
      let rawDecision: PermissionDecision | "abort" = "deny";
      try {
        const resolution = await deps.onPermissionRequest(req);
        if (typeof resolution === "string") {
          rawDecision = resolution;
        } else if (resolution.decision === "abort") {
          rawDecision = "abort";
        } else {
          rawDecision = "deny";
          denyFeedback = resolution.feedback;
        }
      } catch {
        rawDecision = "deny";
      }
      const persistExpand =
        rawDecision === "always" || rawDecision === "always-project";
      if (rawDecision === "always" || rawDecision === "always-project") {
        const rule = PermissionEngine.suggestRule(tool, effectiveInput);
        if (req.sandboxEscalation) {
          deps.permissions.addSessionEscalationRule(rule);
        } else {
          deps.permissions.addSessionRule(rule, "allow");
          if (rawDecision === "always-project") {
            try {
              const { persistRule } = await import("../permissions/permissions.js");
              await persistRule(deps.ctx.cwd, rule, "allow", "repo");
            } catch {
              /* best-effort */
            }
          }
        }
        decision = "allow";
      } else if (rawDecision === "abort") {
        decision = "deny";
      } else {
        decision = rawDecision;
      }
      if (
        decision === "allow" &&
        req.sandboxExpand &&
        deps.ctx.expandSandboxWritable
      ) {
        try {
          await deps.ctx.expandSandboxWritable(req.sandboxExpand.path, {
            persist: persistExpand,
          });
        } catch (err) {
          return {
            content:
              `failed to expand sandbox writable path ` +
              `${req.sandboxExpand.path}: ${(err as Error).message}`,
            isError: true,
          };
        }
      }
    }
  } else {
    decision = check.decision;
  }

  if (decision === "deny") {
    if (denyFeedback?.trim()) {
      return {
        content: denyFeedbackIsSystem
          ? denyFeedback.trim()
          : `The user declined \`${name}\` and left this instruction: ${denyFeedback.trim()}`,
        isError: true,
      };
    }
    return { content: `permission denied for tool ${name}`, isError: true };
  }

  if (deps.hooks?.hasHooks("PreToolUse")) {
    const pre = await deps.hooks.runPreToolUse(name, effectiveInput);
    if (pre.action === "block") {
      return {
        content: `blocked by PreToolUse hook: ${pre.reason}`,
        isError: true,
      };
    }
    if (pre.updatedInput !== undefined) effectiveInput = pre.updatedInput;
  }

  const safe = tool.inputSchema.safeParse(effectiveInput);
  if (!safe.success) {
    const issues = safe.error.issues
      .slice(0, 5)
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    return {
      content: `invalid arguments for tool ${name}:\n${issues}`,
      isError: true,
    };
  }

  const nestedCtx: ToolContext = {
    ...deps.ctx,
    toolCallId: deps.ctx.toolCallId
      ? `${deps.ctx.toolCallId}:${name}`
      : `leaf_${name}`,
    signal: deps.signal ?? deps.ctx.signal,
  };

  try {
    let result = await (tool as ToolDef).execute(safe.data as never, nestedCtx);
    if (deps.hooks?.hasHooks("PostToolUse")) {
      const post = await deps.hooks
        .runPostToolUse(name, effectiveInput, result.content, result.isError === true)
        .catch(() => null);
      if (post) {
        let content = result.content;
        if (post.updatedResult !== undefined) content = post.updatedResult;
        if (post.feedback) content += `\n\n[hook feedback]\n${post.feedback}`;
        result = { ...result, content };
      }
    }
    return result;
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}
