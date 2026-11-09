/**
 * Shared key-matching helpers for Ink `useInput` handlers.
 *
 * Esc detection is centralised here because some terminals deliver a bare
 * Escape as the raw `\u001B` byte in `input` without Ink setting `key.escape`
 * (SSH, certain paste and multiplexer setups). Matching both keeps "Esc to
 * cancel" working everywhere.
 */
import type { Key } from "ink";

/** True when the user pressed Escape, however the terminal reported it. */
export function isEscape(input: string, key: Key): boolean {
  return key.escape || input === "\u001B" || input === "\x1b";
}

/** True when the user pressed Ctrl+C. */
export function isCtrlC(input: string, key: Key): boolean {
  return key.ctrl && input === "c";
}

/** True when the user asked to cancel: Escape or Ctrl+C. */
export function isCancel(input: string, key: Key): boolean {
  return isEscape(input, key) || isCtrlC(input, key);
}
