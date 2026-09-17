// Streamable HTTP transport (MCP 2025-03-26).
//
// One endpoint, POST-per-message. Responses may be `application/json`
// (single envelope) or `text/event-stream` (a short SSE stream whose frames
// carry the response and any server-initiated messages). Session state rides
// the `mcp-session-id` header: the server assigns it on `initialize`, we
// echo it on every later request, and we DELETE it on `stop()`. Notifications
// receive `202 Accepted` with an empty body.

import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { URL } from "node:url";
import { BaseJsonRpcClient } from "./mcp-jsonrpc.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp-jsonrpc.js";
import { parseSseResponse } from "./mcp-sse.js";
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpTransportContext,
} from "./mcp-types.js";
import {
  OAuthTransportHelper,
  type RawHttpResponse,
} from "./mcpOAuthTransport.js";

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
