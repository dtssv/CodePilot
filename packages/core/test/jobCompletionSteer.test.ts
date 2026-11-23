import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bashTool, bashKillTool, bashOutputTool } from "../src/tools/index.js";
import { resolveSandbox } from "../src/sandbox/sandbox.js";
import { isJobCompletionSteerSuppressed } from "../src/tools/bashJobs.js";
import type { ToolContext } from "../src/tools/types.js";

describe("job completion steer suppression", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cp-job-steer-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function ctx(): ToolContext {
    return {
      cwd: dir,
      artifact: async () => "art_x",
      readArtifact: async () => "",
      sandbox: resolveSandbox({ mode: "off" }, dir),
    };
  }

  it("bash_kill marks the job so completion steer is suppressed", async () => {
    const res = await bashTool.execute(
      {
        command: "sh -c 'echo go; sleep 30'",
        run_in_background: true,
      },
      ctx(),
    );
    const id = res.content.match(/job_[a-f0-9]{8}/)?.[0];
    expect(id).toBeTruthy();
    expect(isJobCompletionSteerSuppressed(dir, id!)).toBe(false);

    await bashKillTool.execute({ job_id: id! }, ctx());
    expect(isJobCompletionSteerSuppressed(dir, id!)).toBe(true);
  }, 15_000);

  it("bash_output of a finished job marks completion steer suppressed", async () => {
    const res = await bashTool.execute(
      { command: "echo done-now", run_in_background: true },
      ctx(),
    );
    const id = res.content.match(/job_[a-f0-9]{8}/)?.[0];
    expect(id).toBeTruthy();

    let out = "";
    for (let i = 0; i < 40; i++) {
      out = (await bashOutputTool.execute({ job_id: id! }, ctx())).content;
      if (/\bexited\b|\bfailed\b|\bkilled\b/.test(out)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(out).toMatch(/\bexited\b|\bfailed\b|\bkilled\b/);
    expect(isJobCompletionSteerSuppressed(dir, id!)).toBe(true);
  }, 15_000);
});
