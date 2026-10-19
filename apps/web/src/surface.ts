// Which surface this page is running as, and its theme.
//
// One bundle serves every graphical client:
// web browser tab against `codepilot serve --web` (connect screen)
// agent the task-oriented agent UI (desktop or `?layout=agent`)
// embedded VSCode / IntelliJ sidebar, talking through the host bridge
// The layout comes from `?layout=`, else the host, else the saved choice.

import { detectHostKind, type HostKind } from "./protocol/bridge.js";

export type Layout = "web" | "agent" | "embedded";
export type Theme = "light" | "dark";

const LAYOUT_KEY = "codepilot.layout";
const THEME_KEY = "codepilot.theme";

export interface Surface {
  layout: Layout;
  host: HostKind | null;
 /** Launched by the desktop app (Electron) rather than a browser tab. */
  desktop: boolean;
 /** Connection given in the URL (`?ws=…&token=…&cwd=…`), stripped after read. */
  autoConnect?: { url: string; token?: string; cwd: string };
}

export function detectSurface(): Surface {
  const host = detectHostKind();
  const params = safeParams();
  const desktop = params.get("desktop") === "1";
  const asked = params.get("layout");
  let layout: Layout;
  if (host) layout = "embedded";
  else if (asked === "agent" || asked === "web" || asked === "embedded") layout = asked;
  else if (desktop) layout = "agent";
  else layout = (readStore(LAYOUT_KEY) as Layout | null) === "agent" ? "agent" : "web";

  let autoConnect: Surface["autoConnect"];
  const token = params.get("token") ?? undefined;
  const ws = params.get("ws");
  if (!host && (token || ws)) {
    autoConnect = {
      url: ws ?? sameOriginSocket(),
      token,
      cwd: params.get("cwd") ?? "",
    };
 // The token grants command execution: keep it out of history/bookmarks.
    params.delete("token");
    const qs = params.toString();
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    } catch {
 /* not fatal */
    }
  }
  return { layout, host, desktop, autoConnect };
}

export function saveLayout(layout: Layout): void {
  if (layout !== "embedded") writeStore(LAYOUT_KEY, layout);
}

export function initialTheme(host: HostKind | null): Theme {
  const saved = readStore(THEME_KEY);
  if (!host && (saved === "light" || saved === "dark")) return saved;
  if (host === "vscode") {
    const cls = document.body.classList;
    if (cls.contains("vscode-light") || cls.contains("vscode-high-contrast-light")) return "light";
    if (cls.contains("vscode-dark") || cls.contains("vscode-high-contrast")) return "dark";
  }
  const preset = window.__codepilotHost?.theme;
  if (host && (preset === "light" || preset === "dark")) return preset;
  const param = safeParams().get("theme");
  if (param === "light" || param === "dark") return param;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme, persist = false): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  if (persist) writeStore(THEME_KEY, theme);
}

export function applyLayout(layout: Layout): void {
  document.documentElement.dataset.layout = layout;
}

function sameOriginSocket(): string {
  const { hostname, port } = window.location;
  return `ws://${hostname || "127.0.0.1"}${port ? `:${port}` : ""}/rpc`;
}

function safeParams(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
 /* private mode */
  }
}
