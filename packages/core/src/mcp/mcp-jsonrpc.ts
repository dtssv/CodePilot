// Shared JSON-RPC 2.0 plumbing for MCP transports.
// Both stdio and HTTP-based transports share the same lifecycle (assign ids,
// track pending, dispatch responses, run the `initialize` handshake, probe
// capabilities); this base implements it all, subclasses provide `sendFrame`
// and transport-specific `start`/`stop`.

import type {
  McpClient,
  McpInvokeRequest,
  McpInvokeResult,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResourceReadResult,
  McpServerRequestHandler,
  McpToolDescriptor,
} from "./mcp-types.js";
import { sanitizeUntrustedMcpText } from "./mcpResultSanitize.js";

// ---------------------------------------------------------------------------
// JSON-RPC envelope types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  /** Present for requests; omitted for notifications (JSON-RPC 2.0). */
  id?: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
 // Server-initiated requests (elicitation/sampling) carry method+params.
  method?: string;
  params?: unknown;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

/** Normalize a server's self-reported tool annotations to only the hints that
 * are explicitly boolean `true`. Any other shape (absent, null, non-boolean) is
 * dropped, so a hint can never silently change behaviour unless the server
 * clearly asserted it. Returns `undefined` when no usable hint is present (keeps
 * the descriptor clean and the "unknown" case explicit). */
function pickBoolHints(a: {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  idempotentHint?: unknown;
  openWorldHint?: unknown;
} | undefined): import("./mcp-types.js").McpToolAnnotations | undefined {
  if (!a || typeof a !== "object") return undefined;
  const out: import("./mcp-types.js").McpToolAnnotations = {};
  if (a.readOnlyHint === true) out.readOnlyHint = true;
  if (a.destructiveHint === true) out.destructiveHint = true;
  if (a.idempotentHint === true) out.idempotentHint = true;
  if (a.openWorldHint === true) out.openWorldHint = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// BaseJsonRpcClient
// ---------------------------------------------------------------------------

/** Mixin shared by all transports: assigns ids, tracks pending requests,
 * dispatches responses. The transport is responsible for delivering raw
 * JSON-RPC envelopes to `onMessage` and for shipping outbound messages
 * through `sendFrame`. */
/** Default wall-clock ceiling for a single MCP tool/resource/prompt call. */
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;
/** Default wall-clock ceiling for initialize + list discovery. */
export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 120_000;
/** Max pages when following `nextCursor` on tools/resources/prompts list. */
const MCP_LIST_MAX_PAGES = 50;
/** Soft cap on total listed items across pages (safety against runaway servers). */
const MCP_LIST_MAX_ITEMS = 10_000;

export abstract class BaseJsonRpcClient implements McpClient {
  abstract readonly serverName: string;
  protected nextId = 1;
  protected readonly pending = new Map<number | string, Pending>();
  protected serverInfo: { name: string; version?: string } | null = null;
  /** Server-provided usage instructions from `initialize` (sanitized). */
  protected instructions: string | null = null;
  protected tools: McpToolDescriptor[] = [];
  protected resources: McpResourceDescriptor[] = [];
  protected prompts: McpPromptDescriptor[] = [];
  protected supportsResources = false;
  protected supportsPrompts = false;
  /** Per-call (tool/resource/prompt) wall-clock timeout (ms). */
  protected requestTimeoutMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  /** Handshake + list discovery wall-clock timeout (ms). */
  protected startupTimeoutMs = DEFAULT_MCP_STARTUP_TIMEOUT_MS;
  /**
   * When true, advertise sampling/elicitation in `initialize`. Set before
   * `start()` when the host can handle reverse requests.
   */
  protected clientReverseRequests = false;
 /** Optional reverse-request handler (elicitation/sampling). */
  protected serverRequestHandler: McpServerRequestHandler | null = null;
 /** Optional notification: the server's tool list changed. Fired AFTER the
  * client's cached tool list has been refreshed, so the handler can read the
  * new `listTools()`. */
  protected toolsChangedHandler: ((server: string) => void) | null = null;
 /** Optional handler for server notifications this client does NOT act on
  * internally (i.e. anything other than the list_changed cache refreshes).
  * The consumer decides what to do with them (e.g. an opt-in inbound channel
  * that turns an allowlisted notification into a session message). Fired with
  * the raw method and params; never with the internally-handled notifications. */
  protected notificationHandler:
    | ((server: string, method: string, params: unknown) => void)
    | null = null;

 /** Install a handler for server-initiated requests. Pass `null` to
 * disable. When unset, such requests are rejected with code -32601
 * (method not found). */
  setServerRequestHandler(h: McpServerRequestHandler | null): void {
    this.serverRequestHandler = h;
  }

 /** Install a handler invoked when the server announces a tool-list change
  * (`notifications/tools/list_changed`). The cached list is refreshed before
  * the handler runs. Pass `null` to disable. */
  setToolsChangedHandler(h: ((server: string) => void) | null): void {
    this.toolsChangedHandler = h;
  }

 /** Install a handler for server notifications this client does not act on
  * internally. Pass `null` to disable. See {@link notificationHandler}. */
  setNotificationHandler(
    h: ((server: string, method: string, params: unknown) => void) | null,
  ): void {
    this.notificationHandler = h;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  protected abstract sendFrame(envelope: JsonRpcRequest): void;

  async invokeTool(req: McpInvokeRequest): Promise<McpInvokeResult> {
    const result = (await this.request("tools/call", {
      name: req.name,
      arguments: req.arguments ?? {},
    })) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      isError?: boolean;
    };
    if (!result || !Array.isArray(result.content)) {
      return { content: "(empty MCP response)", isError: true };
    }
    const text = result.content
      .map((c) => (c.type === "text" ? c.text ?? "" : JSON.stringify(c)))
      .join("\n");
    // Untrusted-data hardening: the result comes from an external server, so
    // strip hidden code points that could smuggle instructions to the model.
    return { content: sanitizeUntrustedMcpText(text), isError: result.isError };
  }

  listTools(): McpToolDescriptor[] {
    return this.tools.slice();
  }

  listResources(): McpResourceDescriptor[] {
    return this.resources.slice();
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    if (!this.supportsResources) {
 // Best-effort: the server may still implement it even if it didn't
 // advertise the capability. Try once and let the error propagate.
    }
    const result = (await this.request("resources/read", { uri })) as {
      contents?: McpResourceReadResult["contents"];
    };
    // Untrusted-data hardening: resource text is external server content that
    // gets inlined into the prompt (@mcp: references), so strip hidden code
    // points the same way tool results are cleaned. Binary blobs are left as-is.
    const contents = (result.contents ?? []).map((c) =>
      typeof c.text === "string" ? { ...c, text: sanitizeUntrustedMcpText(c.text) } : c,
    );
    return { contents };
  }

  listPrompts(): McpPromptDescriptor[] {
    return this.prompts.slice();
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>
  ): Promise<unknown> {
    return this.request("prompts/get", { name, arguments: args ?? {} });
  }

 /** Override the per-call (tool/resource/prompt) wall-clock timeout (ms). */
  setRequestTimeoutMs(ms: number): void {
    this.requestTimeoutMs = Math.max(1_000, Math.floor(ms));
  }

 /** Override the handshake/list discovery wall-clock timeout (ms). */
  setStartupTimeoutMs(ms: number): void {
    this.startupTimeoutMs = Math.max(1_000, Math.floor(ms));
  }

 /** Advertise sampling/elicitation only when the host can handle reverse requests. */
  setClientReverseRequests(enabled: boolean): void {
    this.clientReverseRequests = enabled;
  }

 /** Sanitized server instructions from initialize, if any. */
  getInstructions(): string | null {
    return this.instructions;
  }

 /** Issue a JSON-RPC request and resolve with the `result` field. */
  protected async request(
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    // Transports may transparently re-establish a dropped connection here
    // (default: no-op). This makes a request after a server crash reconnect
    // instead of failing permanently with "not running".
    await this.ensureConnected();
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeoutMs}ms (${method})`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.sendFrame(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

 /** Re-establish the connection if it dropped. Default: assume always
 * connected (overridden by transports that can respawn, e.g. stdio). */
  protected async ensureConnected(): Promise<void> {
    /* no-op by default */
  }


 /** Send a notification (no id, no response). */
  protected notify(method: string, params: unknown): void {
    this.sendFrame({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

 /** Dispatch a single parsed JSON-RPC envelope. Subclasses call this from
 * their transport's read path. */
  protected onMessage(msg: JsonRpcResponse): void {
 // Server-initiated request (elicitation/sampling): has method + id.
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      void this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }
 // Server notification (method, no id).
    if (msg.method !== undefined && (msg.id === undefined || msg.id === null)) {
      this.handleServerNotification(msg.method, msg.params);
      return;
    }
 // Response with no id we can't correlate — ignore.
    if (msg.id === undefined || msg.id === null) {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      p.resolve(msg.result);
    }
  }

 /** Handle a server-initiated request (elicitation/create or
 * sampling/createMessage). The response is sent back as a JSON-RPC
 * result/error on the same transport. */
  protected async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
 // `sendFrame` is typed for requests, but both transports serialize the
 // envelope verbatim — so we cast a JSON-RPC response to the request type
 // to reuse the same write path.
    const respond = (result: unknown, error?: { code: number; message: string }) => {
      const resp = error
        ? ({ jsonrpc: "2.0", id, error } as unknown as JsonRpcRequest)
        : ({ jsonrpc: "2.0", id, result } as unknown as JsonRpcRequest);
      try {
        this.sendFrame(resp);
      } catch {
 /* best-effort */
      }
    };
    if (!this.serverRequestHandler) {
      respond(null, { code: -32601, message: "method not found" });
      return;
    }
    try {
      const result = await this.serverRequestHandler(this.serverName, method, params);
      respond(result);
    } catch (e) {
      respond(null, { code: -32603, message: (e as Error).message ?? "internal error" });
    }
  }

  protected failAllPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

 /** Handle a server notification (method, no id). `notifications/*_list_changed`
  * re-list the affected server resources so mid-session adds/removes are
  * reflected, then fire the optional tools-changed handler for the consumer.
  * Any notification we do NOT act on internally is forwarded to the optional
  * notification handler (or ignored if none installed). */
  protected handleServerNotification(method: string, params?: unknown): void {
    if (method === "notifications/tools/list_changed") {
      void this.refreshTools()
        .then(() => this.toolsChangedHandler?.(this.serverName))
        .catch(() => undefined);
      return;
    }
    if (method === "notifications/resources/list_changed" && this.supportsResources) {
      // Refresh cache only — resources are exposed via mcp meta / @mcp:, not
      // per-resource FC tools, so no tool re-registration is needed.
      void this.refreshResources().catch(() => undefined);
      return;
    }
    if (method === "notifications/prompts/list_changed" && this.supportsPrompts) {
      // Refresh cache only — prompts are slash + mcp meta, not FC tools.
      void this.refreshPrompts().catch(() => undefined);
      return;
    }
    // Not internally handled → forward to the consumer's notification handler.
    this.notificationHandler?.(this.serverName, method, params);
  }

 /** Run the standard `initialize` handshake + capability probe. Subclasses
 * call this once the transport is up. */
  protected async handshakeAndDiscover(): Promise<void> {
    const startup = { timeoutMs: this.startupTimeoutMs };
    const caps: Record<string, unknown> = {};
    if (this.clientReverseRequests) {
      caps.elicitation = {};
      caps.sampling = {};
    }
    const init = (await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: caps,
        clientInfo: { name: "codepilot", version: "2.0.0" },
      },
      startup,
    )) as {
      serverInfo?: { name: string; version?: string };
      capabilities?: { resources?: unknown; prompts?: unknown };
      instructions?: unknown;
    };
    if (init.serverInfo) this.serverInfo = init.serverInfo;
    this.supportsResources = Boolean(init.capabilities?.resources);
    this.supportsPrompts = Boolean(init.capabilities?.prompts);
    if (typeof init.instructions === "string" && init.instructions.trim()) {
      this.instructions = sanitizeUntrustedMcpText(init.instructions.trim());
    } else {
      this.instructions = null;
    }

    // notifications/initialized: notification → no id, no response.
    this.notify("notifications/initialized", {});

    await this.refreshTools();
    if (this.supportsResources) await this.refreshResources().catch(() => undefined);
    if (this.supportsPrompts) await this.refreshPrompts().catch(() => undefined);
  }

  /** Follow `nextCursor` pages until exhausted or safety caps hit. */
  private async listAllPages<T>(
    method: string,
    key: string,
  ): Promise<T[]> {
    const startup = { timeoutMs: this.startupTimeoutMs };
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_LIST_MAX_PAGES; page++) {
      const params: Record<string, unknown> = {};
      if (cursor !== undefined) params.cursor = cursor;
      const res = (await this.request(method, params, startup)) as Record<string, unknown>;
      const batch = Array.isArray(res[key]) ? (res[key] as T[]) : [];
      for (const item of batch) {
        out.push(item);
        if (out.length >= MCP_LIST_MAX_ITEMS) return out;
      }
      const next = res.nextCursor;
      if (typeof next !== "string" || next.length === 0) break;
      cursor = next;
    }
    return out;
  }

  private async refreshTools(): Promise<void> {
    type RawTool = {
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      annotations?: {
        readOnlyHint?: unknown;
        destructiveHint?: unknown;
        idempotentHint?: unknown;
        openWorldHint?: unknown;
      };
    };
    const raw = await this.listAllPages<RawTool>("tools/list", "tools");
    this.tools = raw.map((t) => ({
      server: this.serverName,
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      annotations: pickBoolHints(t.annotations),
    }));
  }

  private async refreshResources(): Promise<void> {
    type RawRes = {
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    };
    const raw = await this.listAllPages<RawRes>("resources/list", "resources");
    this.resources = raw.map((r) => ({
      server: this.serverName,
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  private async refreshPrompts(): Promise<void> {
    type RawPrompt = {
      name: string;
      description?: string;
      arguments?: Array<{ name: string; description?: string; required?: boolean }>;
    };
    const raw = await this.listAllPages<RawPrompt>("prompts/list", "prompts");
    this.prompts = raw.map((p) => ({
      server: this.serverName,
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    }));
  }
}
