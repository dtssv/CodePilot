/**
 * Bridge VS Code `codepilot.*` settings into `~/.codepilot/config.json` so the
 * native IDE Settings UI can edit prefs while CLI / Desktop / plugins still
 * read the original user config file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import * as vscode from "vscode";

import { nls } from "./nls.js";

export const USER_CONFIG_PATH = (): string => join(homedir(), ".codepilot", "config.json");

/** Keys we mirror both ways (VS Code ↔ ~/.codepilot/config.json). */
const SYNC_KEYS = ["model", "provider", "permissionMode", "agentMode"] as const;
type SyncKey = (typeof SYNC_KEYS)[number];

const VS_KEYS: Record<SyncKey, string> = {
  model: "codepilot.model",
  provider: "codepilot.provider",
  permissionMode: "codepilot.permissionMode",
  agentMode: "codepilot.agentMode",
};

export function readUserConfig(): Record<string, unknown> {
  const path = USER_CONFIG_PATH();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function writeUserConfig(next: Record<string, unknown>): void {
  const path = USER_CONFIG_PATH();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/** Pull ~/.codepilot values into VS Code settings so the IDE page shows them. */
export async function pullCodepilotConfigIntoIde(): Promise<void> {
  const cfg = readUserConfig();
  const ide = vscode.workspace.getConfiguration();
  for (const key of SYNC_KEYS) {
    const value = cfg[key];
    if (value === undefined || value === null) continue;
    const vsKey = VS_KEYS[key];
    const current = ide.get(vsKey);
    if (current === value) continue;
    try {
      await ide.update(vsKey, value, vscode.ConfigurationTarget.Global);
    } catch {
      /* ignore inspect/update failures (remote, policy, etc.) */
    }
  }
}

/** Push a VS Code setting change into ~/.codepilot/config.json. */
export function pushIdeSettingToCodepilot(e: vscode.ConfigurationChangeEvent): void {
  let touched = false;
  const cfg = readUserConfig();
  const ide = vscode.workspace.getConfiguration();
  for (const key of SYNC_KEYS) {
    const vsKey = VS_KEYS[key];
    if (!e.affectsConfiguration(vsKey)) continue;
    const value = ide.get(vsKey);
    if (value === undefined) continue;
    if (cfg[key] === value) continue;
    cfg[key] = value;
    touched = true;
  }
  if (touched) writeUserConfig(cfg);
}

export function registerConfigSync(context: vscode.ExtensionContext): void {
  void pullCodepilotConfigIntoIde();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("codepilot")) return;
      pushIdeSettingToCodepilot(e);
    }),
  );
}

/** Open the native IDE Settings UI focused on this extension. */
export function openIdeSettings(): Thenable<unknown> {
  return vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "@ext:codepilot.codepilot-vscode",
  );
}

/** Open ~/.codepilot/config.json in the IDE editor (advanced / providers). */
export async function openUserConfigFile(): Promise<void> {
  const path = USER_CONFIG_PATH();
  if (!existsSync(path)) {
    writeUserConfig({
      provider: "openai",
      model: "",
      permissionMode: "ask",
      agentMode: "agent",
    });
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * Native QuickPick + password InputBox to set the flat `apiKey` on
 * ~/.codepilot/config.json (and optionally stamp provider). Core encrypts
 * secrets on the next load/migrate.
 */
export async function configureApiKeyWithIdeUi(): Promise<void> {
  const provider = await vscode.window.showQuickPick(
    [
      { label: nls("Anthropic"), description: "claude-*", id: "anthropic" },
      { label: nls("OpenAI / compatible"), description: "gpt-*, DeepSeek, …", id: "openai" },
      { label: nls("Google Gemini"), description: "gemini-*", id: "gemini" },
      { label: nls("GitHub Copilot"), description: "copilot", id: "copilot" },
      { label: nls("Azure OpenAI"), description: "azure", id: "azure" },
    ],
    { title: nls("CodePilot: Set API Key"), placeHolder: nls("Select provider") },
  );
  if (!provider) return;

  const apiKey = await vscode.window.showInputBox({
    title: nls("CodePilot: Set API Key"),
    prompt: nls("API key is saved to ~/.codepilot/config.json"),
    password: true,
    ignoreFocusOut: true,
    placeHolder: "sk-…",
  });
  if (apiKey === undefined) return;
  if (!apiKey.trim()) {
    void vscode.window.showWarningMessage(nls("API key was empty — nothing saved."));
    return;
  }

  const cfg = readUserConfig();
  cfg.provider = provider.id;
  cfg.apiKey = apiKey.trim();
  writeUserConfig(cfg);
  try {
    await vscode.workspace
      .getConfiguration()
      .update("codepilot.provider", provider.id, vscode.ConfigurationTarget.Global);
  } catch {
    /* ignore */
  }
  void vscode.window.showInformationMessage(
    nls("API key saved to ~/.codepilot/config.json ({0})", provider.label),
  );
}
