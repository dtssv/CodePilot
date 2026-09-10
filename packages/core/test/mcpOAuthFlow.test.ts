import { describe, expect, it, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { authorize, type AuthorizationServerMetadata } from "../src/mcpOAuth.js";

/** Spin up a tiny HTTP server that plays all OAuth roles for one flow:
 *  - GET /.well-known/oauth-protected-resource → resource metadata JSON
 *  - GET /.well-known/oauth-authorization-server → AS metadata JSON
 *  - GET /authorize → 302 redirect to the redirect_uri with code+state
 *  - POST /token → token JSON
 *  The server records what it saw so the test can assert on it. */
interface MockOAuthServer {
  server: Server;
  port: number;
  baseUrl: string;
  /** The code the mock hands out (fixed for testability). */
  code: string;
  /** Captured token request body (form-encoded). */
  lastTokenBody: string | null;
  close(): Promise<void>;
}

async function startMockOAuthServer(): Promise<MockOAuthServer> {
  const code = "test-auth-code-12345";
  let lastTokenBody: string | null = null;

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    // Collect the body for POST.
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");

      if (req.method === "GET" && u.pathname === "/.well-known/oauth-protected-resource") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            resource: "http://127.0.0.1/api",
            authorization_servers: ["http://127.0.0.1/.well-known/oauth-authorization-server"],
          }),
        );
        return;
      }

      if (req.method === "GET" && u.pathname === "/.well-known/oauth-authorization-server") {
        const meta: AuthorizationServerMetadata = {
          issuer: "http://127.0.0.1",
          authorization_endpoint: "http://127.0.0.1/authorize",
          token_endpoint: "http://127.0.0.1/token",
          registration_endpoint: "http://127.0.0.1/register",
          scopes_supported: ["test-scope"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(meta));
        return;
      }

      if (req.method === "GET" && u.pathname === "/authorize") {
        // Echo back the state and redirect with our fixed code.
        const state = u.searchParams.get("state") ?? "";
        const redirectUri = u.searchParams.get("redirect_uri") ?? "";
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", state);
        res.writeHead(302, { Location: redirect.toString() });
        res.end();
        return;
      }

      if (req.method === "POST" && u.pathname === "/register") {
        // DCR: return a client_id.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ client_id: "dcr-client-id-999" }));
        return;
      }

      if (req.method === "POST" && u.pathname === "/token") {
        lastTokenBody = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "access-token-from-mock",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-token-from-mock",
            scope: "test-scope",
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "object" === false) throw new Error("bad addr");
  const port = (addr as { port: number }).port;

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    code,
    get lastTokenBody() {
      return lastTokenBody;
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("MCP OAuth end-to-end flow", () => {
  let mock: MockOAuthServer | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  it("discovers metadata, opens the auth URL, captures the redirect, and exchanges the code", async () => {
    mock = await startMockOAuthServer();

    // We act as the "browser": when openAuthUrl is called, we immediately
    // fetch the authorization URL ourselves (which the mock will 302 to the
    // redirect listener the core spun up). This simulates the user
    // authorizing instantly.
    const capturedUrls: string[] = [];
    const bundle = await authorize({
      serverName: "mock-server",
      metadata: {
        authorization_endpoint: `${mock.baseUrl}/authorize`,
        token_endpoint: `${mock.baseUrl}/token`,
        registration_endpoint: `${mock.baseUrl}/register`,
        scopes_supported: ["test-scope"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      },
      clientId: undefined, // force DCR
      openAuthUrl: async (_server, url) => {
        capturedUrls.push(url);
        // Simulate the browser visiting the authorization URL, which the
        // mock redirects to the loopback callback. We follow the redirect
        // with a plain fetch.
        const res = await fetch(url, { redirect: "manual" });
        const location = res.headers.get("location");
        if (location) {
          await fetch(location);
        }
      },
      timeoutMs: 10_000,
    });

    expect(bundle.accessToken).toBe("access-token-from-mock");
    expect(bundle.tokenType).toBe("Bearer");
    expect(bundle.refreshToken).toBe("refresh-token-from-mock");
    expect(bundle.scope).toBe("test-scope");
    expect(bundle.expiresAt).toBeGreaterThan(Date.now());

    // The auth URL was surfaced to the host.
    expect(capturedUrls).toHaveLength(1);
    const authUrl = new URL(capturedUrls[0]!);
    expect(authUrl.pathname).toBe("/authorize");
    expect(authUrl.searchParams.get("client_id")).toBe("dcr-client-id-999");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("response_type")).toBe("code");

    // The token endpoint received the code + the PKCE verifier.
    expect(mock.lastTokenBody).toBeTruthy();
    const tokenParams = new URLSearchParams(mock.lastTokenBody!);
    expect(tokenParams.get("grant_type")).toBe("authorization_code");
    expect(tokenParams.get("code")).toBe(mock.code);
    expect(tokenParams.get("client_id")).toBe("dcr-client-id-999");
    expect(tokenParams.get("code_verifier")).toBeTruthy();
  }, 15_000);
});
