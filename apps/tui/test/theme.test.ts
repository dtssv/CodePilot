import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand, COMMANDS, BUILTIN_COMMAND_NAMES } from "../src/ui/commands.js";
import { color, setTheme, activeTheme } from "../src/ui/theme.js";
import { THEMES, THEME_NAMES, loadThemePref, saveThemePref } from "../src/ui/themes.js";

const ctx = {
  controller: {
    kind: "mock" as const,
    listSessions: async () => [],
    runGoal: async () => ({ status: "blocked" as const, reason: "mock" }),
  },
  cwd: "/tmp",
};

describe("/theme command parsing", () => {
  it("is a registered built-in command", () => {
    expect(COMMANDS.some((c) => c.name === "theme")).toBe(true);
    expect(BUILTIN_COMMAND_NAMES.has("theme")).toBe(true);
  });

  it("opens the picker with no arg", () => {
    expect(runCommand("/theme", ctx)).toEqual({ kind: "pick-theme" });
  });

  it("sets a known palette directly", () => {
    expect(runCommand("/theme nord", ctx)).toEqual({ kind: "set-theme", name: "nord" });
  });

  it("falls back to the picker for an unknown palette", () => {
    expect(runCommand("/theme neon", ctx)).toEqual({ kind: "pick-theme" });
  });
});

describe("setTheme mutates the shared palette in place", () => {
  afterEach(() => {
    setTheme("default"); // restore for other suites sharing the module
  });

  it("keeps the same `color` object reference across switches", () => {
    const ref = color;
    setTheme("nord");
    expect(color).toBe(ref); // same object — components' imports stay valid
    expect(color.accent).toBe(THEMES.nord.accent);
  });

  it("applies every listed palette and tracks the active name", () => {
    for (const name of THEME_NAMES) {
      const applied = setTheme(name);
      expect(applied).toBe(name);
      expect(activeTheme).toBe(name);
      expect(color.accent).toBe(THEMES[name].accent);
      expect(color.remove).toBe(THEMES[name].remove);
    }
  });

  it("ignores an unknown name and keeps the current palette", () => {
    setTheme("solarized");
    const before = { ...color };
    const applied = setTheme("does-not-exist" as never);
    expect(applied).toBe("solarized");
    expect({ ...color }).toEqual(before);
  });
});

describe("theme preference persistence", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cp-theme-"));
    path = join(dir, ".codepilot", "tui-theme");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("saveThemePref writes the name and loadThemePref reads it back", () => {
    saveThemePref("solarized", path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("solarized");
    expect(loadThemePref(path)).toBe("solarized");
  });

  it("loadThemePref returns 'default' when the file is missing or invalid", async () => {
    expect(loadThemePref(path)).toBe("default");
    saveThemePref("nord", path);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "bogus-palette", "utf-8");
    expect(loadThemePref(path)).toBe("default");
  });
});
