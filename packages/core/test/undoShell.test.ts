// /undo must also revert workspace changes made through bash (sed -i, rm, codegen),
// not only the file tools: the shadow-git tracker snapshots the tree per turn.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/session/session.js";
import { WorkspaceTracker } from "../src/workspace/workspaceTracker.js";
import { projectStatePath } from "../src/workspace/projectState.js";
import type { Event } from "../src/types.js";

const tempHome = process.env.HOME ?? tmpdir();

/** First request: one `tool` call with `args`; then a plain reply. */
function fakeModel(command: string, tool = "bash", args: object = { command }): Promise<{ server: Server; url: string }> {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (calls === 1) {
        const toolCall = {
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_sh1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }],
        };
        res.end(chunk(toolCall, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
      } else {
        res.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
      }
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      done({ server, url: `http://127.0.0.1:${port}/v1` });
    }),
  );
}

describe("undo covers bash-made workspace changes", () => {
  let model: Server;
  let url: string;
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tempHome, "undo-shell-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workDir, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(workDir, ".gitignore"), "build/\n");
    writeFileSync(join(workDir, "a.txt"), "original\n");
    writeFileSync(join(workDir, "c.txt"), "to be deleted\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    ({ server: model, url } = await fakeModel(
      "printf 'changed\\n' > a.txt && printf 'new\\n' > b.txt && rm c.txt && mkdir -p build && printf 'out\\n' > build/out.txt",
    ));
  });
  afterAll(() => {
    model.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("reverts modified, created and deleted files, then redo re-applies them", async () => {
    const session = await createSession({
      cwd: workDir,
      model: "fake",
      config: {
        sandbox: { mode: "off" },
        permissionMode: "yolo",
        providers: { fake: { provider: "openai", baseURL: url, apiKey: "x", model: "fake", models: ["fake"] } },
      } as never,
    });
    await session.prompt("rework the files");
    const p = (f: string) => join(workDir, f);
    expect(readFileSync(p("a.txt"), "utf-8")).toBe("changed\n");
    expect(existsSync(p("c.txt"))).toBe(false);
    expect(session.undoDepth()).toBe(1);

    const undone = await session.undo();
    expect(readFileSync(p("a.txt"), "utf-8")).toBe("original\n");
    expect(existsSync(p("b.txt"))).toBe(false);
    expect(readFileSync(p("c.txt"), "utf-8")).toBe("to be deleted\n");
    expect(undone.restored).toEqual(expect.arrayContaining(["a.txt", "c.txt"]));
    expect(undone.deleted).toContain("b.txt");
    // Gitignored output is outside the tracker's scope and left alone.
    expect(existsSync(p("build/out.txt"))).toBe(true);

    const notice = [...session.getEvents()]
      .reverse()
      .find((e): e is Extract<Event, { type: "message" }> => e.type === "message" && e.role === "user");
    const text = notice?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    expect(text).toContain("made by shell/MCP commands in that turn were reverted");

    await session.redo();
    expect(readFileSync(p("a.txt"), "utf-8")).toBe("changed\n");
    expect(readFileSync(p("b.txt"), "utf-8")).toBe("new\n");
    expect(existsSync(p("c.txt"))).toBe(false);

    // The user's own repository is untouched by the shadow snapshots.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: workDir, encoding: "utf-8" });
    expect(status).toContain(" M a.txt");
    expect(execFileSync("git", ["stash", "list"], { cwd: workDir, encoding: "utf-8" })).toBe("");
  }, 30_000);

  it("runs no git at all for a turn that only reads", async () => {
    const dir = mkdtempSync(join(tempHome, "undo-readonly-"));
    const { server, url: readUrl } = await fakeModel("", "read_file", { path: "a.txt" });
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "x\n");
      const session = await createSession({
        cwd: dir,
        model: "fake",
        config: {
          sandbox: { mode: "off" },
          permissionMode: "yolo",
          providers: { fake: { provider: "openai", baseURL: readUrl, apiKey: "x", model: "fake", models: ["fake"] } },
        } as never,
      });
      await session.prompt("look at a.txt");
      expect(session.undoDepth()).toBe(0);
      expect(existsSync(projectStatePath(dir, "shadow-git"))).toBe(false);
      expect(await session.listSnapshots()).toEqual([]);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("WorkspaceTracker", () => {
  it("scopes to a symlinked subdirectory cwd and honours the root .gitignore", async () => {
    const real = mkdtempSync(join(tempHome, "tracker-"));
    const link = `${real}-link`;
    try {
      execFileSync("git", ["init", "-q"], { cwd: real });
      writeFileSync(join(real, ".gitignore"), "*.log\n");
      mkdirSync(join(real, "pkg"));
      writeFileSync(join(real, "pkg", "x.ts"), "x1\n");
      writeFileSync(join(real, "outside.ts"), "o1\n");
      symlinkSync(real, link);
      const cwd = join(link, "pkg");

      const t = (await WorkspaceTracker.open(cwd, "s/1"))!;
      expect(t).not.toBeNull();
      const before = (await t.capture())!;
      writeFileSync(join(cwd, "x.ts"), "x2\n");
      writeFileSync(join(cwd, "y.ts"), "y\n");
      writeFileSync(join(cwd, "debug.log"), "ignored\n");
      writeFileSync(join(real, "outside.ts"), "o2\n");
      const after = (await t.capture())!;

      const back = await t.changes(after, before);
      expect(back).toEqual(
        expect.arrayContaining([{ path: "x.ts", inTarget: true }, { path: "y.ts", inTarget: false }]),
      );
      expect(back).toHaveLength(2);

      await t.restore(before, back);
      expect(readFileSync(join(cwd, "x.ts"), "utf-8")).toBe("x1\n");
      expect(existsSync(join(cwd, "y.ts"))).toBe(false);
      expect(existsSync(join(cwd, "debug.log"))).toBe(true);
      expect(readFileSync(join(real, "outside.ts"), "utf-8")).toBe("o2\n");
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("keeps pinned trees through gc and lets unpinned ones go", async () => {
    const dir = mkdtempSync(join(tempHome, "tracker-pin-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "f.txt"), "v1\n");
      const t = (await WorkspaceTracker.open(dir, "pin-session"))!;
      const v1 = (await t.capture())!;
      writeFileSync(join(dir, "f.txt"), "v2\n");
      const v2 = (await t.capture())!;
      writeFileSync(join(dir, "f.txt"), "v3\n");
      const v3 = (await t.capture())!;
      await t.pin([v1, v3]);

      const shadow = { ...process.env, GIT_DIR: projectStatePath(dir, "shadow-git") };
      // open() starts a background gc on this same GIT_DIR, and git refuses a
      // second concurrent one, so wait for that gc to release gc.pid.
      const gcNow = () => {
        const deadline = Date.now() + 20_000;
        for (;;) {
          try {
            execFileSync("git", ["gc", "--quiet", "--prune=now"], { cwd: dir, env: shadow, stdio: ["ignore", "ignore", "pipe"] });
            return;
          } catch (err) {
            const stderr = String((err as { stderr?: Buffer }).stderr ?? "");
            if (!/gc is already running/.test(stderr) || Date.now() > deadline) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          }
        }
      };
      gcNow();
      const exists = (sha: string) => {
        try {
          execFileSync("git", ["cat-file", "-e", sha], { cwd: dir, env: shadow, stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      };
      expect(exists(v1)).toBe(true);
      expect(exists(v3)).toBe(true);
      expect(exists(v2)).toBe(false);

      await t.restore(v1, await t.changes(v3, v1));
      expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("v1\n");

      // Re-pinning drops refs that are no longer wanted.
      await t.pin([v1]);
      const refs = execFileSync("git", ["for-each-ref", "--format=%(objectname)", "refs/codepilot/"], {
        cwd: dir,
        env: shadow,
        encoding: "utf-8",
      });
      expect(refs.trim()).toBe(v1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is unavailable outside a git work tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      expect(await WorkspaceTracker.open(dir, "s")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
