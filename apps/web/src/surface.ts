// Which surface this page runs as, and its theme. One bundle serves every
// graphical client: web tab, agent UI, or embedded sidebar. Layout comes from
// `?layout=`, else the host, else the saved choice.

import { detectHostKind, type HostKind } from "./protocol/bridge.js";

export type Layout = "web" | "agent" | "embedded";
export type Theme = "light" | "dark";

/**
 * A named colour palette layered on the light/dark axis. `default` is the
 * built-in palette; other names swap the `--color-*` token set via
 * `[data-theme-name]` and still compose with the Theme toggle.
 */
export type ThemeName = "default" | "nord" | "solarized" | "high-contrast";

/** All selectable palettes, in display order. */
export const THEME_NAMES: readonly ThemeName[] = [
  "default",
  "nord",
  "solarized",
  "high-contrast",
] as const;

const LAYOUT_KEY = "codepilot.layout";
const THEME_KEY = "codepilot.theme";
const THEME_NAME_KEY = "codepilot.themeName";

export interface Surface {
  layout: Layout;
  host: HostKind | null;
 /** Launched by the desktop app (Electron) rather than a browser tab. */
  desktop: boolean;
 /** Phone QR remote-control session (`?remote=1`). */
  remote: boolean;
 /** Connection given in the URL (`?ws=…&token=…&cwd=…`), stripped after read. */
  autoConnect?: { url: string; token?: string; cwd: string };
 /** Workspaces authorized for a remote pairing (`?cwds=` JSON), for seeding the
  * phone's workspace list. Empty on non-remote surfaces. */
  remoteCwds?: string[];
}

export function detectSurface(): Surface {
  const host = detectHostKind();
  const params = safeParams();
  const desktop = params.get("desktop") === "1";
  const remote = params.get("remote") === "1";
  const asked = params.get("layout");
  let layout: Layout;
  if (host) layout = "embedded";
  else if (asked === "agent" || asked === "web" || asked === "embedded") layout = asked;
  else if (remote) layout = "agent";
  else if (desktop) layout = "web";
  else layout = (readStore(LAYOUT_KEY) as Layout | null) === "agent" ? "agent" : "web";

  let autoConnect: Surface["autoConnect"];
  let remoteCwds: string[] | undefined;
  const token = params.get("token") ?? undefined;
  const ws = params.get("ws");
  if (!host && (token || ws)) {
    autoConnect = {
      url: ws ?? sameOriginSocket(),
      token,
      cwd: params.get("cwd") ?? "",
    };
    remoteCwds = parseCwds(params.get("cwds"));
 // The token grants command execution: keep it out of history/bookmarks.
    params.delete("token");
    params.delete("cwds");
    const qs = params.toString();
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    } catch {
 /* not fatal */
    }
  }
  return { layout, host, desktop, remote, autoConnect, remoteCwds };
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

/** The saved named palette, or "default" when none/unknown. Named palettes are
 * a pure client pref — never host-driven (a host only controls light/dark). */
export function initialThemeName(): ThemeName {
  const saved = readStore(THEME_NAME_KEY);
  return (THEME_NAMES as readonly string[]).includes(saved ?? "")
    ? (saved as ThemeName)
    : "default";
}

/** Apply a named palette by setting `data-theme-name` on <html>. "default"
 * removes the attribute so the base `--color-*` tokens apply. */
export function applyThemeName(name: ThemeName, persist = false): void {
  if (name === "default") delete document.documentElement.dataset.themeName;
  else document.documentElement.dataset.themeName = name;
  if (persist) writeStore(THEME_NAME_KEY, name);
}

export function applyLayout(layout: Layout): void {
  document.documentElement.dataset.layout = layout;
}

/** Parse the `?cwds=` JSON array of authorized workspaces; [] when absent/bad. */
function parseCwds(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) {
      const out = arr.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
      return out.length ? out : undefined;
    }
  } catch {
    /* malformed — ignore */
  }
  return undefined;
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
