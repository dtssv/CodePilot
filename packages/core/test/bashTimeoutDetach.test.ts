// Foreground bash wall-clock timeout adopts the still-running process into
// bashJobs instead of killing it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bashTool, bashKillTool, bashOutputTool } from "../src/tools/index.js";
import { resolveSandbox } from "../src/sandbox/sandbox.js";
import { onJobCompletion } from "../src/tools/bashJobs.js";
import type { ToolContext } from "../src/tools/types.js";

describe("bash foreground timeout → background adopt", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cp-bash-to-"));
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

  it("detaches a long command as a background job and keeps isError false", async () => {
    const completions: string[] = [];
    const unsub = onJobCompletion(dir, (meta) => completions.push(meta.id));

    const res = await bashTool.execute(
      {
        // Prints then sleeps past the wait budget. Wrap sleep so the bare
        // `sleep N` foreground block does not reject before timeout-detach.
        command: "sh -c 'echo started-detach; sleep 30'",
        timeout: 400,
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/continued as background job job_[a-f0-9]{8}/);
    expect(res.content).toMatch(/started-detach/);

    const id = res.content.match(/job_[a-f0-9]{8}/)?.[0];
    expect(id).toBeTruthy();

    // Process should still be alive and readable via bash_output.
    const out = await bashOutputTool.execute({ job_id: id! }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(/started-detach|running|output/i);

    await bashKillTool.execute({ job_id: id! }, ctx());
    unsub();
    // Completion may or may not have fired yet depending on kill timing.
    void completions;
  }, 15_000);
});
