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

  it("round-trips the lanAccess flag and ignores bad types", () => {
    const dir = tmp();
    const file = join(dir, "settings.json");
    saveSettings(file, { lastFolder: "/x", lanAccess: true });
    expect(loadSettings(file)).toEqual({ lastFolder: "/x", lanAccess: true });
    writeFileSync(file, JSON.stringify({ lanAccess: "yes" }));
    expect(loadSettings(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ lastFolder: "/x", lanAccess: false }));
    expect(loadSettings(file)).toEqual({ lastFolder: "/x", lanAccess: false });
  });
});

describe("initialFolder", () => {
  it("prefers a folder argument, then the last folder, else null", () => {
    const a = tmp();
    const b = tmp();
    expect(initialFolder(["--inspect", a], { lastFolder: b }, "/")).toBe(a);
    expect(initialFolder(["/does/not/exist"], { lastFolder: b }, "/")).toBe(b);
    expect(initialFolder([], { lastFolder: "/gone" }, "/")).toBeNull();
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
