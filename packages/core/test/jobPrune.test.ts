import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobsDir, pruneOldJobs } from "../src/tools/bashJobs.js";

describe("pruneOldJobs", () => {
  it("removes finished job files older than retention", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cp-prune-"));
    const dir = jobsDir(cwd);
    mkdirSync(dir, { recursive: true });
    const id = "job_old";
    const metaPath = join(dir, `${id}.json`);
    const logPath = join(dir, `${id}.log`);
    writeFileSync(
      metaPath,
      JSON.stringify({
        id,
        command: "echo",
        cwd,
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(0).toISOString(),
        status: "exited",
        exitCode: 0,
        sandboxed: false,
        sandboxBackend: "none",
      }),
      "utf-8",
    );
    writeFileSync(logPath, "old log\n", "utf-8");
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(metaPath, old, old);
    utimesSync(logPath, old, old);

    const n = await pruneOldJobs(cwd, 7 * 24 * 60 * 60 * 1000, Date.now(), { force: true });
    expect(n).toBe(1);
    expect(existsSync(metaPath)).toBe(false);
    expect(existsSync(logPath)).toBe(false);
  });

  it("keeps recent finished jobs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cp-prune-"));
    const dir = jobsDir(cwd);
    mkdirSync(dir, { recursive: true });
    const id = "job_new";
    const metaPath = join(dir, `${id}.json`);
    writeFileSync(
      metaPath,
      JSON.stringify({
        id,
        command: "echo",
        cwd,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "exited",
        exitCode: 0,
        sandboxed: false,
        sandboxBackend: "none",
      }),
      "utf-8",
    );
    writeFileSync(join(dir, `${id}.log`), "fresh\n", "utf-8");
    const n = await pruneOldJobs(cwd, 7 * 24 * 60 * 60 * 1000, Date.now(), { force: true });
    expect(n).toBe(0);
    expect(existsSync(metaPath)).toBe(true);
  });
});
