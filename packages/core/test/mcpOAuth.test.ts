import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateCodeVerifier,
  codeChallengeS256,
  parseResourceMetadataHeader,
  buildAuthorizationUrl,
  loadTokenBundle,
  saveTokenBundle,
  clearTokenBundle,
  isTokenValid,
  type McpTokenBundle,
  type McpOAuthServerConfig,
  type AuthorizationServerMetadata,
} from "../src/mcpOAuth.js";

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe("PKCE helpers", () => {
  it("generates a 43+ char url-safe verifier", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates different verifiers on each call", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it("computes a deterministic S256 challenge for a given verifier", () => {
    const verifier = "deterministic-verifier-for-testing-purposes";
    const challenge = codeChallengeS256(verifier);
    // The challenge must be url-safe base64 without padding.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain("=");
    // The same verifier → same challenge.
    expect(codeChallengeS256(verifier)).toBe(challenge);
  });

  it("produces different challenges for different verifiers", () => {
    expect(codeChallengeS256("a")).not.toBe(codeChallengeS256("b"));
  });
});

// ---------------------------------------------------------------------------
// WWW-Authenticate header parsing
// ---------------------------------------------------------------------------

describe("parseResourceMetadataHeader", () => {
  it("extracts the resource_metadata URL from a Bearer challenge", () => {
    const header =
      'Bearer resource_metadata="https://host/.well-known/oauth-protected-resource"';
    expect(parseResourceMetadataHeader(header)).toBe(
      "https://host/.well-known/oauth-protected-resource",
    );
  });

  it("is case-insensitive on the scheme", () => {
    expect(
      parseResourceMetadataHeader(
        'bearer resource_metadata="https://x/rm"',
      ),
    ).toBe("https://x/rm");
  });

  it("tolerates unquoted values", () => {
    expect(
      parseResourceMetadataHeader("Bearer resource_metadata=https://x/rm"),
    ).toBe("https://x/rm");
  });

  it("returns null when the header is absent", () => {
    expect(parseResourceMetadataHeader(undefined)).toBeNull();
    expect(parseResourceMetadataHeader(null)).toBeNull();
    expect(parseResourceMetadataHeader("")).toBeNull();
  });

  it("returns null for non-Bearer schemes", () => {
    expect(parseResourceMetadataHeader('Basic realm="x"')).toBeNull();
  });

  it("returns null when resource_metadata is absent", () => {
    expect(parseResourceMetadataHeader("Bearer realm=\"x\"")).toBeNull();
  });

  it("handles extra params before resource_metadata", () => {
    expect(
      parseResourceMetadataHeader(
        'Bearer realm="x", resource_metadata="https://y/rm"',
      ),
    ).toBe("https://y/rm");
  });
});

// ---------------------------------------------------------------------------
// Authorization URL construction
// ---------------------------------------------------------------------------

describe("buildAuthorizationUrl", () => {
  const cfg: McpOAuthServerConfig = {
    serverName: "test",
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "client-123",
    redirectUri: "http://127.0.0.1:4567/callback",
    redirectPort: 4567,
  };

  it("builds a URL with all required PKCE params", () => {
    const url = buildAuthorizationUrl(cfg, {
      codeVerifier: "verifier-xyz",
      state: "state-abc",
    });
    const u = new URL(url);
    expect(u.origin).toBe("https://auth.example.com");
    expect(u.pathname).toBe("/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("client-123");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:4567/callback",
    );
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe("state-abc");
    // The challenge must be the S256 hash of the verifier.
    expect(u.searchParams.get("code_challenge")).toBe(
      codeChallengeS256("verifier-xyz"),
    );
  });

  it("uses configured scopes when provided", () => {
    const url = buildAuthorizationUrl(
      { ...cfg, scopes: ["repo", "user"] },
      { codeVerifier: "v", state: "s" },
    );
    expect(new URL(url).searchParams.get("scope")).toBe("repo user");
  });

  it("falls back to 'openid profile' when no scopes configured", () => {
    const url = buildAuthorizationUrl(cfg, {
      codeVerifier: "v",
      state: "s",
    });
    expect(new URL(url).searchParams.get("scope")).toBe("openid profile");
  });
});

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

describe("token persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oauth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const bundle: McpTokenBundle = {
    accessToken: "access-xyz",
    tokenType: "Bearer",
    expiresAt: Date.now() + 3600_000,
    refreshToken: "refresh-abc",
    scope: "repo",
  };

  it("save → load round-trips a token bundle", async () => {
    await saveTokenBundle(dir, "github", bundle);
    const loaded = await loadTokenBundle(dir, "github");
    expect(loaded).toEqual(bundle);
  });

  it("load returns null when no token exists", async () => {
    expect(await loadTokenBundle(dir, "nope")).toBeNull();
  });

  it("load returns null for a corrupt file", async () => {
    const path = join(dir, ".codepilot", "mcp-tokens", "bad.json");
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(join(path, ".."), { recursive: true }).then(() =>
        writeFile(path, "not json"),
      ),
    );
    expect(await loadTokenBundle(dir, "bad")).toBeNull();
  });

  it("clear removes the token", async () => {
    await saveTokenBundle(dir, "github", bundle);
    await clearTokenBundle(dir, "github");
    expect(await loadTokenBundle(dir, "github")).toBeNull();
  });

  it("sanitizes server names to prevent path escape", async () => {
    await saveTokenBundle(dir, "../../etc/passwd", bundle);
    // The file should be written under .codepilot/mcp-tokens/, not escape.
    const loaded = await loadTokenBundle(dir, "../../etc/passwd");
    expect(loaded).toEqual(bundle);
  });
});

// ---------------------------------------------------------------------------
// isTokenValid
// ---------------------------------------------------------------------------

describe("isTokenValid", () => {
  it("returns false for null", () => {
    expect(isTokenValid(null)).toBe(false);
  });

  it("returns true for a token with no expiry", () => {
    const b: McpTokenBundle = { accessToken: "x", tokenType: "Bearer" };
    expect(isTokenValid(b)).toBe(true);
  });

  it("returns true for a token that expires in the future", () => {
    const b: McpTokenBundle = {
      accessToken: "x",
      tokenType: "Bearer",
      expiresAt: Date.now() + 600_000,
    };
    expect(isTokenValid(b)).toBe(true);
  });

  it("returns false for an expired token", () => {
    const b: McpTokenBundle = {
      accessToken: "x",
      tokenType: "Bearer",
      expiresAt: Date.now() - 1000,
    };
    expect(isTokenValid(b)).toBe(false);
  });

  it("returns false for a token expiring within the 60s refresh window", () => {
    const b: McpTokenBundle = {
      accessToken: "x",
      tokenType: "Bearer",
      expiresAt: Date.now() + 30_000, // 30s out, inside the 60s window
    };
    expect(isTokenValid(b)).toBe(false);
  });
});
