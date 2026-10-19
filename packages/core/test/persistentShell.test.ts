import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { PersistentShell } from "../src/persistentShell.js";

describe("PersistentShell", () => {
  let shell: PersistentShell | null = null;
  afterEach(() => {
    shell?.close();
    shell = null;
  });

  it("runs parallel run() calls one at a time and resolves every one", async () => {
    shell = new PersistentShell({ cwd: tmpdir(), shell: "/bin/sh", shellArgs: [] });
    const results = await Promise.all([
      shell.run("echo one", { timeout: 5_000 }),
      shell.run("echo two", { timeout: 5_000 }),
      shell.run("echo three", { timeout: 5_000 }),
    ]);
    expect(results.map((r) => r.stdout.trim())).toEqual(["one", "two", "three"]);
    expect(results.every((r) => r.exitCode === 0)).toBe(true);
  }, 20_000);

 // zsh -i is what users get from $SHELL on macOS; it prints continuation
 // prompts for multi-line input unless the command is parsed in one go.
  const zsh = "/bin/zsh";
  it.each([
    ["sh", "/bin/sh", [] as string[]],
    ["zsh -i", zsh, ["-i"]],
  ])("runs a multi-line quoted command as one unit (%s)", async (_n, sh, args) => {
    shell = new PersistentShell({ cwd: tmpdir(), shell: sh, shellArgs: args });
    const r = await shell.run('python3 -c "\nx = 1\nprint(\'v\', x + 1)\n"', { timeout: 10_000 });
    expect(r.stdout.trim()).toBe("v 2");
    expect(r.exitCode).toBe(0);
    const cd = await shell.run("cd / && export CP_T=ok", { timeout: 5_000 });
    expect(cd.exitCode).toBe(0);
    expect((await shell.run("pwd; echo $CP_T", { timeout: 5_000 })).stdout.trim()).toBe("/\nok");
  }, 30_000);

  it("reports an unclosed quote as an error instead of hanging", async () => {
    shell = new PersistentShell({ cwd: tmpdir(), shell: zsh, shellArgs: ["-i"] });
    const r = await shell.run('echo "unclosed', { timeout: 10_000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect((await shell.run("echo still-alive", { timeout: 5_000 })).stdout.trim()).toBe("still-alive");
  }, 30_000);
});
