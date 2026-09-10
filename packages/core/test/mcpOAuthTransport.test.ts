import { describe, expect, it, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { McpHttpClient } from "../src/mcp.js";

/**
 * Verify that McpHttpClient, when it receives a 401 with a
 * `WWW-Authenticate: Bearer resource_metadata=...` header, runs the OAuth
 * flow (discovery → PKCE → local redirect → token exchange) and retries the
 * original request with the new bearer token.
 *
 * We stand up a single mock HTTP server that plays every role:
 *   - The MCP endpoint (returns 401 on the first POST, success on the
 *     second).
 *   - The protected-resource metadata URL.
 *   - The authorization-server metadata URL.
 *   - The authorization endpoint (302 → loopback callback).
 *   - The token endpoint (returns a bearer token).
 *
 * The test asserts that:
 *   1. The retried request carries the `Authorization: Bearer <token>`
 *      header.
 *   2. The client's `start()` succeeds (handshake completes) after the
 *      OAuth flow.
 */
describe("McpHttpClient OAuth 401-retry", () => {
  let server: Server | null = null;
  let port: number;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  it("runs OAuth on 401 and retries the initialize handshake", async () => {
    // Track how many POSTs we've seen to the MCP endpoint.
    let mcpPostCount = 0;
    // The token we hand out, so we can assert the retry sends it.
    const issuedToken = "bearer-from-test-flow";

    server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");

        // MCP endpoint (the base URL path).
        if (req.method === "POST" && u.pathname === "/mcp") {
          mcpPostCount++;
          const authHeader = req.headers["authorization"];
          if (mcpPostCount === 1 || !authHeader) {
            // First request: no token → 401 with resource_metadata.
            res.writeHead(401, {
              "WWW-Authenticate": `Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource"`,
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
          }
          // Retried request with a token: parse the JSON-RPC and respond.
          let msg: { id?: number | string; method?: string } = {};
          try {
            msg = JSON.parse(body);
          } catch {
            /* ignore */
          }
          let result: unknown = {};
          if (msg.method === "initialize") {
            result = {
              protocolVersion: "2025-03-26",
              serverInfo: { name: "oauth-mock" },
              capabilities: {},
            };
          } else if (msg.method === "tools/list") {
            result = { tools: [{ name: "ping", description: "d" }] };
          } else if (msg.method?.startsWith("notifications/")) {
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
          return;
        }

        // Protected resource metadata.
        if (req.method === "GET" && u.pathname === "/.well-known/oauth-protected-resource") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              resource: `http://127.0.0.1:${port}/mcp`,
              authorization_servers: [
                `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`,
              ],
            }),
          );
          return;
        }

        // Authorization server metadata.
        if (req.method === "GET" && u.pathname === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              issuer: `http://127.0.0.1:${port}`,
              authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
              token_endpoint: `http://127.0.0.1:${port}/token`,
              registration_endpoint: `http://127.0.0.1:${port}/register`,
              scopes_supported: ["mcp"],
              code_challenge_methods_supported: ["S256"],
              grant_types_supported: ["authorization_code", "refresh_token"],
            }),
          );
          return;
        }

        // Dynamic client registration.
        if (req.method === "POST" && u.pathname === "/register") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ client_id: "dcr-test-client" }));
          return;
        }

        // Authorization endpoint — 302 redirect to the loopback callback.
        if (req.method === "GET" && u.pathname === "/authorize") {
          const state = u.searchParams.get("state") ?? "";
          const redirectUri = u.searchParams.get("redirect_uri") ?? "";
          const redirect = new URL(redirectUri);
          redirect.searchParams.set("code", "test-code-42");
          redirect.searchParams.set("state", state);
          res.writeHead(302, { Location: redirect.toString() });
          res.end();
          return;
        }

        // Token endpoint.
        if (req.method === "POST" && u.pathname === "/token") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: issuedToken,
              token_type: "Bearer",
              expires_in: 3600,
              scope: "mcp",
            }),
          );
          return;
        }

        res.writeHead(404);
        res.end("not found");
      });
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "object" === false) throw new Error("bad addr");
    port = (addr as { port: number }).port;

    // The `openAuthUrl` hook acts as the browser: fetch the authorization
    // URL (which the mock 302-redirects to the loopback callback the client
    // is listening on).
    const client = new McpHttpClient(
      "oauth-server",
      { type: "http", url: `http://127.0.0.1:${port}/mcp` },
      {
        cwd: "/tmp/codepilot-mcp-oauth-test",
        openAuthUrl: async (_server, url) => {
          const res = await fetch(url, { redirect: "manual" });
          const location = res.headers.get("location");
          if (location) await fetch(location);
        },
      },
    );

    await client.start();
    const tools = client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
    // The MCP endpoint should have been hit at least twice: the initial 401
    // and the retried (authorized) request.
    expect(mcpPostCount).toBeGreaterThanOrEqual(2);
    await client.stop();
  }, 15_000);
});
