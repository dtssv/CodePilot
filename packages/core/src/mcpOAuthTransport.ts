// OAuth-aware request helper shared by the MCP HTTP and SSE transports.
//
// Both remote transports need the same behavior on a 401:
//   1. Load a persisted token for the server (if any) and attach it as
//      `Authorization: Bearer <token>` to outbound requests.
//   2. When a request comes back 401 with
//      `WWW-Authenticate: Bearer resource_metadata="<url>"`, run the OAuth
//      Authorization Code + PKCE flow (via the host's `openAuthUrl` hook),
//      persist the new token, and retry the original request once.
//   3. If a token is expired and we have a refresh token, refresh it before
//      retrying.
//
// This module factors that into a reusable helper so neither transport has
// to duplicate the logic. The transport provides two primitives:
//   - `doRequest(opts, body)`: perform a single HTTP round-trip and return
//     `{ status, headers, body }`.
//   - `serverName`, `cwd`, `oauthCfg`: identity + config.
// and the helper handles everything else.

import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { URL } from "node:url";
import type { McpServerConfig } from "./types.js";
import {
  authorize,
  discoverOAuthMetadata,
  loadTokenBundle,
  maybeRefresh,
  parseResourceMetadataHeader,
  saveTokenBundle,
  type AuthorizationServerMetadata,
  type McpOAuthServerConfig,
  type McpOpenAuthUrl,
  type McpTokenBundle,
} from "./mcpOAuth.js";

export interface OAuthClientConfig {
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthScopes?: string[];
}

export interface RawHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface DoRequestFn {
  (
    method: string,
    target: URL,
    headers: Record<string, string>,
    body: Buffer | string | null,
  ): Promise<RawHttpResponse>;
}

/** The cached AS metadata for a server, so we don't re-discover on every
 *  401. Keyed by resource-metadata URL. */
interface CachedMetadata {
  resourceUrl: string;
  metadata: AuthorizationServerMetadata;
}

/** A single-flight guard so concurrent 401s on the same server don't kick
 *  off multiple browser flows. */
interface InFlightAuth {
  promise: Promise<McpTokenBundle | null>;
}

export class OAuthTransportHelper {
  private token: McpTokenBundle | null = null;
  private tokenLoaded = false;
  private cachedMeta: CachedMetadata | null = null;
  private inflight: InFlightAuth | null = null;

  constructor(
    private readonly serverName: string,
    private readonly cwd: string,
    private readonly oauthCfg: OAuthClientConfig,
    /** Host hook to open the authorization URL. If null, OAuth is disabled
     *  and 401s surface as errors. */
    private readonly openAuthUrl: McpOpenAuthUrl | null,
  ) {}

  /** Whether OAuth is potentially enabled (a client id or DCR is available).
   *  We can't know about DCR until we fetch metadata, so this is a
   *  conservative "maybe". */
  get oauthEnabled(): boolean {
    return this.openAuthUrl !== null;
  }

  /** Lazily load the persisted token. */
  async ensureTokenLoaded(): Promise<void> {
    if (this.tokenLoaded) return;
    this.tokenLoaded = true;
    this.token = await loadTokenBundle(this.cwd, this.serverName);
  }

  /** The current token (or null). Forces a load on first access. */
  async currentToken(): Promise<McpTokenBundle | null> {
    await this.ensureTokenLoaded();
    return this.token;
  }

  /** Attach an Authorization header if we have a valid token. Mutates the
   *  headers object in place. */
  async attachAuth(headers: Record<string, string>): Promise<Record<string, string>> {
    await this.ensureTokenLoaded();
    const tok = this.token;
    if (tok) {
      const valid =
        tok.expiresAt === undefined ? true : tok.expiresAt > Date.now() + 60_000;
      if (valid) {
        headers["Authorization"] = `${tok.tokenType ?? "Bearer"} ${tok.accessToken}`;
      } else if (tok.refreshToken && this.cachedMeta?.metadata) {
        // Try a refresh before giving up.
        const refreshed = await maybeRefresh(
          tok,
          this.cachedMeta.metadata,
          this.oauthCfg.oauthClientId,
          this.oauthCfg.oauthClientSecret,
        );
        if (refreshed !== tok) {
          this.token = refreshed;
          await saveTokenBundle(this.cwd, this.serverName, refreshed);
          headers["Authorization"] = `${refreshed.tokenType ?? "Bearer"} ${refreshed.accessToken}`;
        }
      }
    }
    return headers;
  }

  /** Handle a 401 response: discover metadata, run the OAuth flow (if a
   *  host hook is installed), persist the token, and return the new bundle.
   *  Returns null if OAuth is disabled or the server didn't send a
   *  resource_metadata header. Single-flighted: concurrent callers share one
   *  flow. */
  async handle401(res: RawHttpResponse): Promise<McpTokenBundle | null> {
    if (!this.openAuthUrl) return null;
    const wwwAuth = headerString(res.headers, "www-authenticate");
    const resourceUrl = parseResourceMetadataHeader(wwwAuth);
    if (!resourceUrl) return null;

    // Single-flight: if a flow is already running, await it.
    if (this.inflight) {
      return this.inflight.promise;
    }
    const promise = this.runOAuthFlow(resourceUrl);
    this.inflight = { promise };
    try {
      return await promise;
    } finally {
      this.inflight = null;
    }
  }

  private async runOAuthFlow(resourceUrl: string): Promise<McpTokenBundle | null> {
    try {
      // Reuse cached metadata if the resource URL matches.
      let meta = this.cachedMeta?.resourceUrl === resourceUrl ? this.cachedMeta.metadata : null;
      if (!meta) {
        meta = await discoverOAuthMetadata(resourceUrl);
        this.cachedMeta = { resourceUrl, metadata: meta };
      }
      const bundle = await authorize({
        serverName: this.serverName,
        metadata: meta,
        clientId: this.oauthCfg.oauthClientId,
        clientSecret: this.oauthCfg.oauthClientSecret,
        scopes: this.oauthCfg.oauthScopes,
        openAuthUrl: this.openAuthUrl!,
      });
      this.token = bundle;
      this.tokenLoaded = true;
      await saveTokenBundle(this.cwd, this.serverName, bundle);
      return bundle;
    } catch (e) {
      process.stderr.write(
        `[mcp:${this.serverName}] OAuth failed: ${(e as Error).message}\n`,
      );
      return null;
    }
  }
}

/** Extract a single header value (last if repeated), case-insensitive. */
export function headerString(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v[v.length - 1] ?? null;
      return v ?? null;
    }
  }
  return null;
}

/** Perform a raw HTTP request. Exported so transports can share the
 *  implementation. */
export function rawRequest(
  method: string,
  target: URL,
  headers: Record<string, string>,
  body: Buffer | string | null,
): Promise<RawHttpResponse> {
  const isHttps = target.protocol === "https:";
  const opts: RequestOptions | HttpsRequestOptions = {
    method,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: target.pathname + target.search,
    headers,
  };
  return new Promise((resolve, reject) => {
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
