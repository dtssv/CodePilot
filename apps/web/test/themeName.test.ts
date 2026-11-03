// Named palette (theme-name) persistence + DOM application. The light/dark
// axis is tested elsewhere; this covers the codex-style named-palette layer.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  THEME_NAMES,
  applyThemeName,
  initialThemeName,
  type ThemeName,
} from "../src/surface.js";

class FakeStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

let local: FakeStorage;
let dataset: Record<string, string>;

beforeEach(() => {
  local = new FakeStorage();
  // A minimal <html> with a dataset the code reads/writes.
  dataset = {};
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("document", { documentElement: { dataset } });
  return () => vi.unstubAllGlobals();
});

describe("named palettes (theme-name)", () => {
  it("lists the four palettes in order, default first", () => {
    expect(THEME_NAMES).toEqual(["default", "nord", "solarized", "high-contrast"]);
  });

  it("defaults to 'default' when nothing is saved", () => {
    expect(initialThemeName()).toBe("default");
  });

  it("applies a named palette via data-theme-name and persists it", () => {
    applyThemeName("nord", true);
    expect(dataset.themeName).toBe("nord");
    expect(local.getItem("codepilot.themeName")).toBe("nord");
    expect(initialThemeName()).toBe("nord");
  });

  it("'default' clears the attribute so the base tokens apply", () => {
    applyThemeName("nord", true);
    expect(dataset.themeName).toBe("nord");
    applyThemeName("default", true);
    expect(dataset.themeName).toBeUndefined();
    expect(local.getItem("codepilot.themeName")).toBe("default");
  });

  it("does not persist when persist is false", () => {
    applyThemeName("solarized");
    expect(dataset.themeName).toBe("solarized");
    expect(local.getItem("codepilot.themeName")).toBeNull();
  });

  it("falls back to 'default' for an unknown saved value", () => {
    local.setItem("codepilot.themeName", "neon-dreams");
    expect(initialThemeName()).toBe("default");
  });

  it("round-trips every listed palette", () => {
    for (const name of THEME_NAMES as readonly ThemeName[]) {
      applyThemeName(name, true);
      expect(initialThemeName()).toBe(name);
    }
  });
});
