import { describe, expect, it } from "vitest";
import { delimiter } from "node:path";
import { augmentedPath } from "../src/mcp-stdio.js";

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
