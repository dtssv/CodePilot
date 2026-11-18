/**
 * Composer key bindings: "default" (emacs-style line editing) or "vim".
 * Persisted as a single value at ~/.codepilot/tui-editor-mode.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type EditorMode = "default" | "vim";

export function defaultEditorModePath(home: string = homedir()): string {
  return join(home, ".codepilot", "tui-editor-mode");
}

/** Sync + fail-soft; anything unrecognised reads as "default". */
export function loadEditorMode(path: string = defaultEditorModePath()): EditorMode {
  try {
    return readFileSync(path, "utf-8").trim() === "vim" ? "vim" : "default";
  } catch {
    return "default";
  }
}

export function saveEditorMode(mode: EditorMode, path: string = defaultEditorModePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, mode, "utf-8");
  } catch {
    /* a read-only home must not crash the TUI */
  }
}
