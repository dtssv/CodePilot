// bash_kill: stop a running background job (SIGTERM).

import { z } from "zod";
import type { ToolDef } from "./types.js";
import { killJob, getJob, describeUnknownJob, assertJobOwner } from "./bashJobs.js";

const schema = z.object({
  job_id: z.string().describe("Job id returned by bash (e.g. \"job_1a2b3c4d\")."),
});

export const bashKillTool: ToolDef<typeof schema> = {
  name: "bash_kill",
  description:
    "SIGTERM a background `bash` job by `job_id`. Kill unused background jobs before finishing.",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    const job = await getJob(ctx.cwd, input.job_id);
    if (!job) {
      return { content: describeUnknownJob(ctx.cwd, input.job_id), isError: true };
    }
    const ownerErr = assertJobOwner(job, ctx.sessionId);
    if (ownerErr) return { content: ownerErr, isError: true };
    const ok = await killJob(ctx.cwd, input.job_id);
    if (ok) return { content: `sent SIGTERM to ${input.job_id}` };
    // Distinguish "no such job" (handled above) from "exists but already stopped".
    return {
      content: `job ${input.job_id} is already ${job.meta.status} — nothing to kill`,
      isError: true,
    };
  },
};
