// Tests for the write_stdin tool: sending input to a background job's stdin.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeStdinTool } from "../src/tools/write_stdin.js";
import { bashTool } from "../src/tools/bash.js";
import { bashKillTool } from "../src/tools/bash_kill.js";
import { bashOutputTool } from "../src/tools/bash_output.js";
import { resolveSandbox } from "../src/sandbox.js";
import type { ToolContext } from "../src/tools/types.js";

describe("write_stdin tool", () => {
  let dir: string;
  const sandboxOffCtx = (): ToolContext => ({
    cwd: dir,
    artifact: async () => "art_x",
    readArtifact: async () => "",
    sandbox: resolveSandbox({ mode: "off" }, dir ?? "/tmp"),
  });

  /** Start a background job and return its job id. */
  async function startJob(command: string): Promise<string> {
    const start = await bashTool.execute(
      { command, run_in_background: true },
      sandboxOffCtx()
    );
    expect(start.isError).toBeFalsy();
    const m = start.content.match(/job_[a-f0-9]{8}/);
    expect(m).toBeTruthy();
    return m![0];
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cpstdin-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an error for an unknown job id", async () => {
    const res = await writeStdinTool.execute(
      { job_id: "job_00000000", input: "hello" },
      sandboxOffCtx()
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("unknown job");
    expect(res.content).toContain("job_00000000");
  });

  it("returns an error when the job is not running (exited)", async () => {
    // A job that finishes immediately.
    const id = await startJob("echo done");
    // Wait for it to exit.
    await new Promise((r) => setTimeout(r, 700));
    const res = await writeStdinTool.execute(
      { job_id: id, input: "too late" },
      sandboxOffCtx()
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not running");
    expect(res.content).toContain(id);
    expect(res.content).toMatch(/status: (exited|unknown)/);
  });

  it("writes to stdin with a newline appended by default", async () => {
    // `cat` echoes each stdin line to stdout, so the job log shows what we sent.
    const id = await startJob("cat");
    try {
      const res = await writeStdinTool.execute(
        { job_id: id, input: "hello stdin" },
        sandboxOffCtx()
      );
      expect(res.isError).toBeFalsy();
      // The tool reports the escaped form: "hello stdin" (11 chars) + the
      // two characters "\n" => 13 byte(s) in the message.
      expect(res.content).toContain("wrote 13 byte(s)");
      expect(res.content).toContain(id);
      expect(res.content).toContain(JSON.stringify("hello stdin\\n"));

      // The newline-terminated input should reach the process as a full line.
      await new Promise((r) => setTimeout(r, 500));
      const out = await bashOutputTool.execute({ job_id: id }, sandboxOffCtx());
      expect(out.content).toContain("hello stdin");
    } finally {
      await bashKillTool.execute({ job_id: id }, sandboxOffCtx());
    }
  });

  it("raw mode sends input verbatim without a trailing newline", async () => {
    const id = await startJob("cat");
    try {
      const res = await writeStdinTool.execute(
        { job_id: id, input: "partial", raw: true },
        sandboxOffCtx()
      );
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("wrote 7 byte(s)");
      expect(res.content).toContain('"partial"');
      expect(res.content).not.toContain("\\n");
    } finally {
      await bashKillTool.execute({ job_id: id }, sandboxOffCtx());
    }
  });

  it("returns an error when the process has closed its stdin", async () => {
    // The child closes fd 0 immediately but stays alive, so the job is
    // still "running" while its stdin pipe is broken (writes raise EPIPE).
    const id = await startJob("exec 0<&-; sleep 60");
    try {
      // Give the shell a moment to execute `exec 0<&-`.
      await new Promise((r) => setTimeout(r, 300));
      const res = await writeStdinTool.execute(
        { job_id: id, input: "nowhere to go" },
        sandboxOffCtx()
      );
      expect(res.isError).toBe(true);
      expect(res.content).toContain("failed to write to stdin");
      expect(res.content).toContain(id);
    } finally {
      await bashKillTool.execute({ job_id: id }, sandboxOffCtx());
    }
  });

  it("includes the byte count and a JSON-quoted preview in the message", async () => {
    const id = await startJob("cat");
    try {
      const input = 'say "hi"';
      const res = await writeStdinTool.execute(
        { job_id: id, input },
        sandboxOffCtx()
      );
      expect(res.isError).toBeFalsy();
      // input (8 chars) + the two characters "\n" => 10 byte(s).
      expect(res.content).toContain("wrote 10 byte(s)");
      // The preview is JSON.stringify'd, so embedded quotes get escaped.
      expect(res.content).toContain(JSON.stringify('say "hi"\\n'));
      expect(res.content).toMatch(
        new RegExp(`^wrote \\d+ byte\\(s\\) to stdin of job ${id}: `)
      );
    } finally {
      await bashKillTool.execute({ job_id: id }, sandboxOffCtx());
    }
  });

  it("truncates the preview with an ellipsis when the sent text exceeds 100 chars", async () => {
    const id = await startJob("cat");
    try {
      // 120 chars of input + the two characters "\n" => 122 chars, > 100.
      const input = "x".repeat(120);
      const res = await writeStdinTool.execute(
        { job_id: id, input },
        sandboxOffCtx()
      );
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("wrote 122 byte(s)");
      // Preview: first 100 chars of the sent text followed by "…".
      const sent = input + "\\n";
      const preview = sent.slice(0, 100) + "…";
      expect(res.content).toContain(JSON.stringify(preview));
      expect(res.content).toContain("…");
      // Full 120-x string must NOT appear verbatim in the message.
      expect(res.content).not.toContain("x".repeat(120));
    } finally {
      await bashKillTool.execute({ job_id: id }, sandboxOffCtx());
    }
  });

  it("does not truncate a preview of exactly 100 chars", async () => {
    const id = await startJob("cat");
    try {
      // 98 chars of input + the two characters "\n" => exactly 100 chars.
      const input = "y".repeat(98);
      const res = await writeStdinTool.execute(
        { job_id: id, input },
        sandboxOffCtx()
      );
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("wrote 100 byte(s)");
      expect(res.content).not.toContain("…");
      expect(res.content).toContain(JSON.stringify(input + "\\n"));
    } finally {
      await bashKillTool.execute({ job_id: id }, sandboxOffCtx());
    }
  });
});
