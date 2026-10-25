import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMcpJson, listMcpMarkets } from "../src/mcpRegistry.js";

describe("listMcpMarkets", () => {
  it("returns open marketplace links", async () => {
    const markets = await listMcpMarkets();
    expect(markets.length).toBeGreaterThan(0);
    expect(markets.every((m) => m.url.startsWith("http"))).toBe(true);
    expect(markets.some((m) => m.id === "mcp-so")).toBe(true);
  });
});

describe("installMcpJson", () => {
  it("merges mcpServers from pasted JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcpj-"));
    const mcpConfigPath = join(root, "mcp.json");
    const r = await installMcpJson(
      JSON.stringify({
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo"] },
        },
      }),
      { mcpConfigPath },
    );
    expect(r.names).toEqual(["demo"]);
    const cfg = JSON.parse(readFileSync(mcpConfigPath, "utf-8")) as {
      mcpServers: { demo: { command: string } };
    };
    expect(cfg.mcpServers.demo.command).toBe("npx");
    rmSync(root, { recursive: true, force: true });
  });
});
