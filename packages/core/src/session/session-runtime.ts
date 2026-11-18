// Agent runtime wiring: persistent shell, diagnostics chain, background notices,
// batch permissions, and hook resolvers. Extracted from Session (move-only split).

import { type AgentDeps } from "../agent/agent.js";
import { createSubagentRunner } from "../subagent/subagent.js";
import type { CodepilotConfig } from "../types.js";
import type {
  PermissionResolution,
  PermissionRequest,
  SessionOptions,
} from "../types.js";
import type { HookEngine } from "../hooks/hooks.js";
import type { McpManager } from "../mcp/mcp.js";
import type { McpServerRequestHandler } from "../mcp/mcp-types.js";
import { PersistentShell } from "../sandbox/persistentShell.js";
import { wrapCommand, type ResolvedSandbox } from "../sandbox/sandbox.js";
import { chainDiagnostics } from "../tools/diagnostics.js";
import type { BackgroundSubagentMeta } from "../tools/index.js";
import type { ToolDef, ToolRegistry } from "../tools/types.js";
import type { PermissionEngine } from "../permissions/permissions.js";
import type { LspManager } from "../workspace/lsp.js";
import { buildSmallProvider } from "./session-utils.js";

type DiagnosticsProvider = SessionOptions["diagnosticsProvider"];

export type RuntimeHost = {
  cwd: string;
  config: CodepilotConfig;
  model: string;
  sandbox: ResolvedSandbox;
  persistentShell: PersistentShell | null;
  lspManager: LspManager | null;
  diagnosticsProvider: DiagnosticsProvider;
  onPermissionRequest?: (
    req: PermissionRequest,
  ) => Promise<PermissionResolution>;
  toolRegistry: ToolRegistry;
  pendingPermissionWaiters: Map<
    string,
    {
      tool: ToolDef;
      input: unknown;
      resolve: (r: PermissionResolution) => void;
    }
  >;
  hooks: HookEngine;
  mcp: McpManager | null;
  mcpRequestHandler: McpServerRequestHandler | null;
  steerSystem(text: string): void;
};

/** The long-lived shell for foreground bash, started inside the sandbox.
 * Null when the policy can't be enforced: bash then runs each command
 * one-shot, where the sandbox fallback (deny / warn) applies. */
export function startPersistentShell(host: RuntimeHost): PersistentShell | null {
  const shellEnv = host.config.shellEnv;
  if (host.sandbox.mode === "off")
    return new PersistentShell({ cwd: host.cwd, shellEnv });
  const shell = process.env.SHELL || "/bin/bash";
  const wrapped = wrapCommand(`exec ${shell} -i`, host.sandbox);
  if (!wrapped.sandboxed) return null;
  return new PersistentShell({
    cwd: host.cwd,
    shell: wrapped.shell ?? "/bin/sh",
    shellArgs: [...(wrapped.shellArgs ?? ["-c"]), wrapped.command],
    shellEnv,
  });
}

export function lspDiagnosticsTimeoutMs(host: RuntimeHost): number {
  return host.config.lsp?.diagnosticsTimeoutMs ?? 5000;
}

/** Host diagnostics (IDE) first; the session's own language servers answer
 * when the host can't (TUI, web, CLI). */
export function diagnosticsProviderChain(
  host: RuntimeHost,
): AgentDeps["diagnosticsProvider"] {
  const lsp =
    host.config.lsp?.diagnostics === false || !host.lspManager
      ? undefined
      : host.lspManager.provider(
          () => host.cwd,
          lspDiagnosticsTimeoutMs(host),
        );
  return chainDiagnostics(host.diagnosticsProvider, lsp);
}

/**
 * Stable AgentDeps handle for bash. Always forwards to the current
 * `host.persistentShell` so a mid-turn `expandWritablePath` restart
 * does not leave tools holding a closed instance ("PersistentShell closed").
 */
export function livePersistentShellHandle(
  host: RuntimeHost,
): AgentDeps["persistentShell"] {
  if (!host.persistentShell) return undefined;
  return {
    run: (command, opts) => {
      if (!host.persistentShell) {
        host.persistentShell = startPersistentShell(host);
      }
      if (!host.persistentShell) {
        return Promise.reject(
          new Error("PersistentShell unavailable after sandbox expand"),
        );
      }
      return host.persistentShell.run(command, opts);
    },
  };
}

/**
 * Deliver a background sub-agent's one-time completion summary to the parent.
 * Rides the same out-of-band system-steer channel as other background-job
 * notices (bash jobs, MCP notifications): it lands in the current turn when
 * busy, or is picked up at the start of the next turn when idle. This is a
 * single notice, not a chat channel — to iterate with the sub-agent the model
 * re-dispatches with `continue_session_id`.
 */
export function deliverBackgroundCompletion(
  host: RuntimeHost,
  meta: BackgroundSubagentMeta,
): void {
  const obj =
    meta.objective.length > 100 ? `${meta.objective.slice(0, 97)}…` : meta.objective;
  const summary = meta.summary ? `\n\n${meta.summary}` : "";
  const verb =
    meta.status === "interrupted"
      ? "was interrupted"
      : meta.status === "failed"
        ? "failed"
        : "finished";
  host.steerSystem(
    `[background sub-agent ${meta.sessionId} ${verb}] objective: ${obj}` +
      `${summary}\n\n(To continue this sub-agent, dispatch task with ` +
      `continue_session_id: "${meta.sessionId}".)`,
  );
}

/**
 * Host permission handler wrapper that implements the pending-batch unlock:
 * tracks each in-flight prompt so that when one is answered always /
 * always-project (adding a session rule), the others are re-preflighted and
 * any now-allowed waiter auto-resolves. Falls back to the raw host handler
 * when none is configured.
 */
export function onPermissionRequestWithBatch(
  host: RuntimeHost,
  req: PermissionRequest,
): Promise<PermissionResolution> {
  const handler = host.onPermissionRequest;
  if (!handler) return Promise.resolve("deny" as PermissionResolution);
  const tool = host.toolRegistry.get(req.toolName);
  return new Promise<PermissionResolution>((resolve) => {
    let settled = false;
    const done = (r: PermissionResolution): void => {
      if (settled) return;
      settled = true;
      host.pendingPermissionWaiters.delete(req.requestId);
      resolve(r);
    };
    // Only track waiters we can re-preflight (need the ToolDef + input).
    if (tool) {
      host.pendingPermissionWaiters.set(req.requestId, {
        tool,
        input: req.input,
        resolve: done,
      });
    }
    handler(req).then(done, () => done("deny" as PermissionResolution));
  });
}

/**
 * Wire prompt/agent/MCP resolvers so Stop (and other) hooks can use
 * non-command handlers. Safe to call once builtins are registered.
 */
export function wireHookResolvers(
  host: RuntimeHost,
  subagentRunner: ReturnType<typeof createSubagentRunner> | undefined,
): void {
  host.hooks.setResolvers({
    prompt: async (prompt, payload) => {
      const provider = buildSmallProvider(host.config);
      const model = host.config.smallModel ?? provider.smallModel ?? host.model;
      const body =
        `${prompt}\n\n` +
        `Respond with a single JSON object only, e.g. ` +
        `{"decision":"allow"} or {"decision":"block","reason":"…"}.\n\n` +
        `Payload:\n${JSON.stringify(payload).slice(0, 40_000)}`;
      let out = "";
      for await (const ev of provider.stream({
        model,
        messages: [{ role: "user", content: [{ type: "text", text: body }] }],
        maxTokens: 1024,
      })) {
        if (ev.kind === "text_delta") out += ev.text;
        if (ev.kind === "error") throw new Error(ev.message);
      }
      return out.trim();
    },
    agent: async (objective, payload) => {
      if (!subagentRunner) {
        return JSON.stringify({
          decision: "allow",
          reason: "agent hook: no sub-agent runner available",
        });
      }
      const result = await subagentRunner.run({
        objective:
          `${objective}\n\n` +
          `When finished, reply with JSON only: ` +
          `{"decision":"allow"} or {"decision":"block","reason":"…"}.\n\n` +
          `Context payload:\n${JSON.stringify(payload).slice(0, 20_000)}`,
        cwd: host.cwd,
        agentType: "explore",
        maxSteps: 20,
      });
      return result.conclusion.trim() || JSON.stringify({ decision: "allow" });
    },
    // Lazy: MCP starts after builtins; read `host.mcp` at call time.
    mcp: async (serverTool, args) => {
      const mgr = host.mcp;
      if (!mgr) throw new Error("MCP manager unavailable");
      const colon = serverTool.indexOf(":");
      const server = colon > 0 ? serverTool.slice(0, colon) : "";
      const tool = colon > 0 ? serverTool.slice(colon + 1) : serverTool;
      if (!server || !tool) throw new Error(`invalid mcp tool id: ${serverTool}`);
      const r = await mgr.invoke(server, tool, args, host.mcpRequestHandler);
      return (r.content ?? "").trim() || JSON.stringify(r);
    },
  });
}