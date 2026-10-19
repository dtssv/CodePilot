import { describe, expect, it, vi } from "vitest";
import { GitDiffController, type GitDiffResult, type GitDiffState } from "../src/state/gitDiff.js";

function deferred() {
  let resolve!: (value: GitDiffResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<GitDiffResult>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

describe("Git diff controller", () => {
  it("requests both modes and clears old content while loading", async () => {
    const states: Array<GitDiffState | null> = [];
    const fetch = vi.fn(async (_path: string, staged: boolean) => ({ diff: staged ? "+staged" : "+working", truncated: staged }));
    const controller = new GitDiffController(fetch, s => states.push(s));
    await controller.load("a.ts", false);
    await controller.load("a.ts", true);
    expect(fetch.mock.calls).toEqual([["a.ts", false], ["a.ts", true]]);
    expect(states[2]).toMatchObject({ staged: true, loading: true, diff: "" });
    expect(states[3]).toMatchObject({ staged: true, loading: false, diff: "+staged", truncated: true });
  });

  it("ignores an old response after a newer file or mode is selected", async () => {
    const first = deferred(); const second = deferred();
    let state: GitDiffState | null = null;
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const controller = new GitDiffController(fetch, s => { state = s; });
    const a = controller.load("old.ts", false); const b = controller.load("new.ts", true);
    second.resolve({ diff: "new", truncated: false }); await b;
    first.resolve({ diff: "old", truncated: true }); await a;
    expect(state).toMatchObject({ path: "new.ts", staged: true, diff: "new" });
  });

  it("does not reopen a closed view on late completion", async () => {
    const pending = deferred(); const publish = vi.fn();
    const controller = new GitDiffController(() => pending.promise, publish);
    const run = controller.load("deleted.ts", false);
    controller.close();
    pending.resolve({ diff: "-deleted", truncated: false }); await run;
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(null);
  });

  it("displays failures without retaining the previous patch", async () => {
    const pending = deferred(); const publish = vi.fn();
    const controller = new GitDiffController(() => pending.promise, publish);
    const run = controller.load("a.ts", true);
    pending.reject(new Error("Git unavailable")); await run;
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ error: "Git unavailable", diff: "", loading: false }));
  });

  it("invalidates responses when the view is unmounted", async () => {
    const pending = deferred(); const publish = vi.fn();
    const controller = new GitDiffController(() => pending.promise, publish);
    const run = controller.load("a.ts", false); controller.invalidate();
    pending.reject(new Error("late failure")); await run;
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
