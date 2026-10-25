import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listConnectors,
  listConnectorsWithStatus,
  installConnector,
  updateConnector,
  setConnectorEnabled,
} from "../src/connectors.js";

describe("connectors", () => {
  it("catalog includes office connectors with auth links", async () => {
    const catalog = await listConnectors();
    const ids = catalog.map((c) => c.id);
    expect(ids).toContain("feishu");
    expect(ids).toContain("dingtalk");
    expect(ids).toContain("notion");
    expect(ids).toContain("wecom");
    expect(catalog.find((c) => c.id === "feishu")?.authUrl).toMatch(/feishu|lark/i);
  });

  it("installs feishu connector + skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "conn-"));
    const mcpConfigPath = join(root, "mcp.json");
    const skillsDir = join(root, "skills");
    const r = await installConnector({
      connectorId: "feishu",
      values: { APP_ID: "cli_x", APP_SECRET: "sec_y" },
      mcpConfigPath,
      skillsDir,
    });
    expect(r.mcpName).toBe("feishu");
    expect(r.message).toContain("连接器");
    const cfg = JSON.parse(readFileSync(mcpConfigPath, "utf-8")) as {
      mcpServers: { feishu: { env: Record<string, string> } };
    };
    expect(cfg.mcpServers.feishu.env.APP_ID).toBe("cli_x");
    expect(cfg.mcpServers.feishu.args).toContain("mcp");
    expect(readFileSync(r.skillPath!, "utf-8")).toContain("feishu-office");

    const withStatus = await listConnectorsWithStatus({ mcpConfigPath, skillsDir });
    const feishu = withStatus.find((c) => c.id === "feishu");
    expect(feishu?.status.installed).toBe(true);
    expect(feishu?.status.enabled).toBe(true);

    await setConnectorEnabled("feishu", false, { mcpConfigPath });
    const disabled = await listConnectorsWithStatus({ mcpConfigPath, skillsDir });
    expect(disabled.find((c) => c.id === "feishu")?.status.enabled).toBe(false);

    await updateConnector({
      connectorId: "feishu",
      values: { APP_ID: "cli_z" },
      mcpConfigPath,
      skillsDir,
    });
    const updated = JSON.parse(readFileSync(mcpConfigPath, "utf-8")) as {
      mcpServers: { feishu: { env: Record<string, string>; disabled?: boolean } };
    };
    expect(updated.mcpServers.feishu.env.APP_ID).toBe("cli_z");
    expect(updated.mcpServers.feishu.env.APP_SECRET).toBe("sec_y");
    expect(updated.mcpServers.feishu.disabled).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });
});
