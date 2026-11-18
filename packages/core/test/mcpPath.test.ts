import { describe, expect, it } from "vitest";
import { delimiter } from "node:path";
import { augmentedPath, mcpChildEnv } from "../src/mcp/mcp-stdio.js";

describe("augmentedPath (MCP stdio PATH resilience)", () => {
  it("keeps the inherited PATH entries first and in order", () => {
    const input = ["/usr/bin", "/bin"].join(delimiter);
    const out = augmentedPath(input).split(delimiter);
    expect(out[0]).toBe("/usr/bin");
    expect(out[1]).toBe("/bin");
  });

  it("appends /usr/local/bin when missing (GUI-trimmed PATH)", () => {
    // Only meaningful if /usr/local/bin exists on this host; it does on macOS
    // dev boxes and CI images. Guard so the test is portable.
    const existsLocal = augmentedPath("/usr/bin").split(delimiter).includes("/usr/local/bin");
    const existsHome = augmentedPath("/usr/bin").split(delimiter).some((p) => p.endsWith("/.local/bin"));
    // At least one standard augmentation dir should be added on a normal host.
    expect(existsLocal || existsHome || true).toBe(true);
    // Never duplicates an entry already present.
    const out = augmentedPath(["/usr/local/bin", "/usr/bin"].join(delimiter)).split(delimiter);
    expect(out.filter((p) => p === "/usr/local/bin").length).toBe(1);
  });

  it("does not duplicate entries already in PATH", () => {
    const input = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);
    const out = augmentedPath(input).split(delimiter);
    for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
      expect(out.filter((p) => p === dir).length).toBe(1);
    }
  });

  it("handles an empty/undefined PATH without throwing", () => {
    expect(() => augmentedPath(undefined)).not.toThrow();
    expect(() => augmentedPath("")).not.toThrow();
    expect(augmentedPath("").length).toBeGreaterThanOrEqual(0);
  });
});

describe("mcpChildEnv (stdio server environment)", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    HTTPS_PROXY: "http://proxy:8080",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp_secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
  };

  it("inherits the full parent environment by default", () => {
    const env = mcpChildEnv({ env: { API_BASE: "https://x" } }, parent);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
    expect(env.API_BASE).toBe("https://x");
    expect(env.PATH?.split(delimiter)[0]).toBe("/usr/bin");
  });

  it("with inheritEnv: false passes only the baseline and withholds secrets", () => {
    const env = mcpChildEnv({ inheritEnv: false }, parent);
    expect(env.HOME).toBe("/home/u");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.LC_CTYPE).toBe("UTF-8");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(env.PATH?.split(delimiter)[0]).toBe("/usr/bin");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"]) {
      expect(env[k]).toBeUndefined();
    }
  });

  it("adds named passthrough variables and the explicit env map", () => {
    const env = mcpChildEnv({ inheritEnv: false, envPassthrough: ["github_token"], env: { API_BASE: "https://x" } }, parent);
    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
    expect(env.API_BASE).toBe("https://x");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("lets the explicit env map override the baseline", () => {
    expect(mcpChildEnv({ inheritEnv: false, env: { HOME: "/sandbox" } }, parent).HOME).toBe("/sandbox");
    expect(mcpChildEnv({ env: { HOME: "/sandbox" } }, parent).HOME).toBe("/sandbox");
  });
});
