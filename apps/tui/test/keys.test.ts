import { describe, expect, it } from "vitest";
import type { Key } from "ink";
import { isEscape, isCtrlC, isCancel } from "../src/ui/keys.js";

const key = (over: Partial<Key> = {}): Key =>
  ({
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...over,
  }) as Key;

describe("isEscape", () => {
  it("matches the Ink escape flag", () => {
    expect(isEscape("", key({ escape: true }))).toBe(true);
  });

  it("matches a bare ESC byte even when the flag is not set", () => {
    // Some terminals deliver Escape as the raw control byte in `input`.
    expect(isEscape("\u001B", key())).toBe(true);
    expect(isEscape("\x1b", key())).toBe(true);
  });

  it("does not match ordinary input", () => {
    expect(isEscape("a", key())).toBe(false);
    expect(isEscape("", key())).toBe(false);
  });
});

describe("isCtrlC / isCancel", () => {
  it("detects Ctrl+C", () => {
    expect(isCtrlC("c", key({ ctrl: true }))).toBe(true);
    expect(isCtrlC("c", key())).toBe(false);
  });

  it("cancel is Escape or Ctrl+C", () => {
    expect(isCancel("", key({ escape: true }))).toBe(true);
    expect(isCancel("\u001B", key())).toBe(true);
    expect(isCancel("c", key({ ctrl: true }))).toBe(true);
    expect(isCancel("x", key())).toBe(false);
  });
});
