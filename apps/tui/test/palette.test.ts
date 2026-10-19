import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterCommands,
  fuzzyScore,
  commonPrefix,
  tabCompleteCommand,
} from "../src/ui/palette.js";
import {
  loadHistory,
  appendHistory,
  compactHistory,
  searchHistory,
  type HistoryEntry,
} from "../src/ui/history.js";
import { COMMANDS } from "../src/ui/commands.js";

const cmds = COMMANDS;

describe("command palette fuzzy matching", () => {
  it("ranks exact name matches first", () => {
    const out = filterCommands(cmds, "model");
    expect(out[0]!.name).toBe("model");
  });

  it("ranks prefix hits above substring hits", () => {
    const out = filterCommands(cmds, "mo");
    expect(["model", "mode"]).toContain(out[0]!.name); // both are prefix hits
    expect(out.map((c) => c.name)).toContain("mode");
    expect(out.map((c) => c.name)).toContain("model");
  });

  it("matches subsequences", () => {
 // "ssn" is a subsequence of "sessions".
    expect(fuzzyScore({ name: "sessions", description: "List saved sessions" }, "ssn")).not.toBeNull();
    const out = filterCommands(cmds, "ssn");
    expect(out.map((c) => c.name)).toContain("sessions");
  });

  it("matches on description words", () => {
    const out = filterCommands(cmds, "permission");
    expect(out.map((c) => c.name)).toContain("mode");
  });

  it("lists everything for an empty query", () => {
    expect(filterCommands(cmds, "", 100)).toHaveLength(cmds.length);
  });

  it("returns nothing for a query that matches no command", () => {
    expect(filterCommands(cmds, "zzzzzzzz")).toHaveLength(0);
  });
});

describe("tabCompleteCommand", () => {
  it("completes /conn to /connect", () => {
    const r = tabCompleteCommand(cmds, "conn", 0);
    expect(r).toEqual({
      nextInput: "/connect",
      nextSelected: 0,
      closePalette: true,
    });
  });

  it("completes /hel to /help", () => {
    const r = tabCompleteCommand(cmds, "hel", 0);
    expect(r?.nextInput).toBe("/help");
    expect(r?.closePalette).toBe(true);
  });

  it("extends shared prefix when several commands match", () => {
 // "m" matches model, mode, mcp — common prefix is "m" already, so
 // Tab completes the selected (top-ranked) name instead.
    const atM = tabCompleteCommand(cmds, "m", 0);
    expect(atM?.nextInput.startsWith("/")).toBe(true);
    expect(["model", "mode", "mcp"]).toContain(atM!.nextInput.slice(1));

 // Craft two names that share a longer prefix than the query.
    const tiny = [
      { name: "mode", description: "permission" },
      { name: "model", description: "pick model" },
    ];
    const r = tabCompleteCommand(tiny, "mo", 0);
 // common prefix of mode/model is "mode" — wait, "mode" vs "model" → "mode"
 // so shared is "mode" which is longer than "mo".
    expect(r?.nextInput).toBe("/mode");
    expect(r?.closePalette).toBe(false);
  });

  it("cycles to the next match when query is already a full name", () => {
    const tiny = [
      { name: "mode", description: "permission" },
      { name: "model", description: "pick model" },
    ];
 // After completing to /mode, query is "mode" — next Tab → /model.
    const r = tabCompleteCommand(tiny, "mode", 0);
    expect(r?.nextInput).toBe("/model");
    expect(r?.nextSelected).toBe(1);
    expect(r?.closePalette).toBe(false);
  });

  it("returns null when nothing matches", () => {
    expect(tabCompleteCommand(cmds, "zzzzzzzz", 0)).toBeNull();
  });
});

describe("commonPrefix", () => {
  it("finds the shared prefix", () => {
    expect(commonPrefix(["connect", "context"])).toBe("con");
    expect(commonPrefix(["mode", "model"])).toBe("mode");
    expect(commonPrefix(["help"])).toBe("help");
    expect(commonPrefix([])).toBe("");
  });
});

describe("persistent prompt history", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hist-"));
    mkdirSync(join(dir, ".codepilot"));
    path = join(dir, ".codepilot", "tui-history.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends and reloads newest-first", () => {
    appendHistory({ text: "first", cwd: dir, at: 1 }, path);
    appendHistory({ text: "second", cwd: dir, at: 2 }, path);
    const loaded = loadHistory(path);
    expect(loaded.map((e) => e.text)).toEqual(["second", "first"]);
  });

  it("skips corrupt lines on load", () => {
    writeFileSync(path, '{"text":"ok","cwd":"x","at":1}\nNOT JSON\n{"text":"ok2","cwd":"x","at":2}\n');
    expect(loadHistory(path).map((e) => e.text)).toEqual(["ok2", "ok"]);
  });

  it("load of a missing file yields empty history", () => {
    expect(loadHistory(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("compact rewrites the file atomically and keeps entries", () => {
    appendHistory({ text: "a", cwd: dir, at: 1 }, path);
    appendHistory({ text: "b", cwd: dir, at: 2 }, path);
    compactHistory(path);
    expect(loadHistory(path).map((e) => e.text)).toEqual(["b", "a"]);
  });
});

describe("history reverse search", () => {
 // newest-first ordering
  const entries: HistoryEntry[] = [
    { text: "fix the login bug", cwd: "", at: 3 },
    { text: "run the tests", cwd: "", at: 2 },
    { text: "fix lint errors", cwd: "", at: 1 },
  ];

  it("returns entries in their given (newest-first) order for an empty query", () => {
    expect(searchHistory(entries, "").map((e) => e.text)).toEqual([
      "fix the login bug",
      "run the tests",
      "fix lint errors",
    ]);
  });

  it("ranks prefix matches before subsequence-only matches", () => {
    const out = searchHistory(entries, "fix");
    expect(out.map((e) => e.text)).toContain("fix the login bug");
    expect(out.map((e) => e.text)).toContain("fix lint errors");
    expect(out[0]!.text.startsWith("fix")).toBe(true);
  });

  it("matches subsequences", () => {
    const out = searchHistory(entries, "rnt");
    expect(out.map((e) => e.text)).toContain("run the tests");
  });

  it("returns nothing when nothing matches", () => {
    expect(searchHistory(entries, "qqqqq")).toHaveLength(0);
  });
});
