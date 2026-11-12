// Session MCP support: startMcp boots configured MCP servers and registers
// their tools; resolveSessionMcpReferences expands `@mcp:<server>/<uri>` into
// inline resource content; jsonSchemaToZod/compileJsonSchema convert the
// JSON-Schema subset MCP servers use into Zod.

import { z } from "zod";
import {
  McpManager,
  resolveMcpReferences,
  normalizeMcpToolName,
} from "./mcp.js";
import { acquireSharedMcp } from "./mcp-pool.js";
import type { McpServerRequestHandler } from "./mcp-types.js";
import type { ToolRegistry } from "./tools/types.js";
import type { CodepilotConfig, SessionOptions } from "./types.js";

/** Minimal structural view of the Session fields startMcp needs. Uses a
 * callback for the (private) tool registry to avoid a public type cycle. */
export interface SessionMcpHost {
  readonly config: CodepilotConfig;
  readonly cwd: string;
  readonly onMcpOpenAuthUrl?: SessionOptions["onMcpOpenAuthUrl"];
  readonly onMcpServerRequest?: SessionOptions["onMcpServerRequest"];
 /** Called with the session's (private) tool registry. */
  withToolRegistry<T>(fn: (registry: ToolRegistry) => T): T;
 /** Stash the unregister fn for the reverse-request handler so the session
  * can detach it on dispose. Critical for the SHARED (pooled) manager: without
  * unregistering, a disposed session's handler stays registered and a server
  * reverse request would be routed to a dead session. */
  setMcpRequestHandlerCleanup?(unregister: () => void): void;
 /** Stash the session's own reverse-request handler so the session can tag its
  * own direct `mgr.invoke` calls (e.g. the `mcp` meta-tool path) with it for
  * per-call reverse-request affinity. Null when the session has no handler. */
  setMcpRequestHandler?(handler: McpServerRequestHandler | null): void;
 /** Stash the unregister fn for the tools-changed handler (see
  * setMcpRequestHandlerCleanup — a separate slot so both cleanups survive). */
  setMcpToolsChangedCleanup?(unregister: () => void): void;
 /** Called when an allowlisted MCP server notification should be delivered into
  * the session (the opt-in inbound channel). The host synthesizes a user-role
  * message describing the notification. Only invoked when
  * `config.inboundChannels.enabled` and the notification matches the allowlist.
  */
  onMcpInboundNotification?(server: string, method: string, params: unknown): void;
 /** Stash the unregister fn for the inbound-notification handler so the session
  * can detach it on dispose (same rationale as the reverse-request cleanup). */
  setMcpNotificationCleanup?(unregister: () => void): void;
}

/** Whether an inbound MCP notification matches the allowlist. An entry matches
 * by exact `server:method`, bare `method`, or bare `server`. An empty allowlist
 * matches nothing (fail-safe: delivery requires an explicit allowlist). */
export function inboundNotificationAllowed(
  allow: string[],
  server: string,
  method: string,
): boolean {
  if (allow.length === 0) return false;
  const full = `${server}:${method}`;
  for (const entry of allow) {
    if (entry === full || entry === method || entry === server) return true;
  }
  return false;
}

/** Render an inbound MCP notification as a short user-visible message for the
 * session's steering queue. Params are JSON-encoded and truncated so an
 * oversized payload can't blow up a turn's context. */
export function formatInboundNotification(
  server: string,
  method: string,
  params: unknown,
): string {
  let detail = "";
  try {
    if (params !== undefined && params !== null) {
      const json = JSON.stringify(params);
      if (json && json !== "{}" && json !== "null") {
        detail = `\n${json.length > 1000 ? json.slice(0, 1000) + "…" : json}`;
      }
    }
  } catch {
    /* non-serializable params → omit detail */
  }
  return `Inbound notification from MCP server "${server}" (${method}).${detail}`;
}

/** Start configured MCP servers (shared process-wide) and register tools.
 * Errors are non-fatal so a broken server can't block the session. */
export async function startMcp(host: SessionMcpHost): Promise<McpManager | null> {
  if (!host.config.mcpServers) return null;
  // Allowlist: when non-empty, only listed server names may start. A configured
  // server not on the list is refused (and noted), regardless of its own config.
  const allowed = host.config.mcpAllowedServers;
  const hasAllowlist = Array.isArray(allowed) && allowed.length > 0;
  const allowSet = hasAllowlist ? new Set(allowed) : null;
  const active = Object.fromEntries(
    Object.entries(host.config.mcpServers).filter(([name, cfg]) => {
      if (cfg?.disabled) return false;
      if (allowSet && !allowSet.has(name)) {
        process.stderr.write(
          `[session] MCP server "${name}" is not in mcpAllowedServers — refusing to start\n`,
        );
        return false;
      }
      return true;
    }),
  );
  if (Object.keys(active).length === 0) return null;
  let mcp: McpManager | null = null;
  try {
    mcp = await acquireSharedMcp(active, {
      cwd: host.cwd,
      openAuthUrl: host.onMcpOpenAuthUrl ?? null,
    });
    if (!mcp) return null;
    // The session's reverse-request handler. Captured here so the tool wrappers
    // can tag their invocations with it, giving a server's reverse request
    // (elicitation / sampling) per-call affinity back to THIS session even when
    // the manager is shared across concurrent sessions.
    let sessionRequestHandler:
      | ((server: string, method: string, params: unknown) => Promise<unknown>)
      | null = null;
    if (host.onMcpServerRequest) {
      sessionRequestHandler = async (server, method, params) =>
        host.onMcpServerRequest!(server, method, params);
      const unregister = mcp.setServerRequestHandler(sessionRequestHandler);
      host.setMcpRequestHandlerCleanup?.(unregister);
      host.setMcpRequestHandler?.(sessionRequestHandler);
    }
    const mgr = mcp;
    for (const t of mgr.listAllTools()) registerMcpTool(host, mgr, t, sessionRequestHandler);
    // A server may add/remove tools mid-session (`notifications/tools/list_changed`).
    // When that happens the manager has already refreshed its cached list; we
    // drop this server's old wrapper tools and re-register the new set so the
    // provider sees the current tools. Only the changed server is touched.
    const unregisterChanged = mgr.setToolsChangedHandler((server) => {
      host.withToolRegistry((registry) => {
        for (const tool of registry.all()) {
          if (tool.source === "mcp" && tool.mcpMeta?.server === server) {
            registry.unregister(tool.name);
          }
        }
      });
      for (const t of mgr.listAllTools()) {
        if (t.server === server) registerMcpTool(host, mgr, t, sessionRequestHandler);
      }
    });
    host.setMcpToolsChangedCleanup?.(unregisterChanged);
    // Opt-in inbound channel: when enabled, relay allowlisted server
    // notifications (that the client does not act on internally) into the
    // session as a synthesized user message. Default off → no handler wired.
    const inbound = host.config.inboundChannels;
    if (inbound?.enabled && host.onMcpInboundNotification) {
      const allow = inbound.allow ?? [];
      const unregisterNotif = mgr.setNotificationHandler((server, method, params) => {
        if (inboundNotificationAllowed(allow, server, method)) {
          host.onMcpInboundNotification!(server, method, params);
        }
      });
      host.setMcpNotificationCleanup?.(unregisterNotif);
    }
    return mcp;
  } catch (err) {
    process.stderr.write(
      `[session] MCP startup failed: ${(err as Error).message}\n`
    );
    return mcp;
  }
}

/** Register one MCP tool as a thin wrapper in the session's tool registry.
 * Shared by initial startup and the tool-list-change re-registration path. */
function registerMcpTool(
  host: SessionMcpHost,
  mgr: McpManager,
  t: { server: string; name: string; description: string; inputSchema: Record<string, unknown> },
  requestHandler?: ((server: string, method: string, params: unknown) => Promise<unknown>) | null,
): void {
 // Normalize the tool name to fit provider limits (64 chars) and prevent
 // collisions between long names. The original (server, name) pair is
 // captured in the closure so invocation is unaffected.
  const registeredName = normalizeMcpToolName(t.server, t.name);
  host.withToolRegistry((registry) =>
    registry.register({
      name: registeredName,
      description: `[mcp:${t.server}] ${t.description}`,
      inputSchema: jsonSchemaToZod(t.inputSchema),
      permission: "network",
      source: "mcp",
      mcpMeta: { server: t.server, toolName: t.name, jsonSchema: t.inputSchema },
      execute: async (input) => {
        const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
        // Pass this session's reverse-request handler so a reverse request the
        // server initiates during this call routes back to this session.
        const r = await mgr.invoke(t.server, t.name, args, requestHandler ?? null);
        return { content: r.content, isError: r.isError };
      },
    })
  );
}

/** Resolve `@mcp:<server>/<uri>` references into inline resource content.
 * This lets users paste MCP resource URIs into their prompt to inject
 * server-side context (e.g. `@mcp:github/repos/foo/bar`). Best-effort:
 * failures leave the prompt untouched. */
export async function resolveSessionMcpReferences(
  mcp: McpManager | null,
  prompt: string
): Promise<string> {
  if (!mcp || !prompt.includes("@mcp:")) return prompt;
  try {
    const { text: resolved, resolved: n } = await resolveMcpReferences(prompt, mcp);
    if (n > 0) {
      return `${resolved}\n\n---\n(user prompt)\n${prompt}`;
    }
  } catch {
 /* best-effort: leave the prompt untouched */
  }
  return prompt;
}

// A tiny helper to convert a JSON Schema to a Zod schema. Only the features
// we actually expect from MCP servers (object with string/number/boolean
// properties, optional required array) are supported.
export function jsonSchemaToZod(schema: Record<string, unknown>): import("zod").ZodTypeAny {
  return compileJsonSchema(schema);
}

export function compileJsonSchema(schema: Record<string, unknown>): import("zod").ZodTypeAny {
  if (schema.type === "object" || schema.properties) {
    const shape: Record<string, import("zod").ZodTypeAny> = {};
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const [k, v] of Object.entries(props)) {
      let child = compileJsonSchema(v);
      if (!required.includes(k)) child = child.optional();
      shape[k] = child;
    }
    return z.object(shape).passthrough();
  }
  if (schema.type === "array") {
    return z.array(compileJsonSchema((schema.items as Record<string, unknown>) ?? {}));
  }
  if (schema.type === "number" || schema.type === "integer") return z.number();
  if (schema.type === "boolean") return z.boolean();
  if (Array.isArray(schema.enum)) {
    const values = schema.enum as unknown[];
    if (values.length === 0) return z.any();
 // Cast through unknown so TS doesn't reject the heterogeneous literal array.
    const literals = values.map((v) => z.literal(v as never));
    return z.union(literals as unknown as [import("zod").ZodTypeAny, import("zod").ZodTypeAny, ...import("zod").ZodTypeAny[]]);
  }
  return z.any();
}
