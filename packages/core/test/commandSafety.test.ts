import { describe, expect, it } from "vitest";

import { isReadOnlyCommand, parseCommand } from "../src/permissions/commandSafety.js";
import { PermissionEngine } from "../src/permissions/permissions.js";
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

  it.each([
    "(rm -rf x)",
    "{ rm -rf x; }",
    "echo $(rm -rf x)",
    'echo "$(rm -rf x)"',
    "echo `rm -rf x`",
    "diff <(rm -rf x) b",
    "for f in *; do rm $f; done",
    "if true; then rm x; fi",
    "! rm x",
    "sudo rm -rf x",
    "sudo -u root rm x",
    "env FOO=1 rm x",
    "FOO=1 rm x",
    "timeout 5 rm x",
    "nice -n 10 rm x",
    "nohup rm x &",
    "command rm x",
    "xargs -0 rm < list",
    "find . -print0 | xargs -I{} rm {}",
    "bash -c 'rm -rf x'",
    "sh -lc \"cd a && rm x\"",
    "eval 'rm x'",
    "/bin/rm x",
    "\\rm x",
    "'rm' x",
    "ls \\\n && rm x",
    "echo ${X:-$(rm x)}",
    "cat <<EOF\n$(rm x)\nEOF",
    "f() { rm x; }; f",
  ])("deny rule sees through %j", (command) => {
    const e = new PermissionEngine({ permissionMode: "yolo", permissions: { deny: ["bash(rm *)"] } });
    expect(e.preflight(bashTool, { command })).toMatchObject({ decision: "deny" });
  });

  it.each([
    "echo 'rm x'",
    "echo \"rm x\"",
    "echo hi # ; rm x",
    "cat <<'EOF'\n$(rm x)\nEOF",
    "git commit -m 'rm the file'",
    "grep -r 'sudo rm' .",
  ])("deny rule ignores quoted / commented text %j", (command) => {
    const e = new PermissionEngine({ permissionMode: "yolo", permissions: { deny: ["bash(rm *)"] } });
    expect(e.preflight(bashTool, { command })).not.toMatchObject({ decision: "deny" });
  });
});

describe("parseCommand structure", () => {
  it("strips subshells, groups and compound keywords from top-level segments", () => {
    expect(parseCommand("(cd a && ls) | wc -l").segments).toEqual(["cd a", "ls", "wc -l"]);
    expect(parseCommand("for f in *.ts; do wc -l $f; done").segments).toEqual(["wc -l $f"]);
    expect(parseCommand("if test -f a; then cat a; else echo no; fi").segments).toEqual(["test -f a", "cat a", "echo no"]);
  });

  it("joins line continuations and drops comments", () => {
    expect(parseCommand("ls \\\n  -la # list").segments).toEqual(["ls -la"]);
    expect(parseCommand("echo a#b").segments).toEqual(["echo a#b"]);
  });

  it("does not split heredoc bodies into commands", () => {
    const p = parseCommand("cat <<EOF\nhello; rm x\nEOF\necho done");
    expect(p.segments).toEqual(["cat <<EOF", "echo done"]);
    expect(p.opaque).toBe(false);
  });

  it("reads nested substitutions without being fooled by quotes inside them", () => {
    const p = parseCommand(`echo "$(printf "%s" ")")" && ls`);
    expect(p.segments).toEqual([`echo "$(printf "%s" ")")"`, "ls"]);
    expect(p.commands).toContain(`printf %s )`);
    expect(p.opaque).toBe(true);
  });

  it("never throws or stalls on arbitrary input", () => {
    const alphabet = ["a", " ", "\n", "\\", "'", '"', "$", "(", ")", "{", "}", "`", "<", ">", "&", "|", ";", "#", "2", "-", "c", "EOF", "<<", "sh -c "];
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const start = Date.now();
    for (let k = 0; k < 3000; k++) {
      let s = "";
      for (let j = rand(60); j > 0; j--) s += alphabet[rand(alphabet.length)];
      expect(() => parseCommand(s)).not.toThrow();
    }
    expect(() => parseCommand("$(".repeat(500) + ")".repeat(500))).not.toThrow();
    expect(parseCommand("echo x | ".repeat(5000) + "ls").segments).toHaveLength(5001);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("flags unterminated quotes and substitutions as opaque", () => {
    expect(parseCommand("echo 'abc").opaque).toBe(true);
    expect(parseCommand("echo $(ls").opaque).toBe(true);
  });

  it("keeps read-only detection for compound read-only commands", () => {
    expect(isReadOnlyCommand("for f in a b; do cat $f; done")).toBe(true);
    expect(isReadOnlyCommand("(cd packages && ls) 2>/dev/null")).toBe(true);
    expect(isReadOnlyCommand("[[ -f a ]] && cat a")).toBe(true);
    expect(isReadOnlyCommand("cat <<EOF\nx\nEOF")).toBe(true);
    expect(isReadOnlyCommand("for f in $(rm x); do cat $f; done")).toBe(false);
    expect(isReadOnlyCommand("cat <<EOF > out\nx\nEOF")).toBe(false);
  });
});
