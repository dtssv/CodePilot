// MCP (Model Context Protocol) client — entry point.
//
// This module re-exports the public API split across the transport-specific
// sub-modules and defines the `McpManager` that owns one client per
// configured server. Existing call sites that import from `"./mcp.js"`
// continue to work unchanged; new code may prefer importing from the
// focused sub-modules (`./mcp-types.js`, `./mcp-names.js`, `./mcp-stdio.js`,
// `./mcp-sse.js`, `./mcp-http.js`).
//
// Module layout:
// mcp-types.ts — shared types, interfaces, config shapes, type guards
// mcp-names.ts — tool-name normalization + naming + @mcp: references
// mcp-jsonrpc.ts — BaseJsonRpcClient (shared JSON-RPC plumbing)
// mcp-stdio.ts — McpStdioClient (child-process stdio transport)
// mcp-sse.ts — McpSseClient (HTTP + SSE transport) + SSE parsers
// mcp-http.ts — McpHttpClient (Streamable HTTP, MCP 2025-03-26)
// mcp.ts — this file: McpManager + buildClient + re-exports

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
 * Manager owning one client per configured MCP server. Each transport is
 * implemented by its own class; both implement the `McpClient` interface.
 *
 * The manager is **fail-soft**: a single misconfigured server does not stop
 * the others from starting, and the session remains usable. Per-server
 * errors are collected and exposed via `startErrors` and the `onError`
 * listener. Callers that want to surface the failures (e.g. the session
 * layer printing a warning) can iterate over the result.
 */
export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly startErrs: McpStartError[] = [];
  private readonly errorListeners = new Set<(e: McpStartError) => void>();
 /** Reverse-request handlers, newest last. A single `McpManager` can be
  * SHARED across sessions (see mcp-pool.ts), so there can be more than one
  * live handler at a time — an MCP server's reverse request (elicitation /
  * sampling) carries no session identity, so we dispatch to the most recently
  * registered still-live handler (the active session) and fall back to earlier
  * ones if it declines. Previously this was a single field that each session
  * OVERWROTE, so a server reverse request was misrouted to whichever session
  * registered last — and kept pointing at it even after that session was
  * disposed. Each session registers on acquire and unregisters on release. */
  private readonly requestHandlers = new Set<McpServerRequestHandler>();
 /** The dispatcher actually installed on every client. Stable identity so we
  * only wire it once per client. */
  private readonly dispatch: McpServerRequestHandler = async (server, method, params) => {
    const handlers = [...this.requestHandlers];
    if (handlers.length === 0) {
      throw new Error(`no handler registered for MCP reverse request ${method} from ${server}`);
    }
    // Newest handler first (the active session), falling back to earlier ones.
    let lastErr: unknown;
    for (let i = handlers.length - 1; i >= 0; i--) {
      try {
        return await handlers[i]!(server, method, params);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`MCP reverse request ${method} from ${server} was not handled`);
  };

 /**
 * @param configs Either the legacy `Record<string, McpServerConfig>` map
 * (all entries treated as stdio) or the richer
 * `Record<string, McpServerConfigEntry>` map. Existing
 * session.ts call sites keep working.
 * @param ctx Transport context (cwd + OAuth host hook). Optional; when
 * omitted, remote servers requiring OAuth will fail with a
 * 401 instead of launching a browser flow.
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
    args: Record<string, unknown>
  ): Promise<McpInvokeResult> {
    const c = this.clients.get(server);
    if (!c) throw new Error(`unknown MCP server: ${server}`);
    return c.invokeTool({ name, arguments: args });
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

 /** Register a reverse-request handler. Returns an unregister function the
  * caller MUST invoke when it no longer wants to receive reverse requests
  * (e.g. on session dispose) so a shared manager stops routing to a dead
  * session. The stable `dispatch` fan-out is wired onto every client once;
  * individual handlers come and go through the set. Passing `null` is a no-op
  * that returns a no-op unregister (kept for back-compat with old callers). */
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
  }
}
