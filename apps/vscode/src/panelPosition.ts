// Chat dock position for this VS Code client only (left / right / top / bottom).
// Implemented as mutually exclusive webview views gated by a context key.
//
// VS Code ignores `when` on `viewsContainers` entries (the container schema has
// no such field) and auto-hides a container with no visible view, so a
// container must always keep at least one visible view or its activitybar icon
// disappears. `DOCK_VIEW` is that anchor: it fills the primary container
// whenever the chat lives elsewhere and offers a one-click way back.

import * as vscode from "vscode";

export type PanelPosition = "left" | "right" | "top" | "bottom";

export const PANEL_POSITIONS: readonly PanelPosition[] = ["left", "right", "top", "bottom"];

export const CONFIG_KEY = "codepilot.panelPosition";
export const CONTEXT_KEY = "codepilot.panelPosition";

/** Webview view ids — one visible at a time via `when` on the contribution. */
export const CHAT_VIEW = {
  left: "codepilot.chatView",
  right: "codepilot.chatView.right",
  panel: "codepilot.chatView.panel",
} as const;

/** Always-visible anchor view in the primary container (see note above). */
export const DOCK_VIEW = "codepilot.dock";

export function isPanelPosition(v: unknown): v is PanelPosition {
  return v === "left" || v === "right" || v === "top" || v === "bottom";
}

export function readPanelPosition(): PanelPosition {
  const raw = vscode.workspace.getConfiguration().get<unknown>(CONFIG_KEY);
  return isPanelPosition(raw) ? raw : "left";
}

export function chatViewIdFor(position: PanelPosition): string {
  if (position === "right") return CHAT_VIEW.right;
  if (position === "top" || position === "bottom") return CHAT_VIEW.panel;
  return CHAT_VIEW.left;
}

/** Push the context key so package.json `when` clauses pick the right container. */
export async function applyPanelPositionContext(position: PanelPosition): Promise<void> {
  await vscode.commands.executeCommand("setContext", CONTEXT_KEY, position);
}

/**
 * Persist + apply dock position. Optionally move the workbench panel to top/bottom
 * when docking CodePilot into the panel area.
 */
export async function setPanelPosition(
  position: PanelPosition,
  opts?: { focus?: boolean },
): Promise<PanelPosition> {
  const cfg = vscode.workspace.getConfiguration();
  const inspect = cfg.inspect<string>(CONFIG_KEY);
  // Prefer updating wherever the user already set it; else User settings.
  const target =
    inspect?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspect?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await cfg.update(CONFIG_KEY, position, target);
  await applyPanelPositionContext(position);

  if (position === "top") {
    await vscode.commands.executeCommand("workbench.action.positionPanelTop").then(
      () => undefined,
      () => undefined,
    );
  } else if (position === "bottom") {
    await vscode.commands.executeCommand("workbench.action.positionPanelBottom").then(
      () => undefined,
      () => undefined,
    );
  }

  if (opts?.focus !== false) {
    await focusChatView(position);
  }
  return position;
}

export async function focusChatView(position = readPanelPosition()): Promise<void> {
  const viewId = chatViewIdFor(position);
  // Reveal the container first (helps when switching from a hidden `when` branch).
  // Container ids must be [a-z0-9_-] only — dots break secondarySidebar/panel registration.
  const container =
    position === "right"
      ? "workbench.view.extension.codepilot-right"
      : position === "top" || position === "bottom"
        ? "workbench.view.extension.codepilot-panel"
        : "workbench.view.extension.codepilot";
  await vscode.commands.executeCommand(container).then(
    () => undefined,
    () => undefined,
  );
  await vscode.commands.executeCommand(`${viewId}.focus`).then(
    () => undefined,
    () => undefined,
  );
}
