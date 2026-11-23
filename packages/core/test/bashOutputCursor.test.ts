import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeJobLog,
  readJobLog,
  readJobLogFrom,
  setJobLogCursor,
  getJobLogCursor,
  jobsDir,
} from "../src/tools/bashJobs.js";
import { bashOutputTool } from "../src/tools/bash_output.js";
import type { ToolContext } from "../src/tools/types.js";

function seedJobLog(cwd: string, id: string, body: string): void {
  const dir = jobsDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.log`), body, "utf-8");
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      command: "echo",
      cwd,
      startedAt: new Date().toISOString(),
      status: "exited",
      exitCode: 0,
      sandboxed: false,
      sandboxBackend: "none",
    }),
    "utf-8",
  );
}

describe("job log consumption cursor", () => {
  it("readJobLogFrom does not load the whole file when offset is near the end", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cp-job-big-"));
    const id = "job_big";
    // ~1 MiB of filler then a short trailer — incremental read must not OOM-path
    // via a full-file Buffer (regression for hundreds-of-MB build logs).
    const filler = "x".repeat(1024 * 1024);
    const trailer = "TRAILER_LINE\n";
    seedJobLog(cwd, id, filler + trailer);
    const start = Buffer.byteLength(filler);
    const slice = await readJobLogFrom(cwd, id, start, 10_000);
    expect(slice.text).toBe(trailer);
    expect(slice.fromOffset).toBe(start);
    expect(slice.nextOffset).toBe(start + Buffer.byteLength(trailer));
    expect(slice.totalBytes).toBe(start + Buffer.byteLength(trailer));
  });

  it("readJobLogFrom slices by byte offset and reports nextOffset", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cp-job-"));
    const id = "job_cursor1";
    seedJobLog(cwd, id, "alpha\nbeta\ngamma\n");
    const first = await readJobLogFrom(cwd, id, 0, 1000);
    expect(first.text).toBe("alpha\nbeta\ngamma\n");
    expect(first.fromOffset).toBe(0);
    expect(first.nextOffset).toBe(Buffer.byteLength("alpha\nbeta\ngamma\n"));
    const mid = await readJobLogFrom(cwd, id, first.nextOffset);
    expect(mid.text).toBe("(no new output)");
    expect(mid.nextOffset).toBe(first.nextOffset);
  });

  it("consumeJobLog advances the server-side cursor across polls", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cp-job-"));
    const id = "job_cursor2";
    seedJobLog(cwd, id, "one\n");
    setJobLogCursor(cwd, id, 0);
    const a = await consumeJobLog(cwd, id);
    expect(a.text).toBe("one\n");
    expect(getJobLogCursor(cwd, id)).toBe(a.nextOffset);
    writeFileSync(join(jobsDir(cwd), `${id}.log`), "one\ntwo\n", "utf-8");
    const b = await consumeJobLog(cwd, id);
    expect(b.text).toBe("two\n");
    expect(b.fromOffset).toBe(a.nextOffset);
  });

  it("readJobLog tail does not move the cursor", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cp-job-"));
    const id = "job_cursor3";
    seedJobLog(cwd, id, "a\nb\nc");
    setJobLogCursor(cwd, id, 0);
    await consumeJobLog(cwd, id);
    const after = getJobLogCursor(cwd, id);
    const tail = await readJobLog(cwd, id, 2);
    expect(tail).toContain("b\nc");
    expect(getJobLogCursor(cwd, id)).toBe(after);
  });
});

describe("bash_output tool cursor", () => {
  it("default poll is incremental; tail dumps without advancing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cp-bout-"));
    const id = "job_bout1";
    seedJobLog(cwd, id, "line1\nline2\n");
    setJobLogCursor(cwd, id, 0);
    const ctx = { cwd, sessionId: "s1" } as unknown as ToolContext;

    const first = await bashOutputTool.execute({ job_id: id }, ctx);
    expect(first.isError).toBeUndefined();
    expect(first.content).toMatch(/next_offset/);
    expect(first.content).toContain("line1\nline2\n");

    const second = await bashOutputTool.execute({ job_id: id }, ctx);
    expect(second.content).toContain("(no new output)");

    writeFileSync(join(jobsDir(cwd), `${id}.log`), "line1\nline2\nline3\n", "utf-8");
    const third = await bashOutputTool.execute({ job_id: id }, ctx);
    expect(third.content).toContain("line3\n");
    expect(third.content).not.toMatch(/line1\nline2\nline3/);

    const dump = await bashOutputTool.execute({ job_id: id, tail: 10 }, ctx);
    expect(dump.content).toContain("line1\nline2\nline3\n");

    const fourth = await bashOutputTool.execute({ job_id: id }, ctx);
    expect(fourth.content).toContain("(no new output)");
  });
});
