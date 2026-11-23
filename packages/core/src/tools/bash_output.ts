// bash_output: poll a background job started with bash(run_in_background).

import { z } from "zod";
import type { ToolDef } from "./types.js";
import {
  getJob,
  readJobLog,
  consumeJobLog,
  describeUnknownJob,
  assertJobOwner,
  suppressJobCompletionSteer,
} from "./bashJobs.js";

const schema = z.object({
  job_id: z.string().describe("Job id returned by bash (e.g. \"job_1a2b3c4d\")."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Byte offset into the job log. Omit to resume from the last poll " +
        "(server-side consumption cursor). Pass the previous `next_offset` " +
        "to re-read or skip ahead. Ignored when `tail` is set.",
    ),
  tail: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe(
      "Return the last N lines of the *full* log (diagnostic). Does not " +
        "advance the consumption cursor. Prefer omitting `tail` when polling " +
        "so each call returns only new output.",
    ),
});

export const bashOutputTool: ToolDef<typeof schema> = {
  name: "bash_output",
  description:
    "Status + output for a background `bash` job (`job_id`). Default polls are " +
    "incremental: each call returns only bytes since the previous poll and " +
    "reports `next_offset` for the next read. Pass `tail` only when you need " +
    "a diagnostic snapshot of the end of the full log. Do not tight-loop " +
    "sleep/poll — between polls prefer other independent work.",
  inputSchema: schema,
  permission: "read",
  async execute(input, ctx) {
    const job = await getJob(ctx.cwd, input.job_id);
    if (!job) {
      return { content: describeUnknownJob(ctx.cwd, input.job_id), isError: true };
    }
    const ownerErr = assertJobOwner(job, ctx.sessionId);
    if (ownerErr) return { content: ownerErr, isError: true };
    const m = job.meta;
    // Terminal status already in this tool_result — suppress duplicate steer.
    if (m.status !== "running") {
      suppressJobCompletionSteer(ctx.cwd, input.job_id);
    }
    const statusLine =
      `job ${m.id}: ${m.status}` +
      (m.exitCode !== undefined && m.exitCode !== null ? ` (exit ${m.exitCode})` : "") +
      ` — started ${m.startedAt}` +
      (m.sandboxed ? ` [sandboxed: ${m.sandboxBackend}]` : "");

    if (input.tail !== undefined) {
      const log = await readJobLog(ctx.cwd, input.job_id, input.tail);
      return { content: `${statusLine}\n${log}` };
    }

    const slice = await consumeJobLog(ctx.cwd, input.job_id, input.offset);
    const cursorLine =
      `offset ${slice.fromOffset} → next_offset ${slice.nextOffset} / ${slice.totalBytes} bytes`;
    return { content: `${statusLine}\n${cursorLine}\n${slice.text}` };
  },
};
