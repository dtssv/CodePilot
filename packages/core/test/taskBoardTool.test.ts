// Tests for the task_board tool: action dispatch, ownership stamped from the
// caller's session id, read vs write actions, and fail-soft when no project
// state dir is available.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { taskBoardTool } from "../src/tools/task_board.js";
import type { ToolContext } from "../src/tools/types.js";

function ctx(dir: string | undefined, sessionId: string): ToolContext {
  return {
    cwd: dir ?? "/tmp",
    sessionId,
    projectStateDir: dir,
    artifact: async () => "art",
    readArtifact: async () => "",
  } as ToolContext;
}

describe("taskBoardTool", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tbtool-"));
  });

  async function create(sessionId: string, title: string): Promise<string> {
    const r = await taskBoardTool.execute({ action: "create", title }, ctx(dir, sessionId));
    const m = r.content.match(/task_[a-f0-9]+/);
    return m![0];
  }

  it("creates and lists tasks", async () => {
    await create("s1", "first");
    const list = await taskBoardTool.execute({ action: "list" }, ctx(dir, "s1"));
    expect(list.content).toContain("first");
    expect(list.isError).toBeFalsy();
  });

  it("stamps ownership from the session id and blocks another session", async () => {
    const id = await create("s1", "shared");
    const claim = await taskBoardTool.execute({ action: "claim", id }, ctx(dir, "s1"));
    expect(claim.isError).toBeFalsy();

    const steal = await taskBoardTool.execute({ action: "claim", id }, ctx(dir, "s2"));
    expect(steal.isError).toBe(true);
    expect(steal.content).toContain("already claimed by s1");

    const theft = await taskBoardTool.execute(
      { action: "complete", id },
      ctx(dir, "s2"),
    );
    expect(theft.isError).toBe(true);
  });

  it("completes a task the caller owns", async () => {
    const id = await create("s1", "x");
    await taskBoardTool.execute({ action: "claim", id }, ctx(dir, "s1"));
    const done = await taskBoardTool.execute(
      { action: "complete", id, result: "ok" },
      ctx(dir, "s1"),
    );
    expect(done.isError).toBeFalsy();
    const got = await taskBoardTool.execute({ action: "get", id }, ctx(dir, "s1"));
    expect(got.content).toContain("[done]");
    expect(got.content).toContain("result: ok");
  });

  it("validates required args per action", async () => {
    expect((await taskBoardTool.execute({ action: "get" }, ctx(dir, "s1"))).isError).toBe(true);
    expect((await taskBoardTool.execute({ action: "create" }, ctx(dir, "s1"))).isError).toBe(true);
    expect((await taskBoardTool.execute({ action: "claim" }, ctx(dir, "s1"))).isError).toBe(true);
    expect(
      (await taskBoardTool.execute({ action: "update", id: "x" }, ctx(dir, "s1"))).isError,
    ).toBe(true);
  });

  it("fails soft when there is no project state dir", async () => {
    const r = await taskBoardTool.execute({ action: "list" }, ctx(undefined, "s1"));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no project state dir");
  });
});
