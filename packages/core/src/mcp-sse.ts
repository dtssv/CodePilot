// MCP SSE transport (HTTP + server-sent events, MCP 2024-11-05).
//
// The server's URL is treated as the *control plane*:
//
//  1. POST `{jsonrpc,method,params,id}` to it as `Content-Type: application/json`
//     and `Accept: application/json, text/event-stream`. The response is either
//     a JSON body (for short, non-streaming replies) or an SSE stream that
//     carries one or more events, the last of which carries the JSON-RPC
//     response. The spec lets the server decide per request; we accept both.
//  2. When the server's `initialize` response carries an `endpoint` field in
//     the `_meta` map (or in a `session`/`endpoint` header), subsequent calls
//     can be POSTed to that per-session URL instead of the control URL. We
//     honour both shapes and fall back to the control URL when no per-session
//     endpoint is advertised.
//  3. If the server returns a long-lived event stream after `initialize`
//     (carrying `endpoint` and/or `session` events), we keep it open in the
//     background and dispatch any server-pushed JSON-RPC envelopes through
//     the same `onMessage` path.

import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { URL } from "node:url";
import { BaseJsonRpcClient } from "./mcp-jsonrpc.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp-jsonrpc.js";
import type {
  McpServerConfig,
  McpSseServerConfig,
  McpTransportContext,
} from "./mcp-types.js";
import {
  OAuthTransportHelper,
  type RawHttpResponse,
} from "./mcpOAuthTransport.js";

// ---------------------------------------------------------------------------
// SSE parsing helpers
// ---------------------------------------------------------------------------

/** Tiny SSE parser used by the POST-response path. Parses a complete SSE
 *  blob (the body of a POST response) into JSON-RPC envelopes. */
export function parseSseResponse(body: string): JsonRpcResponse[] {
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
export async function* parseSseStream(
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
// McpSseClient
// ---------------------------------------------------------------------------

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
