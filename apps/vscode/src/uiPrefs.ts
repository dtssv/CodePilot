// Shared UI prefs across the chat sidebar and the wide Settings webview.
// Each webview has isolated localStorage; the extension host is the SoT bridge.

import type * as vscode from "vscode";

const GLOBAL_KEY = "codepilot.uiPrefs";

export type UiPrefs = {
  /** light | dark | system — client-local, not ~/.codepilot. */
  theme?: "light" | "dark" | "system";
  themeName?: string;
  locale?: string;
  /** Chat dock: left | right | top | bottom (this VS Code client only). */
  panelPosition?: "left" | "right" | "top" | "bottom";
  endpoint?: { providerId: string; model: string; cwd?: string };
};

export function loadUiPrefs(ctx: vscode.ExtensionContext): UiPrefs {
  try {
    const raw = ctx.globalState?.get?.<UiPrefs>(GLOBAL_KEY);
    return raw && typeof raw === "object" ? { ...raw } : {};
  } catch {
    return {};
  }
}

export function mergeUiPrefs(ctx: vscode.ExtensionContext, patch: UiPrefs): UiPrefs {
  const next: UiPrefs = { ...loadUiPrefs(ctx) };
  if (patch.theme === "light" || patch.theme === "dark" || patch.theme === "system") {
    next.theme = patch.theme;
  }
  if (typeof patch.themeName === "string" && patch.themeName.trim()) next.themeName = patch.themeName.trim();
  if (patch.locale === "zh" || patch.locale === "en") next.locale = patch.locale;
  if (
    patch.panelPosition === "left" ||
    patch.panelPosition === "right" ||
    patch.panelPosition === "top" ||
    patch.panelPosition === "bottom"
  ) {
    next.panelPosition = patch.panelPosition;
  }
  if (patch.endpoint?.model) {
    next.endpoint = {
      model: patch.endpoint.model,
      providerId: patch.endpoint.providerId || "_active",
      cwd: patch.endpoint.cwd,
    };
  }
  try {
    void ctx.globalState?.update?.(GLOBAL_KEY, next);
  } catch {
    /* tests / missing Memento */
  }
  return next;
}
