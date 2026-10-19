/**
 * Render-level tests for the new TUI interaction components.
 * Ink components render to strings in tests (render from ink with a
 * patched stdout is overkill; <CommandPalette/> is pure so we can render
 * it with ink's renderToString-free approach via react-dom/server? No —
 * Ink uses its own renderer. Instead we test the *logic* seams here and
 * keep component tests to shallow prop contracts via direct invocation.
 */
import { describe, expect, it } from "vitest";
import { paletteState } from "../src/ui/CommandPalette.js";
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
