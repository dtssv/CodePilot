import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildClassificationInput,
  createPromptPermissionClassifier,
  parseClassification,
} from "../src/permissionClassifier.js";
import { PermissionEngine } from "../src/permissions.js";
import type { ToolDef } from "../src/tools/types.js";

function makeTool(name: string, perm: "read" | "write" | "execute" | "network"): ToolDef {
  return {
    name,
    description: "test",
    inputSchema: z.object({}),
    permission: perm,
    async execute() {
      return { content: "ok" };
    },
  };
}

describe("parseClassification", () => {
  it("parses allow / deny / uncertain", () => {
    expect(parseClassification('{"decision":"allow"}')).toEqual({ decision: "allow" });
    expect(parseClassification('{"decision":"deny","reason":"drops a tree"}')).toEqual({
      decision: "deny",
      reason: "drops a tree",
    });
    expect(parseClassification('{"decision":"uncertain"}')).toEqual({ decision: "uncertain" });
  });

  it("tolerates markdown fences and stray prose", () => {
    expect(parseClassification('Here you go:\n```json\n{"decision":"allow"}\n```')).toEqual({
      decision: "allow",
    });
  });

  it("falls back to uncertain for unparseable / unknown replies", () => {
    expect(parseClassification("not json at all")).toEqual({ decision: "uncertain" });
    expect(parseClassification('{"decision":"maybe"}')).toEqual({ decision: "uncertain" });
    expect(parseClassification("{bad json")).toEqual({ decision: "uncertain" });
  });

  it("supplies a default reason when deny omits one", () => {
    const r = parseClassification('{"decision":"deny"}');
    expect(r.decision).toBe("deny");
    expect((r as { reason: string }).reason).toMatch(/refused/i);
  });
});

describe("createPromptPermissionClassifier", () => {
  it("maps the resolver's JSON to a verdict", async () => {
    const c = createPromptPermissionClassifier(async () => '{"decision":"allow"}');
    const r = await c.classify(
      buildClassificationInput(makeTool("bash", "execute"), "npm test", "/repo"),
    );
    expect(r).toEqual({ decision: "allow" });
  });

  it("fails safe to uncertain when the resolver throws", async () => {
    const c = createPromptPermissionClassifier(async () => {
      throw new Error("judge unreachable");
    });
    const r = await c.classify(
      buildClassificationInput(makeTool("bash", "execute"), "npm test", "/repo"),
    );
    expect(r).toEqual({ decision: "uncertain" });
  });
});

describe("PermissionEngine.askSeverity", () => {
  it("marks dangerous commands and explicit ask rules as hard", () => {
    const e = new PermissionEngine({ permissionMode: "auto" });
    const bash = makeTool("bash", "execute");
    expect(e.askSeverity(bash, { command: "rm -rf /" })).toBe("hard");

    const asked = new PermissionEngine({
      permissionMode: "auto",
      permissions: { ask: ["bash(npm install *)"] },
    });
    expect(asked.askSeverity(bash, { command: "npm install left-pad" })).toBe("hard");
  });

  it("marks sensitive-path writes as hard", () => {
    const e = new PermissionEngine({ permissionMode: "auto" });
    const w = makeTool("write_file", "write");
    expect(e.askSeverity(w, { path: "/etc/hosts" })).toBe("hard");
  });

  it("marks an ordinary unmatched call as soft", () => {
    const e = new PermissionEngine({ permissionMode: "auto" });
    const bash = makeTool("bash", "execute");
    expect(e.askSeverity(bash, { command: "npm install" })).toBe("soft");
    const w = makeTool("write_file", "write");
    expect(e.askSeverity(w, { path: "src/app.ts" })).toBe("soft");
  });
});

describe("PermissionEngine classifier denial tracking", () => {
  it("defers to the human after the consecutive denial cap", () => {
    const e = new PermissionEngine({
      permissionMode: "auto",
      permissionAuto: { maxConsecutiveDenials: 2, maxTotalDenials: 0 },
    });
    expect(e.classifierShouldDefer()).toBe(false);
    e.recordClassifierVerdict(true);
    expect(e.classifierShouldDefer()).toBe(false);
    e.recordClassifierVerdict(true);
    expect(e.classifierShouldDefer()).toBe(true);
    // A non-denial (allow / uncertain / human override) resets the streak.
    e.recordClassifierVerdict(false);
    expect(e.classifierShouldDefer()).toBe(false);
  });

  it("defers after the total denial cap regardless of the streak", () => {
    const e = new PermissionEngine({
      permissionMode: "auto",
      permissionAuto: { maxConsecutiveDenials: 100, maxTotalDenials: 3 },
    });
    for (let i = 0; i < 3; i++) {
      e.recordClassifierVerdict(true);
      e.recordClassifierVerdict(false); // reset streak each time
    }
    expect(e.classifierDenialState().total).toBe(3);
    expect(e.classifierShouldDefer()).toBe(true);
  });
});
