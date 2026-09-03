// Thin wrapper around `vscode.workspace.getConfiguration` that:
//  - reads values once at activation (and reacts to changes),
//  - exposes a typed `CodepilotSettings` to the rest of the extension,
//  - drives the status bar (connection + cumulative token usage).

import * as vscode from "vscode";
import type { PermissionMode } from "./types.js";

export interface CodepilotSettings {
  serverPath: string;
  cliPath: string;
  nodePath: string;
  permissionMode: PermissionMode;
  model: string;
  provider: "" | "anthropic" | "openai" | "copilot";
  systemPromptExtra: string;
  autoApprove: string[];
  showDiff: boolean;
  protocolVersion: number;
}

const KEYS = {
  serverPath: "codepilot.serverPath",
  cliPath: "codepilot.cliPath",
  nodePath: "codepilot.nodePath",
  permissionMode: "codepilot.permissionMode",
  model: "codepilot.model",
  provider: "codepilot.provider",
  systemPromptExtra: "codepilot.systemPromptExtra",
  autoApprove: "codepilot.autoApprove",
  showDiff: "codepilot.showDiff",
  protocolVersion: "codepilot.protocolVersion",
} as const;

function readConfig(cfg: vscode.WorkspaceConfiguration): CodepilotSettings {
  const provider = cfg.get<string>(KEYS.provider, "") as CodepilotSettings["provider"];
  return {
    serverPath: cfg.get<string>(KEYS.serverPath, "codepilot"),
    cliPath: cfg.get<string>(KEYS.cliPath, ""),
    nodePath: cfg.get<string>(KEYS.nodePath, "node"),
    permissionMode: cfg.get<PermissionMode>(KEYS.permissionMode, "ask"),
    model: cfg.get<string>(KEYS.model, ""),
    provider,
    systemPromptExtra: cfg.get<string>(KEYS.systemPromptExtra, ""),
    autoApprove: cfg.get<string[]>(KEYS.autoApprove, []),
    showDiff: cfg.get<boolean>(KEYS.showDiff, true),
    protocolVersion: cfg.get<number>(KEYS.protocolVersion, 1),
  };
}

export type SettingsListener = (settings: CodepilotSettings) => void;

export class SettingsStore implements DisposableLike {
  private cfg: vscode.WorkspaceConfiguration;
  private listeners = new Set<SettingsListener>();
  private sub: vscode.Disposable;

  constructor() {
    this.cfg = vscode.workspace.getConfiguration("codepilot");
    this.sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codepilot")) {
        this.cfg = vscode.workspace.getConfiguration("codepilot");
        for (const l of this.listeners) l(this.snapshot());
      }
    });
  }

  snapshot(): CodepilotSettings {
    return readConfig(this.cfg);
  }

  onChange(l: SettingsListener): vscode.Disposable {
    this.listeners.add(l);
    return new vscode.Disposable(() => this.listeners.delete(l));
  }

  dispose(): void {
    this.sub.dispose();
    this.listeners.clear();
  }
}

/**
 * Status bar entry. Shows connection status + cumulative tokens.
 *
 * Clicks fire the registered command ("codepilot.openSidebar" by default).
 */
export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private cumulative = { input: 0, output: 0, cost: 0 };
  private state: "connecting" | "ready" | "error" | "busy" = "connecting";

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = command;
    this.item.tooltip = "CodePilot";
    this.item.show();
    this.render();
  }

  setState(state: "connecting" | "ready" | "error" | "busy"): void {
    this.state = state;
    this.render();
    // Toggle the `codepilot.busy` context so keybindings (esc to cancel) work.
    void vscode.commands.executeCommand("setContext", "codepilot.busy", state === "busy");
  }

  addUsage(u: { input?: number; output?: number; costUSD?: number }): void {
    this.cumulative.input += u.input ?? 0;
    this.cumulative.output += u.output ?? 0;
    this.cumulative.cost += u.costUSD ?? 0;
    this.render();
  }

  resetUsage(): void {
    this.cumulative = { input: 0, output: 0, cost: 0 };
    this.render();
  }

  private render(): void {
    const icon =
      this.state === "ready"
        ? "$(check)"
        : this.state === "busy"
        ? "$(loading~spin)"
        : this.state === "error"
        ? "$(error)"
        : "$(sync~spin)";
    const label =
      this.state === "ready"
        ? "CodePilot"
        : this.state === "busy"
        ? "CodePilot (busy)"
        : this.state === "error"
        ? "CodePilot (error)"
        : "CodePilot (connecting)";
    const usage =
      this.cumulative.input + this.cumulative.output > 0
        ? `  ·  ${formatNumber(this.cumulative.input + this.cumulative.output)} tok`
        : "";
    const cost =
      this.cumulative.cost > 0 ? `  ·  $${this.cumulative.cost.toFixed(3)}` : "";
    this.item.text = `${icon} ${label}${usage}${cost}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}

function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Tiny structural type so we don't need @types/vscode here for this helper.
interface DisposableLike {
  dispose(): void;
}