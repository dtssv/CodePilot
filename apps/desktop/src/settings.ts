// Desktop app state that outlives a window: the last folder worked in.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface DesktopSettings {
  lastFolder?: string;
}

export function loadSettings(file: string): DesktopSettings {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      const folder = (raw as { lastFolder?: unknown }).lastFolder;
      return typeof folder === "string" ? { lastFolder: folder } : {};
    }
  } catch {
 /* missing or corrupt: start fresh */
  }
  return {};
}

export function saveSettings(file: string, settings: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folder to open: a directory passed on the command line, else the last
 * one used, else home.
 */
export function initialFolder(argv: readonly string[], settings: DesktopSettings, home: string, cwd: string): string {
  for (const arg of argv) {
    if (arg.startsWith("-")) continue;
    const abs = resolve(cwd, arg);
    if (isDir(abs)) return abs;
  }
  if (settings.lastFolder && isDir(settings.lastFolder)) return settings.lastFolder;
  return home;
}

/** The built web UI: bundled next to the app when packaged, else the workspace build. */
export function findWebRoot(candidates: readonly string[]): string | null {
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null;
}
