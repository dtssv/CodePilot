// Tests for the shared sub-agent task board: event-sourced fold, single-owner
// claim contention, owner-gated complete/update, and fail-soft reads. The
// board is a plain JSONL file under a temp project-state dir.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TaskBoard, foldTasks, type TaskBoardEntry } from "../src/taskBoard.js";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "taskboard-"));
}

describe("foldTasks", () => {
  it("folds create → claim → complete into a done task", () => {
    const entries: TaskBoardEntry[] = [
      { kind: "create", id: "t1", title: "A", at: 1 },
      { kind: "claim", id: "t1", owner: "s1", at: 2 },
      { kind: "complete", id: "t1", owner: "s1", result: "ok", at: 3 },
    ];
    const t = foldTasks(entries).get("t1")!;
    expect(t.status).toBe("done");
    expect(t.owner).toBe("s1");
    expect(t.result).toBe("ok");
  });

  it("drops a claim on an already-claimed task (replay stays consistent)", () => {
    const entries: TaskBoardEntry[] = [
      { kind: "create", id: "t1", title: "A", at: 1 },
      { kind: "claim", id: "t1", owner: "s1", at: 2 },
      { kind: "claim", id: "t1", owner: "s2", at: 3 },
    ];
    const t = foldTasks(entries).get("t1")!;
    expect(t.owner).toBe("s1");
  });

  it("ignores complete/update from a non-owner", () => {
    const entries: TaskBoardEntry[] = [
      { kind: "create", id: "t1", title: "A", at: 1 },
      { kind: "claim", id: "t1", owner: "s1", at: 2 },
      { kind: "complete", id: "t1", owner: "s2", at: 3 },
      { kind: "update", id: "t1", owner: "s2", note: "x", at: 4 },
    ];
    const t = foldTasks(entries).get("t1")!;
    expect(t.status).toBe("claimed");
    expect(t.notes).toEqual([]);
  });

  it("drops actions on an unknown task", () => {
    const entries: TaskBoardEntry[] = [{ kind: "claim", id: "ghost", owner: "s1", at: 1 }];
    expect(foldTasks(entries).size).toBe(0);
  });
});

describe("TaskBoard", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshDir();
  });

  it("creates, claims, completes, and lists a task", async () => {
    const board = new TaskBoard(dir);
    const created = await board.create("do the thing", "with detail");
    expect(created.ok).toBe(true);
    const id = created.task!.id;

    const claim = await board.claim(id, "s1");
    expect(claim.ok).toBe(true);
    expect(claim.task!.status).toBe("claimed");

    const done = await board.complete(id, "s1", "finished");
    expect(done.ok).toBe(true);
    expect(done.task!.status).toBe("done");
    expect(done.task!.result).toBe("finished");

    const all = await board.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("do the thing");
  });

  it("rejects a second claimant (single owner)", async () => {
    const board = new TaskBoard(dir);
    const id = (await board.create("shared")).task!.id;
    expect((await board.claim(id, "s1")).ok).toBe(true);
    const second = await board.claim(id, "s2");
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("already claimed by s1");
  });

  it("rejects complete/update from a non-owner", async () => {
    const board = new TaskBoard(dir);
    const id = (await board.create("x")).task!.id;
    await board.claim(id, "s1");
    expect((await board.complete(id, "s2")).ok).toBe(false);
    expect((await board.update(id, "s2", "note")).ok).toBe(false);
    // The real owner still can.
    expect((await board.update(id, "s1", "note")).ok).toBe(true);
    expect((await board.get(id))!.notes).toEqual(["note"]);
  });

  it("rejects claiming an unknown task", async () => {
    const board = new TaskBoard(dir);
    const r = await board.claim("nope", "s1");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unknown task");
  });

  it("returns an empty board for a missing file", async () => {
    const board = new TaskBoard(dir);
    expect(await board.list()).toEqual([]);
    expect(await board.get("anything")).toBeNull();
  });

  it("skips corrupt lines but keeps valid ones (fail-soft read)", async () => {
    const board = new TaskBoard(dir);
    const id = (await board.create("valid")).task!.id;
    const file = join(dir, "taskboard.jsonl");
    const raw = await readFile(file, "utf-8");
    await writeFile(file, raw + "{ not json\n" + "\n", "utf-8");
    const all = await board.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(id);
  });

  it("persists across board instances (replay from disk)", async () => {
    const id = (await new TaskBoard(dir).create("persisted")).task!.id;
    await new TaskBoard(dir).claim(id, "s1");
    const reloaded = await new TaskBoard(dir).get(id);
    expect(reloaded!.status).toBe("claimed");
    expect(reloaded!.owner).toBe("s1");
  });
});
