import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findWebRoot, initialFolder, loadSettings, saveSettings } from "../src/settings.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cp-desktop-"));

describe("settings", () => {
  it("round-trips and tolerates bad files", () => {
    const dir = tmp();
    const file = join(dir, "nested", "settings.json");
    expect(loadSettings(file)).toEqual({});
    saveSettings(file, { lastFolder: "/x" });
    expect(loadSettings(file)).toEqual({ lastFolder: "/x" });
    writeFileSync(file, "{nope");
    expect(loadSettings(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ lastFolder: 3 }));
    expect(loadSettings(file)).toEqual({});
  });
});

describe("initialFolder", () => {
  it("prefers a folder argument, then the last folder, then home", () => {
    const a = tmp();
    const b = tmp();
    expect(initialFolder(["--inspect", a], { lastFolder: b }, "/home", "/")).toBe(a);
    expect(initialFolder(["/does/not/exist"], { lastFolder: b }, "/home", "/")).toBe(b);
    expect(initialFolder([], { lastFolder: "/gone" }, "/home", "/")).toBe("/home");
  });
});

describe("findWebRoot", () => {
  it("returns the first directory with an index.html", () => {
    const empty = tmp();
    const built = tmp();
    mkdirSync(built, { recursive: true });
    writeFileSync(join(built, "index.html"), "<html></html>");
    expect(findWebRoot([empty, built])).toBe(built);
    expect(findWebRoot([empty])).toBeNull();
  });
});
