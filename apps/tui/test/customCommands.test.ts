import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@codepilot/core";
import {
  runCommandWithCustom,
  buildCommandList,
  BUILTIN_COMMAND_NAMES,
  COMMANDS,
} from "../src/ui/commands.js";

function makeCmd(over: Partial<SlashCommand> = {}): SlashCommand {
  return {
    name: "review",
    description: "Review a PR.",
    argumentHint: "<pr>",
    path: "/x/review.md",
    source: "project",
    body: "Review PR $1",
    ...over,
  };
}

const ctx = { controller: { kind: "mock" as const, listSessions: async () => [], runGoal: async () => ({ status: "blocked" as const, reason: "mock" }) }, cwd: "/tmp" };

describe("runCommandWithCustom", () => {
  it("built-in commands still resolve through runCommand", () => {
    const r = runCommandWithCustom("/help", ctx, []);
    expect(r.kind).toBe("system");
  });

  it("built-in /model wins over a custom /model", () => {
    const custom = [makeCmd({ name: "model", body: "shadow" })];
    const r = runCommandWithCustom("/model gpt-5", ctx, custom);
    expect(r.kind).toBe("set-model");
    if (r.kind === "set-model") expect(r.model).toBe("gpt-5");
  });

  it("resolves a custom command with args", () => {
    const custom = [makeCmd()];
    const r = runCommandWithCustom("/review 1234", ctx, custom);
    expect(r.kind).toBe("custom-command");
    if (r.kind === "custom-command") {
      expect(r.prompt).toBe("Review PR 1234");
      expect(r.commandName).toBe("review");
    }
  });

  it("passes through model + allowedTools overrides", () => {
    const custom = [
      makeCmd({
        body: "Review $ARGUMENTS",
        model: "opus",
        allowedTools: ["bash", "read_file"],
      }),
    ];
    const r = runCommandWithCustom("/review 5", ctx, custom);
    if (r.kind === "custom-command") {
      expect(r.model).toBe("opus");
      expect(r.allowedTools).toEqual(["bash", "read_file"]);
    }
  });

  it("returns a usage hint when a command with argument-hint is called without args", () => {
    const custom = [makeCmd()]; // argumentHint: "<pr>"
    const r = runCommandWithCustom("/review", ctx, custom);
    expect(r.kind).toBe("system");
    if (r.kind === "system") expect(r.text).toContain("Usage: /review <pr>");
  });

  it("returns a system 'unknown command' message for an unmatched slash input", () => {
    const r = runCommandWithCustom("/nope", ctx, []);
    expect(r.kind).toBe("system");
    if (r.kind === "system") expect(r.text).toContain("Unknown command");
  });

  it("returns unknown-command when no custom commands match", () => {
    const r = runCommandWithCustom("/nope", ctx, [makeCmd()]);
    expect(r.kind).toBe("system");
    if (r.kind === "system") expect(r.text).toContain("Unknown command");
  });

  it("non-slash input submits as a prompt", () => {
    const r = runCommandWithCustom("hello world", ctx, []);
    expect(r.kind).toBe("submit-prompt");
    if (r.kind === "submit-prompt") expect(r.text).toBe("hello world");
  });
});

describe("buildCommandList", () => {
  it("returns built-ins when no custom commands", () => {
    const list = buildCommandList([]);
    expect(list.length).toBe(COMMANDS.length);
    expect(list[0]!.name).toBe("help");
  });

  it("appends custom commands after built-ins", () => {
    const custom = [makeCmd(), makeCmd({ name: "deploy", description: "Deploy." })];
    const list = buildCommandList(custom);
    expect(list.length).toBe(COMMANDS.length + 2);
    const names = list.map((c) => c.name);
    expect(names).toContain("review");
    expect(names).toContain("deploy");
  });

  it("custom command info includes description + argument hint", () => {
    const list = buildCommandList([makeCmd()]);
    const review = list.find((c) => c.name === "review")!;
    expect(review.description).toBe("Review a PR.");
    expect(review.args).toBe("<pr>");
  });

  it("custom command with no description shows placeholder", () => {
    const list = buildCommandList([makeCmd({ description: "" })]);
    const review = list.find((c) => c.name === "review")!;
    expect(review.description).toBe("(custom command)");
  });
});

describe("BUILTIN_COMMAND_NAMES", () => {
  it("contains the core built-in names", () => {
    expect(BUILTIN_COMMAND_NAMES.has("help")).toBe(true);
    expect(BUILTIN_COMMAND_NAMES.has("model")).toBe(true);
    expect(BUILTIN_COMMAND_NAMES.has("mode")).toBe(true);
    expect(BUILTIN_COMMAND_NAMES.has("agent")).toBe(true);
    expect(BUILTIN_COMMAND_NAMES.has("exit")).toBe(true);
  });

  it("does not contain arbitrary names", () => {
    expect(BUILTIN_COMMAND_NAMES.has("review")).toBe(false);
    expect(BUILTIN_COMMAND_NAMES.has("deploy")).toBe(false);
  });
});
