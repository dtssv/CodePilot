// Shared JSON-RPC 2.0 plumbing for MCP transports.
//
// Both the stdio and HTTP-based transports (SSE + Streamable HTTP) share the
// same lifecycle: assign ids, track pending requests, dispatch responses,
// run the `initialize` handshake, and probe capabilities. This abstract base
// implements all of that; subclasses only provide `sendFrame` (the wire write
// path) and the transport-specific `start`/`stop`.

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

// ---------------------------------------------------------------------------
// JSON-RPC envelope types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
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

// ---------------------------------------------------------------------------
// BaseJsonRpcClient
// ---------------------------------------------------------------------------

/** Mixin shared by all transports: assigns ids, tracks pending requests,
 *  dispatches responses. The transport is responsible for delivering raw
 *  JSON-RPC envelopes to `onMessage` and for shipping outbound messages
 *  through `sendFrame`. */
export abstract class BaseJsonRpcClient implements McpClient {
  abstract readonly serverName: string;
  protected nextId = 1;
  protected readonly pending = new Map<number | string, Pending>();
  protected serverInfo: { name: string; version?: string } | null = null;
  protected tools: McpToolDescriptor[] = [];
  protected resources: McpResourceDescriptor[] = [];
  protected prompts: McpPromptDescriptor[] = [];
  protected supportsResources = false;
  protected supportsPrompts = false;
  /** Optional reverse-request handler (elicitation/sampling). */
  protected serverRequestHandler: McpServerRequestHandler | null = null;

  /** Install a handler for server-initiated requests. Pass `null` to
   *  disable. When unset, such requests are rejected with code -32601
   *  (method not found). */
  setServerRequestHandler(h: McpServerRequestHandler | null): void {
    this.serverRequestHandler = h;
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
    return { content: text, isError: result.isError };
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
    return { contents: result.contents ?? [] };
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

  /** Issue a JSON-RPC request and resolve with the `result` field. */
  protected request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.sendFrame(msg);
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Send a notification (no id, no response). */
  protected notify(method: string, params: unknown): void {
    this.sendFrame({
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    } as unknown as JsonRpcRequest);
  }

  /** Dispatch a single parsed JSON-RPC envelope. Subclasses call this from
   *  their transport's read path. */
  protected onMessage(msg: JsonRpcResponse): void {
    // Server-initiated request (elicitation/sampling): has method + id.
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      void this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    // Notification (no id) — we don't subscribe to anything in this client.
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
   *  sampling/createMessage). The response is sent back as a JSON-RPC
   *  result/error on the same transport. */
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

  /** Run the standard `initialize` handshake + capability probe. Subclasses
   *  call this once the transport is up. */
  protected async handshakeAndDiscover(): Promise<void> {
    const init = (await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        elicitation: {},
        sampling: {},
      },
      clientInfo: { name: "codepilot", version: "2.0.0" },
    })) as {
      serverInfo?: { name: string; version?: string };
      capabilities?: { resources?: unknown; prompts?: unknown };
    };
    if (init.serverInfo) this.serverInfo = init.serverInfo;
    this.supportsResources = Boolean(init.capabilities?.resources);
    this.supportsPrompts = Boolean(init.capabilities?.prompts);

    // notifications/initialized has no `id` and no response.
    this.sendFrame({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "notifications/initialized",
      params: {},
    } as unknown as JsonRpcRequest);

    await this.refreshTools();
    if (this.supportsResources) await this.refreshResources().catch(() => undefined);
    if (this.supportsPrompts) await this.refreshPrompts().catch(() => undefined);
  }

  private async refreshTools(): Promise<void> {
    const res = (await this.request("tools/list", {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    if (!res.tools) {
      this.tools = [];
      return;
    }
    this.tools = res.tools.map((t) => ({
      server: this.serverName,
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  private async refreshResources(): Promise<void> {
    const res = (await this.request("resources/list", {})) as {
      resources?: Array<{
        uri: string;
        name: string;
        description?: string;
        mimeType?: string;
      }>;
    };
    this.resources = (res.resources ?? []).map((r) => ({
      server: this.serverName,
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  private async refreshPrompts(): Promise<void> {
    const res = (await this.request("prompts/list", {})) as {
      prompts?: Array<{
        name: string;
        description?: string;
        arguments?: Array<{ name: string; description?: string; required?: boolean }>;
      }>;
    };
    this.prompts = (res.prompts ?? []).map((p) => ({
      server: this.serverName,
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    }));
  }
}
