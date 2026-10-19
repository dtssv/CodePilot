import { describe, expect, it } from "vitest";

import { isReadOnlyCommand, parseCommand } from "../src/commandSafety.js";
import { PermissionEngine } from "../src/permissions.js";
import { bashTool } from "../src/tools/bash.js";

describe("parseCommand", () => {
  it("splits chains and pipes outside quotes", () => {
    expect(parseCommand(`cat a && echo "x && y" | wc -l; ls`).segments).toEqual([
      "cat a",
      `echo "x && y"`,
      "wc -l",
      "ls",
    ]);
  });

  it("flags substitutions and file-writing redirections", () => {
    expect(parseCommand("echo $(rm -rf x)").opaque).toBe(true);
    expect(parseCommand("echo `id`").opaque).toBe(true);
    expect(parseCommand("cat a > b").opaque).toBe(true);
    expect(parseCommand("echo '$(literal)'").opaque).toBe(false);
    expect(parseCommand("rg foo 2>/dev/null").opaque).toBe(false);
    expect(parseCommand("make 2>&1 | tail").opaque).toBe(false);
  });
});

describe("isReadOnlyCommand", () => {
  it.each([
    "ls -la packages",
    "cat package.json && echo ---README--- && head -60 README.md",
    "rg -n foo src | head -20",
    "git status && git diff HEAD -- src && git log --oneline -5",
    "find . -name '*.ts' -not -path './node_modules/*'",
    "sed -n '1,80p' src/a.ts",
    "cd packages/core && ls",
  ])("allows %s", (cmd) => expect(isReadOnlyCommand(cmd)).toBe(true));

  it.each([
    "rm -rf build",
    "cat a && rm b",
    "find . -name x -delete",
    "find . -exec rm {} ;",
    "sed -i 's/a/b/' f",
    "git push",
    "git branch -D main",
    "sort -o out.txt in.txt",
    "echo hi > file",
    "PATH=/tmp ls",
    "ls $(rm x)",
    "npm test",
  ])("rejects %s", (cmd) => expect(isReadOnlyCommand(cmd)).toBe(false));
});

describe("bash permission rules are applied per chained command", () => {
  it("runs read-only commands without asking, in every mode", () => {
    const e = new PermissionEngine({ permissionMode: "ask" });
    expect(e.preflight(bashTool, { command: "git status && ls" })).toMatchObject({ decision: "allow" });
  });

  it("does not let a prefix rule vouch for a chained command", () => {
    const e = new PermissionEngine({ permissionMode: "auto-edit", autoApprove: ["bash(cat *)", "bash(true *)"] });
    expect(e.preflight(bashTool, { command: "cat a && npm publish" })).toBe("ask");
    expect(e.preflight(bashTool, { command: "true && rm -rf /" })).toBe("ask");
    expect(e.preflight(bashTool, { command: "cat a > b" })).toBe("ask");
    expect(e.preflight(bashTool, { command: "cat a | wc -l" })).toMatchObject({ decision: "allow" });
  });

  it("honours each chained command's own rule", () => {
    const e = new PermissionEngine({ permissionMode: "auto-edit", autoApprove: ["bash(npm test *)"] });
    expect(e.preflight(bashTool, { command: "cd packages/core && npm test -- --run" })).toMatchObject({
      decision: "allow",
    });
  });

  it("applies deny rules to any chained command", () => {
    const e = new PermissionEngine({ permissionMode: "yolo", permissions: { deny: ["bash(rm *)"] } });
    expect(e.preflight(bashTool, { command: "true && rm x" })).toMatchObject({ decision: "deny" });
  });
});
