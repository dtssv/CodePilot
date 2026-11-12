// MCP (Model Context Protocol) client — entry point.
// Re-exports the public API and defines `McpManager` (one client per server).
// Module layout: mcp-types (types/config), mcp-names (name normalization),
// mcp-jsonrpc/stdio/sse/http (transports), mcp.ts (this file).

import type {
  McpClient,
  McpInvokeResult,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceReadResult,
  McpServerConfig,
  McpServerConfigEntry,
  McpServerRequestHandler,
  McpStartError,
  McpToolDescriptor,
  McpTransportContext,
} from "./mcp-types.js";
import { isMcpHttpConfig, isMcpSseConfig } from "./mcp-types.js";
import { McpStdioClient } from "./mcp-stdio.js";
import { McpSseClient } from "./mcp-sse.js";
import { McpHttpClient } from "./mcp-http.js";

// ---------------------------------------------------------------------------
// Re-exports for back-compat callers importing from `mcp.ts`.
// ---------------------------------------------------------------------------

// Types
export type {
  McpToolDescriptor,
  McpInvokeRequest,
  McpInvokeResult,
  McpResourceDescriptor,
  McpResourceReadResult,
  McpPromptDescriptor,
  McpStartError,
  McpClient,
  McpStdioServerConfig,
  McpSseServerConfig,
  McpHttpServerConfig,
  McpServerConfigEntry,
  McpServerRequestHandler,
  McpElicitationResult,
  McpSamplingResult,
  McpTransportContext,
} from "./mcp-types.js";

// Config type guards
export { isMcpSseConfig, isMcpHttpConfig } from "./mcp-types.js";

// Names + normalization + @mcp: references
export {
  normalizeMcpToolName,
  buildMcpToolNameMap,
  mcpToolName,
  mcpResourceToolName,
  parseMcpToolName,
  MCP_REF_REGEX,
  parseMcpReference,
  resolveMcpReferences,
} from "./mcp-names.js";
// The constant lives in mcp-types (alongside the type surface); re-export
// from there rather than from mcp-names.
export { MCP_TOOL_NAME_MAX_LENGTH } from "./mcp-types.js";

// Transports
export { McpStdioClient } from "./mcp-stdio.js";
export { McpSseClient, parseSseResponse, parseSseStream } from "./mcp-sse.js";
export { McpHttpClient } from "./mcp-http.js";

// JSON-RPC base (rarely needed externally).
export { BaseJsonRpcClient } from "./mcp-jsonrpc.js";
export type { JsonRpcRequest, JsonRpcResponse } from "./mcp-jsonrpc.js";

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/** Build a client for a single server config, picking the right transport. */
function buildClient(
  name: string,
  cfg: McpServerConfigEntry,
  ctx?: McpTransportContext,
): McpClient {
  if (isMcpSseConfig(cfg)) {
    return new McpSseClient(name, cfg, ctx);
  }
  if (isMcpHttpConfig(cfg)) {
    return new McpHttpClient(name, cfg, ctx);
  }
  return new McpStdioClient(name, cfg);
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Manager owning one client per configured MCP server. Fail-soft: a single
 * misconfigured server doesn't stop the others; per-server errors surface via
 * `startErrors` and the `onError` listener.
 */
export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly startErrs: McpStartError[] = [];
  private readonly errorListeners = new Set<(e: McpStartError) => void>();
 /** Reverse-request handlers, newest last. A single `McpManager` can be
  * SHARED across sessions (see mcp-pool.ts); more than one handler can be live
  * at once. MCP reverse requests (elicitation/sampling) carry no session
  * identity, so dispatch newest-registered-first, falling back to earlier ones
  * if it declines. Each session registers on acquire, unregisters on release. */
  private readonly requestHandlers = new Set<McpServerRequestHandler>();
 /** Per-server reverse-request affinity. While a session invokes a tool on a
  * server, its handler is recorded here (ref-counted for concurrent calls) so a
  * reverse request the server initiates DURING that call routes back to the
  * triggering session, not just the newest handler. Entries clear when the call
  * ends; no live affinity → newest-first. */
  private readonly serverAffinity = new Map<
    string,
    Array<{ handler: McpServerRequestHandler; count: number }>
  >();
 /** The dispatcher actually installed on every client. Stable identity so we
  * only wire it once per client. */
  private readonly dispatch: McpServerRequestHandler = async (server, method, params) => {
    const handlers = [...this.requestHandlers];
    if (handlers.length === 0) {
      throw new Error(`no handler registered for MCP reverse request ${method} from ${server}`);
    }
    // Dispatch order: this server's in-flight affinity first, then remaining
    // handlers newest-first. Stale affinity (session disposed mid-call) is
    // skipped; no live affinity → pure newest-first (prior behaviour).
    const affinity = this.serverAffinity.get(server);
    const ordered: McpServerRequestHandler[] = [];
    const added = new Set<McpServerRequestHandler>();
    if (affinity) {
      // Most recently entered in-flight call first.
      for (let i = affinity.length - 1; i >= 0; i--) {
        const h = affinity[i]!.handler;
        if (!added.has(h) && this.requestHandlers.has(h)) {
          ordered.push(h);
          added.add(h);
        }
      }
    }
    for (let i = handlers.length - 1; i >= 0; i--) {
      const h = handlers[i]!;
      if (!added.has(h)) {
        ordered.push(h);
        added.add(h);
      }
    }
    let lastErr: unknown;
    for (const h of ordered) {
      try {
        return await h(server, method, params);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`MCP reverse request ${method} from ${server} was not handled`);
  };

 /** Tool-list-change handlers (same shared-manager multiplicity as reverse
  * requests: a tool-list change is broadcast to every live session so each can
  * re-register the server's tools into its own registry). */
  private readonly toolsChangedHandlers = new Set<(server: string) => void>();
 /** Stable fan-out installed on every client; calls each live handler. */
  private readonly toolsChangedDispatch = (server: string): void => {
    for (const h of this.toolsChangedHandlers) {
      try {
        h(server);
      } catch {
 /* a broken listener must not break the others */
      }
    }
  };

 /** Registered handlers for server notifications NOT handled internally (an
  * opt-in inbound channel turns an allowlisted one into a session message).
  * Same fan-out shape as toolsChanged so multiple sessions on a shared manager
  * each hear the notification. */
  private readonly notificationHandlers = new Set<
    (server: string, method: string, params: unknown) => void
  >();
 /** Stable fan-out installed on every client; calls each live handler. */
  private readonly notificationDispatch = (
    server: string,
    method: string,
    params: unknown,
  ): void => {
    for (const h of this.notificationHandlers) {
      try {
        h(server, method, params);
      } catch {
 /* a broken listener must not break the others */
      }
    }
  };

 /**
 * @param configs legacy `Record<string, McpServerConfig>` (all stdio) or the
 * richer `Record<string, McpServerConfigEntry>` map.
 * @param ctx transport context (cwd + OAuth host hook); omit → 401 for OAuth.
 */
  constructor(
    private readonly configs: Record<
      string,
      McpServerConfig | McpServerConfigEntry
    > = {},
    private readonly ctx?: McpTransportContext,
  ) {}

 /** Start every configured server concurrently. Failures are collected,
 * not thrown. Resolves once every server has either started or failed. */
  async startAll(): Promise<void> {
    await Promise.all(
      Object.entries(this.configs).map(async ([name, cfg]) => {
        try {
          const c = buildClient(name, cfg as McpServerConfigEntry, this.ctx);
          await c.start();
          this.wireHandler(c);
          this.clients.set(name, c);
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          const se: McpStartError = { server: name, message };
          this.startErrs.push(se);
          for (const l of this.errorListeners) {
            try {
              l(se);
            } catch {
 /* ignore */
            }
          }
          process.stderr.write(
            `[mcp] failed to start ${name}: ${message}\n`
          );
        }
      })
    );
  }

 /** Add a listener for per-server startup errors. */
  onError(listener: (e: McpStartError) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

 /** Per-server errors from `startAll`. */
  startErrors(): McpStartError[] {
    return this.startErrs.slice();
  }

  listAllTools(): McpToolDescriptor[] {
    const out: McpToolDescriptor[] = [];
    for (const c of this.clients.values()) out.push(...c.listTools());
    return out;
  }

  listAllResources(): McpResourceDescriptor[] {
    const out: McpResourceDescriptor[] = [];
    for (const c of this.clients.values()) out.push(...c.listResources());
    return out;
  }

  listAllPrompts(): McpPromptDescriptor[] {
    const out: McpPromptDescriptor[] = [];
    for (const c of this.clients.values()) out.push(...c.listPrompts());
    return out;
  }

  getClient(server: string): McpClient | null {
    return this.clients.get(server) ?? null;
  }

  async invoke(
    server: string,
    name: string,
    args: Record<string, unknown>,
    /** The calling session's reverse-request handler. When provided, any
     * reverse request the server initiates during this call routes back to this
     * handler first (per-call session affinity). Omit for calls with no session
     * (e.g. internal probes) — routing then falls back to newest-first. */
    affinityHandler?: McpServerRequestHandler | null,
  ): Promise<McpInvokeResult> {
    const c = this.clients.get(server);
    if (!c) throw new Error(`unknown MCP server: ${server}`);
    if (!affinityHandler) return c.invokeTool({ name, arguments: args });
    this.enterAffinity(server, affinityHandler);
    try {
      return await c.invokeTool({ name, arguments: args });
    } finally {
      this.exitAffinity(server, affinityHandler);
    }
  }

  /** Record a session's handler as the active reverse-request target for a
   * server while one of its tool calls is in flight. Ref-counted so concurrent
   * calls from the same session on the same server nest correctly. */
  private enterAffinity(server: string, handler: McpServerRequestHandler): void {
    let list = this.serverAffinity.get(server);
    if (!list) {
      list = [];
      this.serverAffinity.set(server, list);
    }
    const existing = list.find((e) => e.handler === handler);
    if (existing) existing.count++;
    else list.push({ handler, count: 1 });
  }

  /** Drop one in-flight reference for a server/handler pair, removing it (and
   * the server entry when empty) once no call from that session is in flight. */
  private exitAffinity(server: string, handler: McpServerRequestHandler): void {
    const list = this.serverAffinity.get(server);
    if (!list) return;
    const idx = list.findIndex((e) => e.handler === handler);
    if (idx === -1) return;
    const entry = list[idx]!;
    entry.count--;
    if (entry.count <= 0) list.splice(idx, 1);
    if (list.length === 0) this.serverAffinity.delete(server);
  }

  async readResource(
    server: string,
    uri: string
  ): Promise<McpResourceReadResult> {
    const c = this.clients.get(server);
    if (!c) throw new Error(`unknown MCP server: ${server}`);
    return c.readResource(uri);
  }

  async getPrompt(
    server: string,
    name: string,
    args?: Record<string, string>
  ): Promise<unknown> {
    const c = this.clients.get(server);
    if (!c) throw new Error(`unknown MCP server: ${server}`);
    return c.getPrompt(name, args);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
    this.clients.clear();
  }

 /** Register a reverse-request handler; returns an unregister function the
  * caller MUST invoke (e.g. on session dispose) so a shared manager stops
  * routing to a dead session. Passing `null` is a no-op (back-compat). */
  setServerRequestHandler(h: McpServerRequestHandler | null): () => void {
    if (!h) return () => {};
    this.requestHandlers.add(h);
    // Ensure every client routes reverse requests through our fan-out. Calling
    // this repeatedly with the same `dispatch` is cheap and idempotent.
    for (const c of this.clients.values()) {
      try {
        c.setServerRequestHandler(this.dispatch);
      } catch {
 /* ignore */
      }
    }
    return () => {
      this.requestHandlers.delete(h);
      // When the last handler goes away, detach the dispatcher so a server
      // reverse request fails fast with "no handler" instead of hanging.
      if (this.requestHandlers.size === 0) {
        for (const c of this.clients.values()) {
          try {
            c.setServerRequestHandler(null);
          } catch {
 /* ignore */
          }
        }
      }
    };
  }

 /** Register a handler fired when ANY server announces a tool-list change
  * (`notifications/tools/list_changed`). The client refreshes its cached list
  * first, so the handler can read the new `listAllTools()`. Returns an
  * unregister fn (symmetry with {@link setServerRequestHandler}); the
  * consumer MUST call it on dispose for a shared manager. */
  setToolsChangedHandler(h: ((server: string) => void) | null): () => void {
    if (!h) return () => {};
    this.toolsChangedHandlers.add(h);
    for (const c of this.clients.values()) this.wireToolsChanged(c);
    return () => {
      this.toolsChangedHandlers.delete(h);
      if (this.toolsChangedHandlers.size === 0) {
        for (const c of this.clients.values()) {
          try {
            c.setToolsChangedHandler?.(null);
          } catch {
 /* ignore */
          }
        }
      }
    };
  }

 /** Register a handler fired for any server notification the client does not
  * act on internally (anything other than the list_changed refreshes).
  * Used by the opt-in inbound channel to turn an allowlisted notification into
  * a session message. Returns an unregister fn; the consumer MUST call it on
  * dispose for a shared manager. */
  setNotificationHandler(
    h: ((server: string, method: string, params: unknown) => void) | null,
  ): () => void {
    if (!h) return () => {};
    this.notificationHandlers.add(h);
    for (const c of this.clients.values()) this.wireNotification(c);
    return () => {
      this.notificationHandlers.delete(h);
      if (this.notificationHandlers.size === 0) {
        for (const c of this.clients.values()) {
          try {
            c.setNotificationHandler?.(null);
          } catch {
 /* ignore */
          }
        }
      }
    };
  }

 /** Internal: ensure newly-built clients inherit the fan-out dispatcher when
  * at least one handler is registered. */
  private wireHandler(c: McpClient): void {
    if (this.requestHandlers.size > 0) {
      try {
        c.setServerRequestHandler(this.dispatch);
      } catch {
 /* ignore */
      }
    }
    this.wireToolsChanged(c);
    this.wireNotification(c);
  }

 /** Internal: route a client's tool-list-change notifications through our
  * fan-out when at least one handler is registered. Idempotent. */
  private wireToolsChanged(c: McpClient): void {
    if (this.toolsChangedHandlers.size > 0) {
      try {
        c.setToolsChangedHandler?.(this.toolsChangedDispatch);
      } catch {
 /* ignore */
      }
    }
  }

 /** Internal: route a client's non-internal notifications through our fan-out
  * when at least one notification handler is registered. Idempotent. */
  private wireNotification(c: McpClient): void {
    if (this.notificationHandlers.size > 0) {
      try {
        c.setNotificationHandler?.(this.notificationDispatch);
      } catch {
 /* ignore */
      }
    }
  }
}
