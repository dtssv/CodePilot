/**
 * Named TUI palettes — the codex-style "whole theme" token swap for the
 * terminal, mirroring the web's named palettes in apps/web/src/index.css.
 *
 * A palette is the eight-colour `TuiPalette` set the UI reads from `theme.ts`.
 * The TUI runs on a single (usually dark) terminal, so — unlike the web — each
 * named palette is one set, not a light/dark pair. `default` is the built-in
 * CodePilot look; the rest match the web's dark variants so the two clients
 * read as the same product. Keep this list in sync with THEME_NAMES in
 * apps/web/src/surface.ts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface TuiPalette {
  accent: string;
  accentStrong: string;
  info: string;
  add: string;
  remove: string;
  warn: string;
  faint: string;
  edge: string;
}

export type ThemeName = "default" | "nord" | "solarized" | "high-contrast";

/** All selectable palettes, in display order. */
export const THEME_NAMES: readonly ThemeName[] = [
  "default",
  "nord",
  "solarized",
  "high-contrast",
] as const;

export const THEMES: Record<ThemeName, TuiPalette> = {
  default: {
    accent: "#8b7cff",
    accentStrong: "#6d5bf6",
    info: "#4ba3ff",
    add: "#3fb97f",
    remove: "#f0616d",
    warn: "#e8b04a",
    faint: "#6b7386",
    edge: "#2a3142",
  },
  nord: {
    accent: "#88c0d0",
    accentStrong: "#8fbcbb",
    info: "#81a1c1",
    add: "#a3be8c",
    remove: "#bf616a",
    warn: "#ebcb8b",
    faint: "#7b88a1",
    edge: "#434c5e",
  },
  solarized: {
    accent: "#268bd2",
    accentStrong: "#2aa198",
    info: "#268bd2",
    add: "#859900",
    remove: "#dc322f",
    warn: "#b58900",
    faint: "#657b83",
    edge: "#0a4653",
  },
  "high-contrast": {
    accent: "#7cc7ff",
    accentStrong: "#a9d9ff",
    info: "#7cc7ff",
    add: "#5fe08a",
    remove: "#ff8089",
    warn: "#ffd45e",
    faint: "#b0b0b0",
    edge: "#6b6b6b",
  },
};

/** Human labels for the picker. */
export const THEME_LABELS: Record<ThemeName, string> = {
  default: "Default",
  nord: "Nord",
  solarized: "Solarized",
  "high-contrast": "High contrast",
};

// --- persistence (a single value at ~/.codepilot/tui-theme) --------------

export function defaultThemePrefPath(home: string = homedir()): string {
  return join(home, ".codepilot", "tui-theme");
}

/** The saved palette name, or "default" when none/unknown. Sync + fail-soft. */
export function loadThemePref(path: string = defaultThemePrefPath()): ThemeName {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    return (THEME_NAMES as readonly string[]).includes(raw) ? (raw as ThemeName) : "default";
  } catch {
    return "default";
  }
}

/** Persist the palette name. Fail-soft (a read-only home must not crash). */
export function saveThemePref(name: ThemeName, path: string = defaultThemePrefPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, name, "utf-8");
  } catch {
    /* ignore */
  }
}
