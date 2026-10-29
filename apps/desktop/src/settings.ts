// Desktop app state that outlives a window: the last folder worked in.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface DesktopSettings {
  lastFolder?: string;
  /** Allow LAN access to the local daemon (bind 0.0.0.0 instead of loopback)
   * so phone QR remote control works. Off by default — the daemon stays on
   * 127.0.0.1 and is only reachable from this machine. Token auth is always
   * on, so even when exposed only holders of the token can connect. */
  lanAccess?: boolean;
}

export function loadSettings(file: string): DesktopSettings {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      const o = raw as { lastFolder?: unknown; lanAccess?: unknown };
      const out: DesktopSettings = {};
      if (typeof o.lastFolder === "string") out.lastFolder = o.lastFolder;
      if (typeof o.lanAccess === "boolean") out.lanAccess = o.lanAccess;
      return out;
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
 * one used. Returns null when nothing is known — the UI then shows the
 * "open a workspace" prompt instead of defaulting to the home root.
 */
export function initialFolder(argv: readonly string[], settings: DesktopSettings, cwd: string): string | null {
  for (const arg of argv) {
    if (arg.startsWith("-")) continue;
    const abs = resolve(cwd, arg);
    if (isDir(abs)) return abs;
  }
  if (settings.lastFolder && isDir(settings.lastFolder)) return settings.lastFolder;
  return null;
}

/** The built web UI: bundled next to the app when packaged, else the workspace build. */
export function findWebRoot(candidates: readonly string[]): string | null {
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null;
}
