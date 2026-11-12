// Shared built-in slash-command catalog.
//
// This catalog is the single cross-surface source of truth: the TUI derives its
// list from it and GUI clients list it via the `commands/list` RPC. These tests
// guard the invariants every surface relies on — unique names, a valid scope +
// kind on every entry, every built-in being a local action, and the shared
// filter advertising exactly the non-terminal-only commands.

import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  sharedBuiltinCommands,
  type BuiltinCommand,
} from "../src/builtinCommands.js";

describe("built-in command catalog", () => {
  it("has a unique name for every command", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every command declares a valid scope and kind", () => {
    for (const c of BUILTIN_COMMANDS) {
      expect(["shared", "tui-only"]).toContain(c.scope);
      expect(["local", "prompt"]).toContain(c.kind);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it("every built-in is a local client action (never a prompt turn)", () => {
    expect(BUILTIN_COMMANDS.every((c) => c.kind === "local")).toBe(true);
  });

  it("sharedBuiltinCommands advertises exactly the non-terminal-only set", () => {
    const shared = sharedBuiltinCommands();
    expect(shared.every((c) => c.scope === "shared")).toBe(true);
    const sharedNames = new Set(shared.map((c) => c.name));
    // Terminal-only affordances are never advertised to GUI surfaces.
    for (const terminalOnly of ["exit", "connect", "remote", "setup", "theme", "web"]) {
      expect(sharedNames.has(terminalOnly)).toBe(false);
    }
    // Core cross-surface commands are advertised.
    for (const shared of ["help", "model", "mode", "compact", "clear", "plan"]) {
      expect(sharedNames.has(shared)).toBe(true);
    }
  });

  it("lists help first so clients can anchor it", () => {
    expect(BUILTIN_COMMANDS[0]!.name).toBe("help");
  });

  it("the catalog shape is readonly-friendly (plain data, no methods)", () => {
    const sample: BuiltinCommand = BUILTIN_COMMANDS[0]!;
    expect(Object.keys(sample).sort()).toEqual(["description", "kind", "name", "scope"]);
  });
});
