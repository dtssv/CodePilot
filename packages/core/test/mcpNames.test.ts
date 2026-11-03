import { describe, expect, it } from "vitest";
import {
  normalizeMcpToolName,
  buildMcpToolNameMap,
  MCP_TOOL_NAME_MAX_LENGTH,
} from "../src/mcp.js";
import type { McpToolDescriptor } from "../src/mcp-types.js";

// normalizeMcpToolName exists solely to keep MCP tool names within the
// provider function-name limit (64 chars) while staying unique. It had no
// tests — these lock the length invariant (it previously overflowed by 2
// chars because the reserve math forgot the second `__` separator) and the
// collision-avoidance hash.

describe("normalizeMcpToolName", () => {
  it("returns the canonical name unchanged when it fits", () => {
    const n = normalizeMcpToolName("github", "create_issue");
    expect(n).toBe("mcp__github__create_issue");
    expect(n.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX_LENGTH);
  });

  it("never exceeds the provider limit, even for very long server+tool names", () => {
    const cases: Array<[string, string]> = [
      ["a".repeat(40), "b".repeat(40)],
      ["server-with-a-really-long-descriptive-name", "tool_also_quite_long_indeed_yes"],
      ["x".repeat(100), "y".repeat(100)],
      ["s".repeat(60), "t"],
      ["s", "t".repeat(60)],
      // Boundary: canonical form one char over the limit.
      ["srv", "t".repeat(MCP_TOOL_NAME_MAX_LENGTH)],
    ];
    for (const [server, tool] of cases) {
      const n = normalizeMcpToolName(server, tool);
      expect(
        n.length,
        `normalized "${server}"/"${tool}" was ${n.length} chars`,
      ).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX_LENGTH);
      // Still recognizably an mcp name with the hash suffix.
      expect(n.startsWith("mcp__")).toBe(true);
    }
  });

  it("appends a stable 8-char hash so distinct long names never collide", () => {
    const a = normalizeMcpToolName("s".repeat(60), "tool_one_long_name_here");
    const b = normalizeMcpToolName("s".repeat(60), "tool_two_long_name_here");
    expect(a).not.toBe(b); // differ despite sharing the truncated prefix
    // Deterministic: same inputs → same output.
    expect(normalizeMcpToolName("s".repeat(60), "tool_one_long_name_here")).toBe(a);
  });
});

describe("buildMcpToolNameMap", () => {
  it("maps each normalized name back to its (server, tool) pair", () => {
    const tools: McpToolDescriptor[] = [
      { server: "github", name: "create_issue", description: "", inputSchema: {} },
      {
        server: "s".repeat(60),
        name: "a_very_long_tool_name_that_forces_truncation",
        description: "",
        inputSchema: {},
      },
    ];
    const map = buildMcpToolNameMap(tools);
    for (const t of tools) {
      const normalized = normalizeMcpToolName(t.server, t.name);
      expect(map.get(normalized)).toEqual({ server: t.server, tool: t.name });
    }
  });
});
