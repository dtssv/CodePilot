// MCP OAuth 2.1 client (Authorization Code + PKCE).
//
// This module implements the OAuth flow the MCP spec (2025-03-26) requires
// for remote (HTTP / SSE) servers. Per the spec, a server that needs auth
// responds to the first request with HTTP 401 and a
// `WWW-Authenticate: Bearer resource_metadata="<url>"` header. The URL
// points at a Protected Resource Metadata document (RFC 9728), which lists
// `authorization_servers`. Each authorization server in turn publishes an
// Authorization Server Metadata document (RFC 8414) with the endpoints we
// need: `authorization_endpoint`, `token_endpoint`, and optionally
// `registration_endpoint` (for Dynamic Client Registration) and
// `revocation_endpoint`.
//
// The flow we run is the Authorization Code grant with PKCE (S256), as
// mandated by OAuth 2.1:
//
//   1. On 401, fetch the resource metadata → pick the first authorization
//      server → fetch its metadata.
//   2. (Optional) Register a client dynamically if no client_id is
//      configured, so we get a `client_id` (and `client_secret` for
//      confidential clients). We are a public client (no secret on disk by
//      default), so DCR returns just a `client_id`.
//   3. Generate a PKCE `code_verifier` (43-128 random url-safe chars) and
//      `code_challenge = BASE64URL(SHA256(verifier))`.
//   4. Build the authorization URL:
//        <authorization_endpoint>
//          ?response_type=code
//          &client_id=...
//          &redirect_uri=http://127.0.0.1:<port>/callback
//          &code_challenge=...
//          &code_challenge_method=S256
//          &state=<random>
//          &scope=<server-advertised or "openid profile">
//   5. The host (TUI) opens this URL in a browser and spins up a tiny local
//      HTTP server to receive the redirect. The browser redirects to
//      http://127.0.0.1:<port>/callback?code=...&state=...
//      We verify `state` matches, then exchange the code at the
//      `token_endpoint`:
//        grant_type=authorization_code
//        code=...
//        redirect_uri=...           (must match)
//        client_id=...
//        code_verifier=...          (the original verifier)
//      and receive `{ access_token, token_type, expires_in, refresh_token? }`.
//   6. Persist the token bundle to disk so subsequent sessions reuse it
//      until it expires (and refresh via `refresh_token` if present).
//   7. Attach `Authorization: Bearer <access_token>` to every outbound
//      request for that server.
//
// Security notes:
//   - `state` is a random 16-byte hex string, checked on callback to
//     prevent CSRF.
//   - The local callback server binds to 127.0.0.1 only and shuts down
//     immediately after the first request (or a 5-minute timeout).
//   - Tokens are stored in `<cwd>/.codepilot/mcp-tokens/<server>.json` with
//     0600 permissions.
//   - We never log `access_token` / `refresh_token` values.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { createServer, type Server } from "node:http";
import { URL } from "node:url";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Tokens persisted for a server. Mirrors the OAuth token response. */
export interface McpTokenBundle {
  accessToken: string;
  tokenType: string; // usually "Bearer"
  /** Unix epoch ms when the token expires. Undefined if the server didn't
   *  return `expires_in` (treat as non-expiring until a 401 says otherwise). */
  expiresAt?: number;
  refreshToken?: string;
  /** Scopes that were granted. */
  scope?: string;
}

/** A handle returned by `McpOAuthFlow.authorize` so the host can drive the
 *  browser interaction. The host should:
 *    1. `openUrl(handle.authorizationUrl)` — open in the user's browser.
 *    2. `await handle.waitForCallback()` — resolves with the tokens once
 *       the redirect arrives, or rejects on timeout / error.
 *  The flow automatically spins up a local HTTP listener to capture the
 *  redirect; the host does not need to manage it. */
export interface McpOAuthHandle {
  /** The URL the user should visit to authorize. */
  authorizationUrl: string;
  /** Resolves when the OAuth provider redirects back with a code and the
   *  token exchange completes. Rejects on timeout, state mismatch, or
   *  token-endpoint error. */
  waitForCallback(): Promise<McpTokenBundle>;
  /** Cancel the pending authorization (closes the local listener). Safe to
   *  call after `waitForCallback` has settled. */
  cancel(): void;
}

/** The host provides this callback so the flow can surface the
 *  authorization URL for the user. The host is responsible for:
 *    - opening the URL in a browser (or printing it for manual copy),
 *    - letting the user know they need to authorize,
 *    - optionally showing a "waiting…" UI.
 *  The flow handles the redirect capture and token exchange itself. */
export type McpOpenAuthUrl = (
  serverName: string,
  authorizationUrl: string,
) => void | Promise<void>;

/** Configuration for a single server's OAuth, derived from the server's
 *  metadata documents. Built internally by `authorize`. */
export interface McpOAuthServerConfig {
  /** The server's display name (config key). */
  serverName: string;
  /** Authorization endpoint URL. */
  authorizationEndpoint: string;
  /** Token endpoint URL. */
  tokenEndpoint: string;
  /** Optional registration endpoint (for DCR). */
  registrationEndpoint?: string;
  /** Optional revocation endpoint. */
  revocationEndpoint?: string;
  /** Client id. If absent and `registrationEndpoint` is set, we register. */
  clientId?: string;
  /** Client secret, if the server issued one (confidential clients). */
  clientSecret?: string;
  /** Scopes to request. Defaults to the server's advertised scopes or
   *  "openid profile". */
  scopes?: string[];
  /** The redirect URI we advertise. Must match on both legs. We always use
   *  a loopback URL. */
  redirectUri: string;
  /** The local port the redirect URI points at. */
  redirectPort: number;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/** Generate a cryptographically random PKCE code_verifier (43-128 chars,
 *  url-safe per RFC 7636 §4.1). We use 32 random bytes → base64url = 43 chars. */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** Compute the S256 code_challenge for a verifier. */
export function codeChallengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Base64url-encode a Buffer without padding. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random hex string for `state` (CSRF token). */
function randomState(): string {
  return randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

/** Where tokens live: `<cwd>/.codepilot/mcp-tokens/<server>.json`. */
function tokenFilePath(cwd: string, serverName: string): string {
  // Sanitize the server name so it can't escape the directory.
  const safe = serverName.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(cwd, ".codepilot", "mcp-tokens", `${safe}.json`);
}

/** Load a persisted token bundle. Returns null if absent or unreadable. */
export async function loadTokenBundle(
  cwd: string,
  serverName: string,
): Promise<McpTokenBundle | null> {
  const path = tokenFilePath(cwd, serverName);
  try {
    const text = await readFile(path, "utf-8");
    const parsed = JSON.parse(text) as McpTokenBundle;
    if (!parsed || typeof parsed.accessToken !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist a token bundle with 0600 permissions. Creates the directory if
 *  needed. Best-effort: failures are swallowed (we'll just re-auth on the
 *  next 401). */
export async function saveTokenBundle(
  cwd: string,
  serverName: string,
  bundle: McpTokenBundle,
): Promise<void> {
  const path = tokenFilePath(cwd, serverName);
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(bundle, null, 2), { mode: 0o600 });
    // chmod again in case the file already existed (writeFile respects the
    // existing mode for an existing file on some platforms).
    await chmod(path, 0o600);
  } catch {
    /* best-effort */
  }
}

/** Delete a persisted token bundle (e.g. on revocation or 401 with an
 *  invalid_grant error indicating the refresh token is dead). */
export async function clearTokenBundle(
  cwd: string,
  serverName: string,
): Promise<void> {
  const path = tokenFilePath(cwd, serverName);
  try {
    await writeFile(path, "");
  } catch {
    /* ignore */
  }
}

/** Is a token bundle still usable (present and not expired)?
 *  We treat tokens with no `expiresAt` as non-expiring. */
export function isTokenValid(bundle: McpTokenBundle | null): bundle is McpTokenBundle {
  if (!bundle) return false;
  if (bundle.expiresAt === undefined) return true;
  // Refresh proactively 60s before the hard expiry.
  return bundle.expiresAt > Date.now() + 60_000;
}

// ---------------------------------------------------------------------------
// Metadata fetching
// ---------------------------------------------------------------------------

/** Protected Resource Metadata (RFC 9728), the subset we use. */
interface ProtectedResourceMetadata {
  authorization_servers?: string[];
  // Other fields (resource, scopes_supported, etc.) are ignored.
}

/** Authorization Server Metadata (RFC 8414), the subset we use. */
export interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  /** MCP servers may advertise a `refresh_token` grant. */
  grant_types_supported?: string[];
}

/** Fetch JSON from a URL with a small timeout. Throws on non-2xx. */
async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const opts: RequestOptions | HttpsRequestOptions = {
    method: "GET",
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: { Accept: "application/json, application/json;charset=UTF-8", ...(headers ?? {}) },
  };
  return new Promise<T>((resolve, reject) => {
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`metadata fetch ${url} → ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text) as T);
        } catch (e) {
          reject(new Error(`metadata fetch ${url}: invalid JSON (${(e as Error).message})`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`metadata fetch ${url} timed out`));
    });
    req.end();
  });
}

/** Parse a `WWW-Authenticate: Bearer resource_metadata="..."` header value
 *  and return the resource-metadata URL, or null if absent. The header
 *  looks like:
 *    Bearer resource_metadata="https://host/.well-known/oauth-protected-resource"
 *  (per MCP 2025-03-26 / draft-ietf-oauth-resource-metadata). */
export function parseResourceMetadataHeader(
  wwwAuthenticate: string | undefined | null,
): string | null {
  if (!wwwAuthenticate) return null;
  // Case-insensitive scheme check.
  if (!/^\s*bearer\b/i.test(wwwAuthenticate)) return null;
  // Find resource_metadata="..." (the value may be quoted or unquoted).
  const m = /resource_metadata\s*=\s*"?([^"\s,]+)"?/i.exec(wwwAuthenticate);
  return m ? m[1]! : null;
}

/** Discover the OAuth endpoints for a server, given the
 *  `WWW-Authenticate: Bearer resource_metadata="..."` URL. Returns the
 *  authorization-server metadata (we pick the first authorization server
 *  listed). Throws if discovery fails. */
export async function discoverOAuthMetadata(
  resourceMetadataUrl: string,
): Promise<AuthorizationServerMetadata> {
  // 1. Fetch the protected-resource metadata.
  const rm = await fetchJson<ProtectedResourceMetadata>(resourceMetadataUrl);
  const authServers = rm.authorization_servers ?? [];
  if (authServers.length === 0) {
    // Some servers embed the endpoints directly in the resource metadata
    // (non-standard but seen in the wild). Treat the resource metadata doc
    // itself as the AS metadata if it has an authorization_endpoint.
    const asIf = rm as unknown as AuthorizationServerMetadata;
    if (asIf.authorization_endpoint && asIf.token_endpoint) return asIf;
    throw new Error(
      `resource metadata at ${resourceMetadataUrl} lists no authorization_servers and has no endpoints`,
    );
  }
  // 2. Fetch the first authorization server's metadata.
  const as = await fetchJson<AuthorizationServerMetadata>(authServers[0]!);
  if (!as.authorization_endpoint || !as.token_endpoint) {
    throw new Error(
      `authorization server ${authServers[0]} metadata is missing authorization_endpoint or token_endpoint`,
    );
  }
  return as;
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration (optional)
// ---------------------------------------------------------------------------

/** Register a public client dynamically (RFC 7591). Returns the issued
 *  `client_id`. We send the minimum metadata the spec requires. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  const body = JSON.stringify({
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none", // public client (PKCE only)
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "CodePilot",
  });
  const u = new URL(registrationEndpoint);
  const isHttps = u.protocol === "https:";
  const opts: RequestOptions | HttpsRequestOptions = {
    method: "POST",
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };
  return new Promise((resolve, reject) => {
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`DCR ${registrationEndpoint} → ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(text) as { client_id?: string; client_secret?: string };
          if (!parsed.client_id) {
            reject(new Error(`DCR response missing client_id: ${text.slice(0, 200)}`));
            return;
          }
          resolve({ clientId: parsed.client_id, clientSecret: parsed.client_secret });
        } catch (e) {
          reject(new Error(`DCR invalid JSON: ${(e as Error).message}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Local redirect listener
// ---------------------------------------------------------------------------

/** A tiny HTTP server bound to 127.0.0.1 that waits for the OAuth redirect.
 *  Resolves with the `code` and `state` from the query string, then closes.
 *  Rejects on timeout. We render a minimal HTML page so the user sees
 *  something meaningful in their browser after authorizing. */
export function startRedirectListener(
  port: number,
  expectedState: string,
  timeoutMs = 5 * 60_000,
): { server: Server; waitForCode: Promise<{ code: string; state: string }> } {
  let resolveFn: ((v: { code: string; state: string }) => void) | null = null;
  let rejectFn: ((e: Error) => void) | null = null;
  const waitForCode = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    const err = u.searchParams.get("error");

    if (err) {
      const desc = u.searchParams.get("error_description") ?? "";
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<h1>Authorization failed</h1><p>${escapeHtml(err)}${
          desc ? `: ${escapeHtml(desc)}` : ""
        }</p><p>You can close this tab.</p>`,
      );
      rejectFn?.(new Error(`OAuth provider returned error: ${err} ${desc}`));
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Missing code</h1><p>No authorization code in the callback.</p>");
      return;
    }

    if (state !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>State mismatch</h1><p>Possible CSRF attack — refusing.</p>");
      rejectFn?.(new Error("OAuth state mismatch (CSRF?)"));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<h1>Authorized</h1><p>You can close this tab and return to CodePilot.</p>",
    );
    resolveFn?.({ code, state: state ?? "" });
  });

  server.listen(port, "127.0.0.1");

  const timeout = setTimeout(() => {
    rejectFn?.(new Error(`OAuth redirect timed out after ${timeoutMs}ms`));
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  // Clean up the timeout once the promise settles.
  void waitForCode.finally(() => clearTimeout(timeout));

  return { server, waitForCode };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Token exchange + refresh
// ---------------------------------------------------------------------------

/** Exchange an authorization code for tokens. */
export async function exchangeCodeForToken(
  tokenEndpoint: string,
  params: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    codeVerifier: string;
  },
): Promise<McpTokenBundle> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
  if (params.clientSecret) body.set("client_secret", params.clientSecret);

  return tokenRequest(tokenEndpoint, body);
}

/** Refresh an access token using a refresh token. */
export async function refreshAccessToken(
  tokenEndpoint: string,
  params: {
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
  },
): Promise<McpTokenBundle> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });
  if (params.clientSecret) body.set("client_secret", params.clientSecret);

  return tokenRequest(tokenEndpoint, body);
}

/** Revoke a token (best-effort). */
export async function revokeToken(
  revocationEndpoint: string,
  token: string,
  clientId: string,
): Promise<void> {
  const body = new URLSearchParams({ token, client_id: clientId });
  const u = new URL(revocationEndpoint);
  const isHttps = u.protocol === "https:";
  const opts: RequestOptions | HttpsRequestOptions = {
    method: "POST",
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body.toString()),
    },
  };
  await new Promise<void>((resolve) => {
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(opts, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", () => resolve());
    req.write(body.toString());
    req.end();
  });
}

/** POST to a token endpoint with form-encoded body and parse the response. */
async function tokenRequest(
  tokenEndpoint: string,
  body: URLSearchParams,
): Promise<McpTokenBundle> {
  const u = new URL(tokenEndpoint);
  const isHttps = u.protocol === "https:";
  const opts: RequestOptions | HttpsRequestOptions = {
    method: "POST",
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "Content-Length": Buffer.byteLength(body.toString()),
    },
  };
  return new Promise((resolve, reject) => {
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`token endpoint ${res.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        try {
          const parsed = JSON.parse(text) as {
            access_token?: string;
            token_type?: string;
            expires_in?: number;
            refresh_token?: string;
            scope?: string;
            error?: string;
            error_description?: string;
          };
          if (parsed.error) {
            reject(new Error(`token error: ${parsed.error} ${parsed.error_description ?? ""}`));
            return;
          }
          if (!parsed.access_token) {
            reject(new Error(`token response missing access_token: ${text.slice(0, 200)}`));
            return;
          }
          const bundle: McpTokenBundle = {
            accessToken: parsed.access_token,
            tokenType: parsed.token_type ?? "Bearer",
            expiresAt:
              typeof parsed.expires_in === "number"
                ? Date.now() + parsed.expires_in * 1000
                : undefined,
            refreshToken: parsed.refresh_token,
            scope: parsed.scope,
          };
          resolve(bundle);
        } catch (e) {
          reject(new Error(`token response invalid JSON: ${(e as Error).message}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body.toString());
    req.end();
  });
}

// ---------------------------------------------------------------------------
// High-level orchestration
// ---------------------------------------------------------------------------

/** Pick a free loopback TCP port for the redirect listener. We bind to port
 *  0 and immediately close; there's an inherent race but it's acceptable for
 *  a local dev tool. */
export async function pickRedirectPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1");
    srv.on("listening", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not pick a redirect port"));
      }
    });
    srv.on("error", reject);
  });
}

/** Build the full authorization URL for a PKCE flow. Exported so it can be
 *  unit-tested without spinning up listeners. */
export function buildAuthorizationUrl(cfg: McpOAuthServerConfig, opts: {
  codeVerifier: string;
  state: string;
}): string {
  const challenge = codeChallengeS256(opts.codeVerifier);
  const scope = (cfg.scopes && cfg.scopes.length > 0 ? cfg.scopes.join(" ") : "openid profile");
  const u = new URL(cfg.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId ?? "");
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("scope", scope);
  return u.toString();
}

/** Options for `McpOAuthFlow.authorize`. */
export interface AuthorizeOptions {
  /** The server's display name (for logging / persistence). */
  serverName: string;
  /** Authorization-server metadata (from `discoverOAuthMetadata`). */
  metadata: AuthorizationServerMetadata;
  /** Pre-configured client id, if the user supplied one in config. */
  clientId?: string;
  /** Pre-configured client secret, if any. */
  clientSecret?: string;
  /** The host callback that opens / displays the authorization URL. */
  openAuthUrl: McpOpenAuthUrl;
  /** Scopes to request; defaults to metadata.scopes_supported or
   *  "openid profile". */
  scopes?: string[];
  /** Override the redirect port (for tests). */
  redirectPort?: number;
  /** Override the redirect-listener timeout (for tests). */
  timeoutMs?: number;
}

/** Run a full Authorization Code + PKCE flow. Resolves with the token
 *  bundle once the user authorizes and the token exchange completes.
 *
 *  This is the entry point the transport layer calls when it gets a 401. */
export async function authorize(opts: AuthorizeOptions): Promise<McpTokenBundle> {
  if (!opts.metadata.authorization_endpoint || !opts.metadata.token_endpoint) {
    throw new Error("authorization server metadata is missing endpoints");
  }
  const port = opts.redirectPort ?? (await pickRedirectPort());
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Resolve a client_id: use the configured one, or register dynamically.
  let clientId = opts.clientId;
  let clientSecret = opts.clientSecret;
  if (!clientId && opts.metadata.registration_endpoint) {
    const reg = await registerClient(opts.metadata.registration_endpoint, redirectUri);
    clientId = reg.clientId;
    clientSecret = reg.clientSecret ?? clientSecret;
  }
  if (!clientId) {
    throw new Error(
      `no client_id for ${opts.serverName}: configure one or enable dynamic registration`,
    );
  }

  const codeVerifier = generateCodeVerifier();
  const state = randomState();
  const cfg: McpOAuthServerConfig = {
    serverName: opts.serverName,
    authorizationEndpoint: opts.metadata.authorization_endpoint,
    tokenEndpoint: opts.metadata.token_endpoint,
    registrationEndpoint: opts.metadata.registration_endpoint,
    revocationEndpoint: opts.metadata.revocation_endpoint,
    clientId,
    clientSecret,
    scopes: opts.scopes ?? opts.metadata.scopes_supported,
    redirectUri,
    redirectPort: port,
  };
  const authorizationUrl = buildAuthorizationUrl(cfg, { codeVerifier, state });

  const { server, waitForCode } = startRedirectListener(
    port,
    state,
    opts.timeoutMs ?? 5 * 60_000,
  );

  // Tell the host to open the URL. We do this *after* the listener is up so
  // the redirect can't arrive before we're ready.
  try {
    await opts.openAuthUrl(opts.serverName, authorizationUrl);
  } catch {
    // The host callback failing isn't fatal; the user can still paste the
    // URL manually. We continue to wait for the redirect.
  }

  try {
    const { code } = await waitForCode;
    const bundle = await exchangeCodeForToken(cfg.tokenEndpoint, {
      code,
      redirectUri: cfg.redirectUri,
      clientId: cfg.clientId!,
      clientSecret: cfg.clientSecret,
      codeVerifier,
    });
    return bundle;
  } finally {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }
}

/** Convenience: refresh if we have a refresh token and the access token is
 *  expired (or about to expire). Returns the (possibly new) bundle, or the
 *  original if no refresh was needed/possible. Never throws — on failure
 *  returns the original bundle so the caller can let the 401 path run. */
export async function maybeRefresh(
  bundle: McpTokenBundle,
  metadata: AuthorizationServerMetadata,
  clientId?: string,
  clientSecret?: string,
): Promise<McpTokenBundle> {
  // Refresh only if the access token is expired (or about to expire).
  const stillValid =
    bundle.expiresAt === undefined
      ? true
      : bundle.expiresAt > Date.now() + 60_000;
  if (stillValid) return bundle;
  if (!bundle.refreshToken) return bundle;
  if (!metadata.token_endpoint || !clientId) return bundle;
  try {
    return await refreshAccessToken(metadata.token_endpoint, {
      refreshToken: bundle.refreshToken,
      clientId,
      clientSecret,
    });
  } catch {
    return bundle;
  }
}

/** A no-op `openAuthUrl` for headless/test environments: just prints the URL
 *  to stderr so the user can copy-paste it. */
export const printAuthUrl: McpOpenAuthUrl = (_server, url) => {
  process.stderr.write(`\n[mcp oauth] Open this URL to authorize:\n${url}\n\n`);
};
