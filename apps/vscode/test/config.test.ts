import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { modeLabel, SettingsStore, StatusBar } from "../src/config.js";

/* ---------------- SettingsStore ---------------- */

describe("SettingsStore", () => {
  it("returns defaults when nothing is configured", () => {
    const store = new SettingsStore();
    expect(store.snapshot()).toEqual({
      serverPath: "codepilot",
      cliPath: "",
      nodePath: "node",
      permissionMode: "ask",
      model: "",
      provider: "",
      systemPromptExtra: "",
      autoApprove: [],
      showDiff: true,
      protocolVersion: 1,
      agentMode: "agent",
    });
    store.dispose();
  });

  it("reads configured values", () => {
    (vscode as unknown as { __setConfig(k: string, v: unknown): void }).__setConfig(
      "codepilot.serverPath",
      "/usr/local/bin/codepilot",
    );
    const mock = vscode as unknown as { __setConfig(k: string, v: unknown): void };
    mock.__setConfig("codepilot.permissionMode", "yolo");
    mock.__setConfig("codepilot.model", "claude-sonnet-4.5");
    mock.__setConfig("codepilot.provider", "anthropic");
    mock.__setConfig("codepilot.autoApprove", ["read_file"]);
    mock.__setConfig("codepilot.showDiff", false);
    mock.__setConfig("codepilot.protocolVersion", 2);
    mock.__setConfig("codepilot.agentMode", "plan");

    const store = new SettingsStore();
    const snap = store.snapshot();
    expect(snap.serverPath).toBe("/usr/local/bin/codepilot");
    expect(snap.permissionMode).toBe("yolo");
    expect(snap.model).toBe("claude-sonnet-4.5");
    expect(snap.provider).toBe("anthropic");
    expect(snap.autoApprove).toEqual(["read_file"]);
    expect(snap.showDiff).toBe(false);
    expect(snap.protocolVersion).toBe(2);
    expect(snap.agentMode).toBe("plan");
    store.dispose();
  });

  it("notifies listeners when codepilot configuration changes", () => {
    const mock = vscode as unknown as {
      __setConfig(k: string, v: unknown): void;
      __fireConfigChange(section?: string): void;
    };
    const store = new SettingsStore();
    const seen: string[] = [];
    store.onChange((s) => seen.push(s.model));

    mock.__setConfig("codepilot.model", "gpt-5");
    mock.__fireConfigChange("codepilot");
    expect(seen).toEqual(["gpt-5"]);
    store.dispose();
  });

  it("ignores configuration changes in unrelated sections", () => {
    const mock = vscode as unknown as {
      __fireConfigChange(section?: string): void;
    };
    const store = new SettingsStore();
    let calls = 0;
    store.onChange(() => calls++);

    mock.__fireConfigChange("editor");
    expect(calls).toBe(0);
    store.dispose();
  });

  it("re-reads values after a change event (snapshot is not stale)", () => {
    const mock = vscode as unknown as {
      __setConfig(k: string, v: unknown): void;
      __fireConfigChange(section?: string): void;
    };
    const store = new SettingsStore();
    expect(store.snapshot().permissionMode).toBe("ask");

    mock.__setConfig("codepilot.permissionMode", "auto-edit");
    mock.__fireConfigChange("codepilot");
    expect(store.snapshot().permissionMode).toBe("auto-edit");
    store.dispose();
  });

  it("stops notifying a listener after its disposable is disposed", () => {
    const mock = vscode as unknown as {
      __setConfig(k: string, v: unknown): void;
      __fireConfigChange(section?: string): void;
    };
    const store = new SettingsStore();
    let calls = 0;
    const sub = store.onChange(() => calls++);

    mock.__fireConfigChange("codepilot");
    sub.dispose();
    mock.__setConfig("codepilot.model", "x");
    mock.__fireConfigChange("codepilot");
    expect(calls).toBe(1);
    store.dispose();
  });

  it("dispose() detaches the workspace listener and clears listeners", () => {
    const mock = vscode as unknown as {
      __fireConfigChange(section?: string): void;
    };
    const store = new SettingsStore();
    let calls = 0;
    store.onChange(() => calls++);
    store.dispose();

    mock.__fireConfigChange("codepilot");
    expect(calls).toBe(0);
  });
});

/* ---------------- StatusBar ---------------- */

type VscodeMock = {
  __statusBarItems: Array<{ text: string; command?: string; tooltip?: string }>;
  __executedCommands: Array<{ command: string; args: unknown[] }>;
};

function lastItem(): { text: string; command?: string } {
  const items = (vscode as unknown as VscodeMock).__statusBarItems;
  return items[items.length - 1];
}

describe("StatusBar", () => {
  it("registers the given command and renders the connecting state initially", () => {
    const bar = new StatusBar("codepilot.openSidebar");
    const item = lastItem();
    expect(item.command).toBe("codepilot.openSidebar");
    expect(item.text).toContain("$(sync~spin)");
    expect(item.text).toContain("CodePilot (connecting)");
    bar.dispose();
  });

  it("renders state icons and labels", () => {
    const bar = new StatusBar("cmd");

    bar.setState("ready");
    expect(lastItem().text).toBe("$(check) CodePilot");

    bar.setState("busy");
    expect(lastItem().text).toBe("$(loading~spin) CodePilot (busy)");

    bar.setState("error");
    expect(lastItem().text).toBe("$(error) CodePilot (error)");

    bar.setState("connecting");
    expect(lastItem().text).toBe("$(sync~spin) CodePilot (connecting)");
    bar.dispose();
  });

  it("toggles the codepilot.busy context key on state changes", () => {
    const bar = new StatusBar("cmd");
    const cmds = (vscode as unknown as VscodeMock).__executedCommands;

    bar.setState("busy");
    bar.setState("ready");
    bar.dispose();

    expect(cmds).toEqual([
      { command: "setContext", args: ["codepilot.busy", true] },
      { command: "setContext", args: ["codepilot.busy", false] },
    ]);
  });

  it("shows the mode label when a mode is set", () => {
    const bar = new StatusBar("cmd");
    bar.setState("ready");

    bar.setMode("chat");
    expect(lastItem().text).toBe("$(check) CodePilot  ·  Ask");

    bar.setMode("plan");
    expect(lastItem().text).toBe("$(check) CodePilot  ·  Plan");

    bar.setMode("agent");
    expect(lastItem().text).toBe("$(check) CodePilot  ·  Agent");

    bar.setMode(null);
    expect(lastItem().text).toBe("$(check) CodePilot");
    bar.dispose();
  });

  it("accumulates and formats token usage", () => {
    const bar = new StatusBar("cmd");
    bar.setState("ready");

    bar.addUsage({ input: 400, output: 100 });
    expect(lastItem().text).toContain("500 tok");

    bar.addUsage({ input: 1000, output: 0 });
    expect(lastItem().text).toContain("1.5k tok");

    bar.resetUsage();
    expect(lastItem().text).toBe("$(check) CodePilot");
    bar.dispose();
  });

  it("renders cost only when positive", () => {
    const bar = new StatusBar("cmd");
    bar.setState("ready");

    bar.addUsage({ input: 10, output: 5 });
    // No cost field yet — the status line should not show a "$<number>" cost
    // segment. (It still contains "$(check)" — the theme-icon glyph — which
    // is unrelated, so we check for the cost pattern, not the bare "$" char.)
    expect(lastItem().text).not.toMatch(/\$\d/);

    bar.addUsage({ costUSD: 0.01234 });
    expect(lastItem().text).toContain("$0.012");
    bar.dispose();
  });

  it("combines mode, usage and cost in one line", () => {
    const bar = new StatusBar("cmd");
    bar.setState("ready");
    bar.setMode("agent");
    bar.addUsage({ input: 2000, output: 500, costUSD: 0.5 });
    expect(lastItem().text).toBe("$(check) CodePilot  ·  Agent  ·  2.5k tok  ·  $0.500");
    bar.dispose();
  });
});

/* ---------------- modeLabel ---------------- */

describe("modeLabel", () => {
  it("maps each agent mode to its human label", () => {
    expect(modeLabel("chat")).toBe("Ask");
    expect(modeLabel("plan")).toBe("Plan");
    expect(modeLabel("agent")).toBe("Agent");
  });
});
