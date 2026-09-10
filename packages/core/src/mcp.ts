// MCP (Model Context Protocol) client.
//
// This module implements the two transports the MCP spec defines as of
// 2024-11-05:
//
//   - **stdio**  : JSON-RPC 2.0 over newline-delimited JSON on a child
//                  process's stdout. The historical transport, used by most
//                  existing servers.
//   - **SSE**    : HTTP POST to a per-session endpoint, plus a long-lived GET
//                  that returns server-sent events. The newer transport
//                  designed for remote / HTTP-friendly deployments.
//
// Both transports share the same lifecycle (initialize → notifications/initialized
// → tools/list → on demand: tools/call, resources/list, resources/read,
// prompts/list, prompts/get) and the same JSON-RPC 2.0 envelope. They are
// modelled behind the `McpClient` interface so the manager (and the
// session layer that wires tools into the registry) does not have to care
// which transport is in use.
//
// Design notes:
//   - We do not pull in a YAML/JSON-Schema or HTTP library; the SSE and
//     stdio clients are hand-rolled over Node's `http`/`https` modules so
//     the package stays dependency-free.
//   - The `McpManager` is fail-soft: a single misconfigured server does not
//     stop the others from starting. Per-server errors are surfaced through
//     `startErrors()` so the host can show a warning, and through the
//     `mcp_error` event channel.
//   - Resources are exposed two ways: (1) directly via
//     `client.readResource(uri)`, and (2) auto-wrapped as tools named
//     `mcp__<server>__resource__<name>`. The tool form keeps the existing
//     tool-registry model intact; agents that want structured resources
//     can still call the lower-level API.
//   - Prompts are exposed via `client.listPrompts()` / `client.getPrompt()`
//     only; they are not auto-wrapped as tools, because the protocol treats
//     prompts as user-injected context (not model-callable functions).

import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { URL } from "node:url";
import type { McpServerConfig } from "./types.js";
import {
  OAuthTransportHelper,
  type RawHttpResponse,
} from "./mcpOAuthTransport.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A tool advertised by an MCP server. */
export interface McpToolDescriptor {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpInvokeRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpInvokeResult {
  content: string;
  isError?: boolean;
}

/** A resource advertised by an MCP server. Mirrors the JSON shape of the
 *  `resources/list` response. */
export interface McpResourceDescriptor {
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** A prompt advertised by an MCP server. */
export interface McpPromptDescriptor {
  server: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** Result of a `resources/read` call. */
export interface McpResourceReadResult {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string; // base64
  }>;
}

/** Per-server startup failure. Returned by `McpManager.startErrors()`. */
export interface McpStartError {
  server: string;
  message: string;
}

/** A unified client interface — both transports implement it. */
export interface McpClient {
  /** Display name of the server (the key in the config map). */
  readonly serverName: string;
  /** Start the transport and complete the `initialize` handshake. */
  start(): Promise<void>;
  /** Shut the transport down. Safe to call multiple times. */
  stop(): Promise<void>;
  /** Tools advertised by the server (cached after `start`). */
  listTools(): McpToolDescriptor[];
  /** Invoke a tool by name with the given arguments. */
  invokeTool(req: McpInvokeRequest): Promise<McpInvokeResult>;
  /** Resources advertised by the server. May be empty if the server does
   *  not implement the resources capability. */
  listResources(): McpResourceDescriptor[];
  /** Read a resource by URI. Throws if the server returns an error. */
  readResource(uri: string): Promise<McpResourceReadResult>;
  /** Prompts advertised by the server. May be empty. */
  listPrompts(): McpPromptDescriptor[];
  /** Render a prompt by name with the given arguments. */
  getPrompt(name: string, args?: Record<string, string>): Promise<unknown>;
  /** Install a handler for server-initiated requests (elicitation,
   *  sampling). When unset, such requests are rejected. */
  setServerRequestHandler(h: McpServerRequestHandler | null): void;
}

// ---------------------------------------------------------------------------
// Server-config types (stdio form is the original, exported from types.ts;
// SSE form is new and lives here so we don't have to touch types.ts).
// ---------------------------------------------------------------------------

/** Stdio MCP server — spawns `command` with `args`, talks JSON-RPC over its
 *  stdio. The shape is what `McpServerConfig` in `types.ts` already is. */
export type McpStdioServerConfig = McpServerConfig;

/** SSE MCP server — POSTs JSON-RPC to `url`, opens a long-lived GET for the
 *  per-session event stream returned in the `initialize` response. */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  /** Optional HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
}

/** Discriminated union of all supported server-config shapes. We treat a
 *  config object with a `type: "sse"` as SSE, `type: "http"` as Streamable
 *  HTTP, anything else as stdio. This keeps existing configs (which have no
 *  `type` field) backward compatible. */
export type McpServerConfigEntry =
  | McpStdioServerConfig
  | McpSseServerConfig
  | McpHttpServerConfig;

/** Streamable HTTP MCP server (MCP 2025-03-26): a single endpoint that
 *  answers POSTs with either JSON or an SSE stream, tracks sessions via the
 *  `mcp-session-id` header, and accepts DELETE to end the session. */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** Type guard. */
export function isMcpSseConfig(
  cfg: McpServerConfigEntry
): cfg is McpSseServerConfig {
  return Boolean(cfg) && (cfg as McpSseServerConfig).type === "sse";
}

/** Type guard. */
export function isMcpHttpConfig(
  cfg: McpServerConfigEntry
): cfg is McpHttpServerConfig {
  return Boolean(cfg) && (cfg as McpHttpServerConfig).type === "http";
}

// ---------------------------------------------------------------------------
// Shared JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
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

/**
 * Handler for server-initiated (reverse) requests such as
 * `elicitation/create` and `sampling/createMessage`. Returning a value
 * resolves the request; throwing rejects it with a JSON-RPC error.
 */
export type McpServerRequestHandler = (
  serverName: string,
  method: string,
  params: unknown
) => Promise<unknown>;

/** Result shape for an `elicitation/create` response. */
export interface McpElicitationResult {
  /** The user's action: "accept" to return the data, "decline" to refuse
   *  without data, "cancel" to abort the request entirely. */
  action: "accept" | "decline" | "cancel";
  /** The elicited data, when `action === "accept"`. */
  data?: Record<string, unknown>;
}

/** Result shape for a `sampling/createMessage` response. */
export interface McpSamplingResult {
  role: "assistant";
  content: { type: "text"; text: string } | { type: "image"; data: string; mimeType?: string };
  /** Provider-specific model identifier that produced the message. */
  model?: string;
  /** Optional stop reason. */
  stopReason?: "end_turn" | "stop_sequence" | "max_tokens" | string;
}

/** Mixin shared by both transports: assigns ids, tracks pending requests,
 *  dispatches responses. The transport is responsible for delivering raw
 *  JSON-RPC envelopes to `onMessage` and for shipping outbound messages
 *  through `sendFrame`. */
abstract class BaseJsonRpcClient implements McpClient {
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

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

/** Spawn `command` with `args`, talk JSON-RPC over its stdio. */
export class McpStdioClient extends BaseJsonRpcClient {
  private proc: ChildProcess | null = null;
  private buffer = "";

  constructor(
    public readonly serverName: string,
    private readonly config: McpStdioServerConfig
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.proc) return;
    if (!this.config.command) {
      throw new Error(
        `MCP stdio server ${this.serverName}: command is required (use type "http" or "sse" with a url for remote servers)`
      );
    }
    const command = this.config.command;
    const proc = spawn(command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", (chunk: string) => {
      process.stderr.write(`[mcp:${this.serverName}] ${chunk}`);
    });
    // Listen for spawn-time errors (e.g. ENOENT). Without a handler Node
    // throws an uncaught exception; we need to surface the failure into
    // the pending map so the awaiting handshake rejects.
    proc.on("error", (err) => {
      this.failAllPending(err);
      this.proc = null;
    });
    proc.on("exit", (code) => {
      this.failAllPending(
        new Error(`MCP server ${this.serverName} exited (code ${code})`)
      );
      this.proc = null;
    });
    await this.handshakeAndDiscover();
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      this.proc.stdin!.end();
    } catch {
      /* ignore */
    }
    const proc = this.proc;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve();
      }, 1000);
      proc.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
  }

  protected sendFrame(msg: JsonRpcRequest): void {
    if (!this.proc || !this.proc.stdin) {
      throw new Error(`MCP ${this.serverName} is not running`);
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// SSE transport (HTTP + server-sent events, MCP 2024-11-05)
// ---------------------------------------------------------------------------

/**
 * HTTP + SSE transport. The server's URL is treated as the *control plane*:
 *
 *  1. POST `{jsonrpc,method,params,id}` to it as `Content-Type: application/json`
 *     and `Accept: application/json, text/event-stream`. The response is either
 *     a JSON body (for short, non-streaming replies) or an SSE stream that
 *     carries one or more events, the last of which carries the JSON-RPC
 *     response. The spec lets the server decide per request; we accept both.
 *  2. When the server's `initialize` response carries an `endpoint` field in
 *     the `_meta` map (or in a `session`/`endpoint` header), subsequent calls
 *     can be POSTed to that per-session URL instead of the control URL. We
 *     honour both shapes and fall back to the control URL when no per-session
 *     endpoint is advertised.
 *  3. If the server returns a long-lived event stream after `initialize`
 *     (carrying `endpoint` and/or `session` events), we keep it open in the
 *     background and dispatch any server-pushed JSON-RPC envelopes through
 *     the same `onMessage` path.
 *
 *  This is intentionally a minimal, focused implementation — enough to talk
 *  to a conforming server in practice. We do not implement the full
 *  streamable-HTTP extension; the spec has been moving quickly and the
 *  common case today is "POST returns a JSON or SSE response with the
 *  result".
 */
export class McpSseClient extends BaseJsonRpcClient {
  /** Per-session endpoint, if advertised by the server. */
  private endpoint: string | null = null;
  /** AbortController for the long-lived GET (if any). */
  private sseAbort: AbortController | null = null;
  /** Resolved on `stop()`. */
  private stopped = false;
  /** Pending POSTs keyed by id, so we can match responses that come back on
   *  the SSE stream rather than the POST response body. */
  private postInflight = new Map<number | string, {
    resolve: (v: { status: number; body: string; contentType: string }) => void;
    reject: (e: Error) => void;
  }>();
  /** Headers for outbound requests. */
  private readonly headers: Record<string, string>;
  /** Parsed base URL (control plane). */
  private readonly baseUrl: URL;
  /** OAuth helper, if the host enabled it. */
  private readonly oauth: OAuthTransportHelper | null;

  constructor(
    public readonly serverName: string,
    private readonly config: McpSseServerConfig,
    ctx?: McpTransportContext,
  ) {
    super();
    if (!config.url) {
      throw new Error(`MCP SSE server ${serverName}: url is required`);
    }
    this.baseUrl = new URL(config.url);
    this.headers = { ...(config.headers ?? {}) };
    this.oauth =
      ctx && ctx.openAuthUrl
        ? new OAuthTransportHelper(
            serverName,
            ctx.cwd,
            {
              oauthClientId: (config as McpServerConfig).oauthClientId,
              oauthClientSecret: (config as McpServerConfig).oauthClientSecret,
              oauthScopes: (config as McpServerConfig).oauthScopes,
            },
            ctx.openAuthUrl,
          )
        : null;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error(`MCP ${this.serverName} already stopped`);
    await this.handshakeAndDiscover();
    // After initialize, try to open the long-lived event stream. The spec
    // says the server may push an `endpoint` event on the stream; if it
    // does, we record it. If the stream fails, that's OK — the POST path
    // works on its own.
    this.openEventStream().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sseAbort) {
      try {
        this.sseAbort.abort();
      } catch {
        /* ignore */
      }
      this.sseAbort = null;
    }
    this.failAllPending(new Error(`MCP ${this.serverName} stopped`));
  }

  protected sendFrame(msg: JsonRpcRequest): void {
    if (this.stopped) throw new Error(`MCP ${this.serverName} is stopped`);
    // Fire-and-await the POST. Errors surface to the pending map as
    // rejections, exactly like a stdio transport would surface a write
    // failure.
    this.postJson(msg).catch((err) => {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * POST a JSON-RPC envelope and resolve with the raw HTTP response. Handles
   * both the JSON-body reply case and the SSE-stream reply case (the latter
   * is dispatched onto `onMessage` and the POST resolves as soon as the
   * matching response frame arrives).
   */
  private postJson(
    msg: JsonRpcRequest
  ): Promise<{ status: number; body: string; contentType: string }> {
    return (async () => {
      const res = await this.doPost(msg);
      // 401 with WWW-Authenticate → OAuth flow + one retry.
      if (res.status === 401 && this.oauth) {
        const newToken = await this.oauth.handle401({
          status: res.status,
          headers: { "www-authenticate": res.wwwAuthenticate ?? undefined },
          body: res.body,
        });
        if (newToken) {
          return this.doPost(msg);
        }
      }
      return res;
    })().catch((err) => {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
      throw err;
    });
  }

  /** A single POST attempt. Dispatches the response body to `onMessage`
   *  (whether JSON or SSE-framed) and resolves with status/body/contentType
   *  + the WWW-Authenticate header (for the 401 path). */
  private async doPost(
    msg: JsonRpcRequest,
  ): Promise<{ status: number; body: string; contentType: string; wwwAuthenticate?: string }> {
    const target = this.endpoint ? new URL(this.endpoint, this.baseUrl) : this.baseUrl;
    const isHttps = target.protocol === "https:";
    const body = JSON.stringify(msg);
    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": String(Buffer.byteLength(body)),
      ...this.strippedAuthHeaders(this.headers),
    };
    if (this.oauth) {
      await this.oauth.attachAuth(baseHeaders);
    }
    const opts: RequestOptions | HttpsRequestOptions = {
      method: "POST",
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers: baseHeaders,
    };
    const reqFn = isHttps ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = reqFn(opts, (res) => {
        const contentType = String(res.headers["content-type"] ?? "");
        const wwwAuth = Array.isArray(res.headers["www-authenticate"])
          ? res.headers["www-authenticate"].join(", ")
          : (res.headers["www-authenticate"] as string | undefined);
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const out = Buffer.concat(chunks).toString("utf-8");
          if ((res.statusCode ?? 0) >= 400) {
            // Don't dispatch the body on error; the caller (postJson) decides
            // whether to retry via OAuth or reject the pending entry.
            resolve({ status: res.statusCode ?? 0, body: out, contentType, wwwAuthenticate: wwwAuth });
            return;
          }
          if (contentType.includes("text/event-stream")) {
            // The response IS an SSE stream. We parse it inline and look
            // for the JSON-RPC response frame.
            const frames = parseSseResponse(out);
            for (const f of frames) {
              this.onMessage(f);
            }
            // The POST has been "answered" once the stream ends; the
            // pending entry is already gone because onMessage dispatched
            // it.
          } else {
            // JSON body — try to parse as the JSON-RPC response directly.
            try {
              const parsed = JSON.parse(out) as JsonRpcResponse;
              this.onMessage(parsed);
            } catch {
              // Not a JSON-RPC envelope — reject the pending entry.
              const p = this.pending.get(msg.id);
              if (p) {
                this.pending.delete(msg.id);
                p.reject(
                  new Error(
                    `MCP ${this.serverName} returned non-JSON response: ${out.slice(0, 200)}`
                  )
                );
              }
            }
          }
          resolve({ status: res.statusCode ?? 0, body: out, contentType, wwwAuthenticate: wwwAuth });
        });
        res.on("error", (err) => {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p.reject(err);
          }
          reject(err);
        });
      });
      req.on("error", (err) => {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.reject(err);
        }
        reject(err);
      });
      req.write(body);
      req.end();
    });
  }

  /** Strip the headers we manage ourselves from the user-supplied bag, so
   *  the user can't accidentally override `Content-Type` etc. */
  private strippedAuthHeaders(h: Record<string, string>): Record<string, string> {
    const deny = new Set([
      "content-type",
      "content-length",
      "accept",
      "host",
      "connection",
    ]);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      if (deny.has(k.toLowerCase())) continue;
      out[k] = v;
    }
    return out;
  }

  /** Open the long-lived event stream (SSE GET). The server uses this to
   *  push server-initiated JSON-RPC envelopes (e.g. `notifications/...`) or
   *  to deliver responses to POSTs in streamable-HTTP mode. */
  private openEventStream(): Promise<void> {
    return new Promise((resolve) => {
      const target = this.endpoint ? new URL(this.endpoint, this.baseUrl) : this.baseUrl;
      const isHttps = target.protocol === "https:";
      const opts: RequestOptions | HttpsRequestOptions = {
        method: "GET",
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        headers: {
          Accept: "text/event-stream",
          ...this.strippedAuthHeaders(this.headers),
        },
      };
      const reqFn = isHttps ? httpsRequest : httpRequest;
      const ac = new AbortController();
      this.sseAbort = ac;
      const req = reqFn(opts, (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          // Server doesn't support the event stream; not fatal.
          resolve();
          return;
        }
        const ct = String(res.headers["content-type"] ?? "");
        if (!ct.includes("text/event-stream")) {
          resolve();
          return;
        }
        // Parse SSE frames as they arrive. We resolve immediately; the
        // background consumer below owns the stream for the lifetime of
        // the connection.
        (async () => {
          try {
            for await (const frame of parseSseStream(res, ac.signal)) {
              if (frame.event === "endpoint") {
                this.endpoint = frame.data;
                continue;
              }
              if (frame.event === "message" || frame.event === "") {
                try {
                  const parsed = JSON.parse(frame.data) as JsonRpcResponse;
                  this.onMessage(parsed);
                } catch {
                  /* ignore non-JSON frames */
                }
              }
            }
          } catch {
            /* stream closed or aborted */
          }
        })();
        resolve();
      });
      req.on("error", () => resolve());
      ac.signal.addEventListener("abort", () => {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      });
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------
// SSE parsing helpers
// ---------------------------------------------------------------------------

/** Tiny SSE parser used by the POST-response path. Parses a complete SSE
 *  blob (the body of a POST response) into JSON-RPC envelopes. */
function parseSseResponse(body: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  const lines = body.split(/\r?\n/);
  let dataLines: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line === "") {
      if (dataLines.length > 0) {
        const data = dataLines.join("\n");
        try {
          out.push(JSON.parse(data) as JsonRpcResponse);
        } catch {
          /* ignore non-JSON frames */
        }
        dataLines = [];
      }
      continue;
    }
    if (line.startsWith(":")) continue; // comment
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
  }
  if (dataLines.length > 0) {
    try {
      out.push(JSON.parse(dataLines.join("\n")) as JsonRpcResponse);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Async generator over a Node `Readable`, producing SSE frames. Honours
 *  `text/event-stream` framing (blank line = event boundary), comments
 *  (`:...`), and multi-line `data:` fields. */
async function* parseSseStream(
  stream: NodeJS.ReadableStream,
  signal?: AbortSignal
): AsyncIterable<{ event: string; data: string }> {
  const queue: { event: string; data: string }[] = [];
  let resolveNext: (() => void) | null = null;
  let ended = false;
  let buffer = "";
  let currentEvent = "message";
  let currentData: string[] = [];

  const wake = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      buffer = buffer.slice(idx + 1);
      if (line === "") {
        if (currentData.length > 0) {
          queue.push({ event: currentEvent, data: currentData.join("\n") });
          currentEvent = "message";
          currentData = [];
          wake();
        }
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const field = line.slice(0, colon);
      let value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") currentEvent = value;
      else if (field === "data") currentData.push(value);
    }
  };

  const onEnd = () => {
    ended = true;
    if (currentData.length > 0) {
      queue.push({ event: currentEvent, data: currentData.join("\n") });
      currentData = [];
    }
    wake();
  };

  const onError = () => {
    ended = true;
    wake();
  };

  stream.on("data", onData as never);
  stream.on("end", onEnd as never);
  stream.on("error", onError as never);
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        ended = true;
        wake();
      },
      { once: true }
    );
  }

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((r) => (resolveNext = r));
    }
  } finally {
    stream.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport (MCP 2025-03-26)
// ---------------------------------------------------------------------------

/**
 * Streamable HTTP transport: one endpoint, POST-per-message. Responses may
 * be `application/json` (single envelope) or `text/event-stream` (a short
 * SSE stream whose frames carry the response and any server-initiated
 * messages). Session state rides the `mcp-session-id` header: the server
 * assigns it on `initialize`, we echo it on every later request, and we
 * DELETE it on `stop()`. Notifications receive `202 Accepted` with an empty
 * body.
 */
export class McpHttpClient extends BaseJsonRpcClient {
  private sessionId: string | null = null;
  private stopped = false;
  private readonly baseUrl: URL;
  private readonly headers: Record<string, string>;
  private readonly oauth: OAuthTransportHelper | null;

  constructor(
    public readonly serverName: string,
    private readonly config: McpHttpServerConfig,
    ctx?: McpTransportContext,
  ) {
    super();
    if (!config.url) throw new Error(`MCP HTTP server ${serverName}: url is required`);
    this.baseUrl = new URL(config.url);
    this.headers = { ...(config.headers ?? {}) };
    // OAuth is enabled if the host provided an openAuthUrl hook.
    this.oauth =
      ctx && ctx.openAuthUrl
        ? new OAuthTransportHelper(
            serverName,
            ctx.cwd,
            {
              oauthClientId: (config as McpServerConfig).oauthClientId,
              oauthClientSecret: (config as McpServerConfig).oauthClientSecret,
              oauthScopes: (config as McpServerConfig).oauthScopes,
            },
            ctx.openAuthUrl,
          )
        : null;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error(`MCP ${this.serverName} already stopped`);
    await this.handshakeAndDiscover();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.failAllPending(new Error(`MCP ${this.serverName} stopped`));
    if (this.sessionId) {
      // Best-effort session termination.
      await this.rawRequest("DELETE").catch(() => undefined);
      this.sessionId = null;
    }
  }

  protected sendFrame(msg: JsonRpcRequest): void {
    if (this.stopped) throw new Error(`MCP ${this.serverName} is stopped`);
    this.postJson(msg).catch((err) => {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async rawRequest(method: "DELETE"): Promise<void> {
    const isHttps = this.baseUrl.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const headers = await this.outboundHeaders();
    await new Promise<void>((resolve, reject) => {
      const req = reqFn(
        {
          method,
          hostname: this.baseUrl.hostname,
          port: this.baseUrl.port || (isHttps ? 443 : 80),
          path: this.baseUrl.pathname + this.baseUrl.search,
          headers,
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  private async outboundHeaders(): Promise<Record<string, string>> {
    const out: Record<string, string> = {
      "MCP-Protocol-Version": "2025-03-26",
      ...this.headers,
    };
    if (this.sessionId) out["mcp-session-id"] = this.sessionId;
    if (this.oauth) {
      await this.oauth.attachAuth(out);
    }
    return out;
  }

  private postJson(msg: JsonRpcRequest): Promise<void> {
    const isNotification = msg.method.startsWith("notifications/");
    const body = JSON.stringify(msg);
    return (async () => {
      // First attempt (with a cached token, if any).
      const res = await this.doPost(msg, body, isNotification);
      if (res === null) return; // notification sent
      // 401 → OAuth flow + one retry.
      if (res.status === 401 && this.oauth) {
        const newToken = await this.oauth.handle401(res);
        if (newToken) {
          const retry = await this.doPost(msg, body, isNotification);
          if (retry === null) return;
          // If the retry also fails, fall through to the normal error path
          // using the retry's response.
          void retry;
        }
      }
      // The response was already dispatched to onMessage inside doPost on
      // success; on failure the pending entry was rejected there. Nothing
      // more to do here.
    })().catch((err) => {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Perform a single POST. Returns the raw response on HTTP-level failure
   *  (>=400), or null for notifications / successful dispatch (the response
   *  body has already been fed to onMessage in the success case). */
  private async doPost(
    msg: JsonRpcRequest,
    body: string,
    isNotification: boolean,
  ): Promise<RawHttpResponse | null> {
    const headers = await this.outboundHeaders();
    const isHttps = this.baseUrl.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const res: RawHttpResponse = await new Promise((resolve, reject) => {
      const req = reqFn(
        {
          method: "POST",
          hostname: this.baseUrl.hostname,
          port: this.baseUrl.port || (isHttps ? 443 : 80),
          path: this.baseUrl.pathname + this.baseUrl.search,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "Content-Length": Buffer.byteLength(body),
            ...headers,
          },
        },
        (r) => {
          const sid = r.headers["mcp-session-id"];
          if (typeof sid === "string" && sid) this.sessionId = sid;
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => {
            resolve({
              status: r.statusCode ?? 0,
              headers: r.headers as Record<string, string | string[] | undefined>,
              body: Buffer.concat(chunks).toString("utf-8"),
            });
          });
          r.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    // Session id assignment/rotation (already done above; kept for clarity).
    const contentType = String(res.headers["content-type"] ?? "");
    const text = res.body;
    if (res.status >= 400) {
      // Surface 401 to the caller (OAuth retry path); reject other errors.
      if (res.status === 401 && this.oauth) {
        return res;
      }
      const p = this.pending.get(msg.id);
      const err = new Error(
        `MCP ${this.serverName} HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
      if (p) {
        this.pending.delete(msg.id);
        p.reject(err);
      }
      return res;
    }
    if (isNotification || res.status === 202) {
      return null;
    }
    if (contentType.includes("text/event-stream")) {
      for (const frame of parseSseResponse(text)) this.onMessage(frame);
    } else if (text.trim()) {
      try {
        this.onMessage(JSON.parse(text) as JsonRpcResponse);
      } catch {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.reject(new Error(`MCP ${this.serverName}: non-JSON response`));
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Context passed to every transport, used for OAuth on remote servers. */
export interface McpTransportContext {
  /** The working directory, for token persistence. */
  cwd: string;
  /** Host hook to open the OAuth authorization URL. If null, OAuth is
   *  disabled and remote servers requiring auth surface 401s as errors. */
  openAuthUrl: ((server: string, url: string) => void | Promise<void>) | null;
}

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

/**
 * Manager owning one client per configured MCP server. Each transport is
 * implemented by its own class; both implement the `McpClient` interface.
 *
 * The manager is **fail-soft**: a single misconfigured server does not stop
 * the others from starting, and the session remains usable. Per-server
 * errors are collected and exposed via `startErrors()` and the `onError`
 * listener. Callers that want to surface the failures (e.g. the session
 * layer printing a warning) can iterate over the result.
 */
export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly startErrs: McpStartError[] = [];
  private readonly errorListeners = new Set<(e: McpStartError) => void>();

  /**
   * @param configs  Either the legacy `Record<string, McpServerConfig>` map
   *                 (all entries treated as stdio) or the richer
   *                 `Record<string, McpServerConfigEntry>` map. Existing
   *                 session.ts call sites keep working.
   * @param ctx      Transport context (cwd + OAuth host hook). Optional; when
   *                 omitted, remote servers requiring OAuth will fail with a
   *                 401 instead of launching a browser flow.
   */
  constructor(
    private readonly configs: Record<
      string,
      McpServerConfig | McpServerConfigEntry
    > = {},
    private readonly ctx?: McpTransportContext,
  ) {}

  /** Start every configured server concurrently. Failures are collected,
   *  not thrown. Resolves once every server has either started or failed. */
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

  /** Per-server errors from `startAll()`. */
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

  /** Install a reverse-request handler on every currently-running client.
   *  Clients started later (via `startAll`) will also be wired up at start
   *  time. Pass `null` to disable. */
  setServerRequestHandler(h: McpServerRequestHandler | null): void {
    this._serverRequestHandler = h;
    for (const c of this.clients.values()) {
      try {
        c.setServerRequestHandler(h);
      } catch {
        /* ignore */
      }
    }
  }
  private _serverRequestHandler: McpServerRequestHandler | null = null;

  /** Internal: ensure newly-built clients inherit the manager-level handler. */
  private wireHandler(c: McpClient): void {
    if (this._serverRequestHandler) {
      try {
        c.setServerRequestHandler(this._serverRequestHandler);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Naming helpers (kept for back-compat with existing session wiring)
// ---------------------------------------------------------------------------

/** Build the canonical `mcp__<server>__<tool>` name. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Build the canonical `mcp__<server>__resource__<name>` name. */
export function mcpResourceToolName(server: string, resource: string): string {
  return `mcp__${server}__resource__${resource}`;
}

/** Parse an `mcp__<server>__<tool>` or `mcp__<server>__resource__<name>`
 *  name back into its parts. Returns `null` for anything that does not look
 *  like a tool name we generate. */
export function parseMcpToolName(
  name: string
): { server: string; tool: string; kind: "tool" | "resource" } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const parts = rest.split("__");
  if (parts.length < 2) return null;
  if (parts.length >= 3 && parts[1] === "resource") {
    return {
      server: parts[0]!,
      tool: parts.slice(2).join("__"),
      kind: "resource",
    };
  }
  return { server: parts[0]!, tool: parts.slice(1).join("__"), kind: "tool" };
}

// ---------------------------------------------------------------------------
// `@mcp:` reference resolution
// ---------------------------------------------------------------------------

/** Regex matching `@mcp:<server>/<uri>` tokens in user prompts. The server
 *  name is `[A-Za-z0-9_-]+`; the URI is everything up to the next whitespace
 *  or end of string. Example: `@mcp:github/repos/foo/bar` →
 *  `{ server: "github", uri: "repos/foo/bar" }`. */
export const MCP_REF_REGEX = /@mcp:([A-Za-z0-9_.-]+)\/(\S+)/g;

/** Parse an `@mcp:<server>/<uri>` token. Returns null if the string does not
 *  look like an MCP resource reference. */
export function parseMcpReference(
  token: string
): { server: string; uri: string } | null {
  const m = /^@mcp:([A-Za-z0-9_.-]+)\/(\S+)$/.exec(token);
  if (!m) return null;
  return { server: m[1]!, uri: m[2]! };
}

/** Scan a text for `@mcp:<server>/<uri>` references and resolve each via the
 *  manager, returning a concatenation of their textual contents suitable for
 *  injection as user context. Unknown servers or failed reads are skipped
 *  with an inline note. The `uris` are unquoted (the `@mcp:` prefix is
 *  stripped before lookup). */
export async function resolveMcpReferences(
  text: string,
  manager: McpManager
): Promise<{ text: string; resolved: number }> {
  const refs: { server: string; uri: string; raw: string }[] = [];
  for (const m of text.matchAll(MCP_REF_REGEX)) {
    refs.push({ server: m[1]!, uri: m[2]!, raw: m[0] });
  }
  if (refs.length === 0) return { text, resolved: 0 };
  let resolved = 0;
  const blocks: string[] = [];
  for (const r of refs) {
    const client = manager.getClient(r.server);
    if (!client) {
      blocks.push(`[mcp:${r.server}] (unknown server) ${r.uri}`);
      continue;
    }
    try {
      const res = await client.readResource(r.uri);
      const body = (res.contents ?? [])
        .map((c) => c.text ?? (c.blob ? `(base64 blob, ${c.blob.length} chars)` : "(empty)"))
        .join("\n");
      blocks.push(`[mcp:${r.server} ${r.uri}]\n${body}`);
      resolved++;
    } catch (e) {
      blocks.push(`[mcp:${r.server} ${r.uri}] (error: ${(e as Error).message})`);
    }
  }
  return { text: blocks.join("\n\n"), resolved };
}
