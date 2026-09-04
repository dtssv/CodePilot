// bash_kill: stop a running background job (SIGTERM).

import { z } from "zod";
import type { ToolDef } from "./types.js";
import { killJob } from "./bashJobs.js";

const schema = z.object({
  job_id: z.string().describe("Job id returned by bash (e.g. \"job_1a2b3c4d\")."),
});

export const bashKillTool: ToolDef<typeof schema> = {
  name: "bash_kill",
  description:
    "Stop a background job started with `bash(run_in_background: true)` by " +
    "sending SIGTERM. Always kill jobs you no longer need (dev servers, watchers) " +
    "before finishing the task — leaked processes hold ports and files.",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    const ok = await killJob(ctx.cwd, input.job_id);
    return ok
      ? { content: `sent SIGTERM to ${input.job_id}` }
      : { content: `job ${input.job_id} is not running (or unknown)`, isError: true };
  },
};
