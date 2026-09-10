import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCompletion } from "../src/ui/InputBox.js";
import { COMMANDS } from "../src/ui/commands.js";

const cmds = COMMANDS;

describe("deriveCompletion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dc-"));
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "");
    writeFileSync(join(dir, "src", "app.tsx"), "");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for plain text with no sigil", () => {
    expect(deriveCompletion("hello world", dir, cmds)).toBeNull();
    expect(deriveCompletion("", dir, cmds)).toBeNull();
  });

  it("detects a slash command at the start of input", () => {
    const c = deriveCompletion("/mod", dir, cmds);
    expect(c).not.toBeNull();
    expect(c!.kind).toBe("command");
    expect(c!.token).toBe("/mod");
    expect(c!.start).toBe(0);
    expect(c!.candidates).toContain("model <name>");
  });

  it("detects a slash command after a space", () => {
    const c = deriveCompletion("do something /mo", dir, cmds);
    expect(c).not.toBeNull();
    expect(c!.kind).toBe("command");
    expect(c!.token).toBe("/mo");
    expect(c!.start).toBe(13);
    expect(c!.candidates).toContain("mode <ask|auto-edit|yolo>");
  });

  it("filters command candidates by the typed body", () => {
    const c = deriveCompletion("/he", dir, cmds);
    expect(c!.candidates).toEqual(["help"]);
  });

  it("returns null for a slash that is not at a token boundary", () => {
    // "/foo" preceded by "x" with no space → part of a word, not a command.
    expect(deriveCompletion("x/foo", dir, cmds)).toBeNull();
  });

  it("returns null when commands is undefined", () => {
    expect(deriveCompletion("/mod", dir, undefined)).toBeNull();
  });

  it("detects an @file token at the start of input", () => {
    const c = deriveCompletion("@p", dir, cmds);
    expect(c).not.toBeNull();
    expect(c!.kind).toBe("file");
    expect(c!.token).toBe("@p");
    expect(c!.start).toBe(0);
    expect(c!.candidates).toContain("package.json");
  });

  it("detects an @file token after whitespace", () => {
    const c = deriveCompletion("read @src/ind", dir, cmds);
    expect(c).not.toBeNull();
    expect(c!.kind).toBe("file");
    expect(c!.token).toBe("@src/ind");
    expect(c!.start).toBe(5);
    expect(c!.candidates).toContain("src/index.ts");
  });

  it("returns null for @file when cwd is undefined", () => {
    expect(deriveCompletion("@foo", undefined, cmds)).toBeNull();
  });

  it("offers all commands when only '/' is typed", () => {
    const c = deriveCompletion("/", dir, cmds);
    expect(c).not.toBeNull();
    expect(c!.candidates.length).toBe(cmds.length);
  });
});
