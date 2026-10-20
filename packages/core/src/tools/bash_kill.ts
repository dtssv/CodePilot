// bash_kill: stop a running background job (SIGTERM).

import { z } from "zod";
import type { ToolDef } from "./types.js";
import { killJob, getJob, describeUnknownJob } from "./bashJobs.js";

const schema = z.object({
  job_id: z.string().describe("Job id returned by bash (e.g. \"job_1a2b3c4d\")."),
});

export const bashKillTool: ToolDef<typeof schema> = {
  name: "bash_kill",
  description:
    "SIGTERM a background `bash` job by `job_id`. Kill unused servers/watchers before finishing.",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    const ok = await killJob(ctx.cwd, input.job_id);
    if (ok) return { content: `sent SIGTERM to ${input.job_id}` };
 // Distinguish "no such job" (actionable — list real ids) from "exists but
 // already stopped" so the model doesn't retry a kill that can't succeed.
    const job = await getJob(ctx.cwd, input.job_id);
    if (!job) {
      return { content: describeUnknownJob(ctx.cwd, input.job_id), isError: true };
    }
    return {
      content: `job ${input.job_id} is already ${job.meta.status} — nothing to kill`,
      isError: true,
    };
  },
};
