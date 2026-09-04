// bash_output: poll a background job started with bash(run_in_background).

import { z } from "zod";
import type { ToolDef } from "./types.js";
import { getJob, readJobLog } from "./bashJobs.js";

const schema = z.object({
  job_id: z.string().describe("Job id returned by bash (e.g. \"job_1a2b3c4d\")."),
  tail: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe("Number of trailing log lines to return (default 100)."),
});

export const bashOutputTool: ToolDef<typeof schema> = {
  name: "bash_output",
  description:
    "Read the status and recent output of a background job started with " +
    "`bash(run_in_background: true)`. Returns the job status (running / exited / " +
    "killed / failed / unknown) and the tail of its combined stdout+stderr log. " +
    "Poll with a small `tail` while waiting for a server to come up; read more " +
    "lines when diagnosing a failure.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const job = await getJob(ctx.cwd, input.job_id);
    if (!job) {
      return { content: `unknown job: ${input.job_id}`, isError: true };
    }
    const log = await readJobLog(ctx.cwd, input.job_id, input.tail ?? 100);
    const m = job.meta;
    const statusLine =
      `job ${m.id}: ${m.status}` +
      (m.exitCode !== undefined && m.exitCode !== null ? ` (exit ${m.exitCode})` : "") +
      ` — started ${m.startedAt}` +
      (m.sandboxed ? ` [sandboxed: ${m.sandboxBackend}]` : "");
    return { content: `${statusLine}\n${log}` };
  },
};
