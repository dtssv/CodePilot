import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findTrustedFolder, isBroadFolder, isFolderTrusted, trustFolder } from "../src/permissions/folderTrust.js";

let root: string;
let home: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cp-trust-"));
  home = join(root, "home");
  mkdirSync(join(home, "proj", "sub"), { recursive: true });
  mkdirSync(join(home, "other"), { recursive: true });
  file = join(home, ".codepilot", "trusted-folders.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("folder trust", () => {
  it("starts untrusted and persists a trust decision", async () => {
    const opts = { file, home };
    expect(isFolderTrusted(join(home, "proj"), opts)).toBe(false);
    await trustFolder(join(home, "proj"), opts);
    expect(isFolderTrusted(join(home, "proj"), opts)).toBe(true);
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    expect(stored.folders).toHaveLength(1);
    await trustFolder(join(home, "proj"), opts);
    expect(JSON.parse(readFileSync(file, "utf-8")).folders).toHaveLength(1);
  });

  it("covers subfolders but not siblings", async () => {
    const opts = { file, home };
    await trustFolder(join(home, "proj"), opts);
    expect(findTrustedFolder(join(home, "proj", "sub"), opts)?.path).toContain("proj");
    expect(isFolderTrusted(join(home, "other"), opts)).toBe(false);
    expect(isFolderTrusted(join(home, "pro"), opts)).toBe(false);
  });

  it("does not let trusting the home directory cover every project", async () => {
    const opts = { file, home };
    expect(isBroadFolder(home, home)).toBe(true);
    await trustFolder(home, opts);
    expect(isFolderTrusted(home, opts)).toBe(true);
    expect(isFolderTrusted(join(home, "proj"), opts)).toBe(false);
  });

  it("treats a corrupt store as nothing trusted", () => {
    mkdirSync(join(home, ".codepilot"), { recursive: true });
    writeFileSync(file, "{not json");
    expect(isFolderTrusted(join(home, "proj"), { file, home })).toBe(false);
  });
});
