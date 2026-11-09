/**
 * Render-level tests for the new TUI interaction components.
 * Ink components render to strings in tests (render from ink with a
 * patched stdout is overkill; <CommandPalette/> is pure so we can render
 * it with ink's renderToString-free approach via react-dom/server? No —
 * Ink uses its own renderer. Instead we test the *logic* seams here and
 * keep component tests to shallow prop contracts via direct invocation.
 */
import { describe, expect, it } from "vitest";
import { paletteState, paletteWindow } from "../src/ui/CommandPalette.js";
import type { CommandInfo } from "../src/ui/commands.js";

const cmds: CommandInfo[] = [
  { name: "help", description: "Show available commands" },
  { name: "model", description: "Switch the model", args: "<name>" },
  { name: "mode", description: "Switch permission mode", args: "<ask|auto-edit|yolo>" },
  { name: "sessions", description: "List saved sessions" },
];

describe("paletteState", () => {
  it("clamps selection into range", () => {
    const s = paletteState(cmds, "", 99);
    expect(s.selected).toBe(cmds.length - 1);
    expect(s.filtered).toHaveLength(cmds.length);
  });

  it("returns empty filtered list without crashing on no match", () => {
    const s = paletteState(cmds, "zzzz", 3);
    expect(s.filtered).toHaveLength(0);
    expect(s.selected).toBe(0);
  });

  it("narrows as the query refines", () => {
    expect(paletteState(cmds, "mo", 0).filtered.map((c) => c.name).sort((a, b) => a.localeCompare(b))).toEqual(["model", "mode"].sort((a, b) => a.localeCompare(b)));
 // "mode" exact-matches /mode and is also a subsequence of "model", so
 // both survive; the exact match must rank first.
    const refined = paletteState(cmds, "mode", 0).filtered.map((c) => c.name);
    expect(refined[0]).toBe("mode");
  });
});

describe("paletteWindow (scroll follows selection)", () => {
  it("shows the whole list when it fits", () => {
    expect(paletteWindow(5, 0, 10)).toEqual({ start: 0, end: 5 });
    expect(paletteWindow(10, 9, 10)).toEqual({ start: 0, end: 10 });
  });

  it("keeps the selected row inside the window when scrolled past maxRows", () => {
    // 30 items, window of 10, cursor at 20 → window must include index 20.
    const w = paletteWindow(30, 20, 10);
    expect(w.end - w.start).toBe(10);
    expect(20).toBeGreaterThanOrEqual(w.start);
    expect(20).toBeLessThan(w.end);
  });

  it("clamps the window to the list end", () => {
    const w = paletteWindow(30, 29, 10);
    expect(w).toEqual({ start: 20, end: 30 });
  });

  it("clamps the window to the list start", () => {
    const w = paletteWindow(30, 0, 10);
    expect(w).toEqual({ start: 0, end: 10 });
  });
});
