// bash_output: poll a background job started with bash(run_in_background).

import { z } from "zod";
import type { ToolDef } from "./types.js";
import { getJob, readJobLog, describeUnknownJob } from "./bashJobs.js";

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
    "Status + log tail for a background `bash` job (`job_id`). Poll with small " +
    "`tail` while waiting; larger `tail` when diagnosing.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const job = await getJob(ctx.cwd, input.job_id);
    if (!job) {
      return { content: describeUnknownJob(ctx.cwd, input.job_id), isError: true };
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
