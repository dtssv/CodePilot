// write_stdin: send text or raw bytes to a background job's stdin, for
// interactive processes (REPLs, dev servers) started with
// `bash(run_in_background: true)`.

import { z } from "zod";
import type { ToolDef } from "./types.js";
import { getJob, writeJobStdin, describeUnknownJob, type WriteJobStdinResult } from "./bashJobs.js";

/** Turn a failed write into advice the model can act on. */
function writeFailure(
  jobId: string,
  result: Extract<WriteJobStdinResult, { ok: false }>
): string {
  switch (result.reason) {
    case "no-such-job":
      return `unknown job: ${jobId}`;
    case "not-running":
 // Includes the case where the job exited while this write was in
 // flight, which is why the tool re-reports the status here.
      return (
        `job ${jobId} is not running (status: ${result.status}) — ` +
        `use bash_output to read what it produced before exiting`
      );
    case "no-stdin":
      return (
        `job ${jobId} has no writable stdin (it was restored after a restart, ` +
        `or the process closed stdin)`
      );
    case "write-failed":
      return `failed to write to stdin of job ${jobId}: ${result.message}`;
  }
}

const schema = z.object({
  job_id: z.string().describe("Job id returned by bash (e.g. \"job_1a2b3c4d\")."),
  input: z
    .string()
    .describe(
      "The text to send to the job's stdin. A newline is appended by default " +
        "(most CLI tools expect line-terminated input). Set `raw` to true to " +
        "send the text verbatim without a trailing newline."
    ),
  raw: z
    .boolean()
    .optional()
    .describe(
      "When true, send `input` verbatim without appending a newline. " +
        "Use for raw/binary input or when the target expects exact bytes."
    ),
});

export const writeStdinTool: ToolDef<typeof schema> = {
  name: "write_stdin",
  description:
    "Write to stdin of a background `bash` job (`job_id`). Appends a newline " +
    "unless `raw: true`. For one-shot commands use `bash`; for logs use `bash_output`.",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    const job = await getJob(ctx.cwd, input.job_id);
    if (!job) {
      return { content: describeUnknownJob(ctx.cwd, input.job_id), isError: true };
    }
    // Ownership guard: the bashJobs registry is keyed only by cwd, so parallel
    // sub-agents sharing a parent cwd share a job table. Refuse to write to a
    // job started by a different session; only enforced when both sides carry
    // an identity.
    if (job.meta.ownerSessionId && ctx.sessionId && job.meta.ownerSessionId !== ctx.sessionId) {
      return {
        content:
          `job ${input.job_id} belongs to a different agent and cannot be written to from here`,
        isError: true,
      };
    }
    if (job.meta.status !== "running") {
      return {
        content: `job ${input.job_id} is not running (status: ${job.meta.status})`,
        isError: true,
      };
    }
    const write = await writeJobStdin(ctx.cwd, input.job_id, input.input, {
      appendNewline: !input.raw,
    });
    if (!write.ok) {
      return { content: writeFailure(input.job_id, write), isError: true };
    }
    const sent = input.raw ? input.input : input.input + "\\n";
    const preview = sent.length > 100 ? sent.slice(0, 100) + "…" : sent;
    return {
      content: `wrote ${sent.length} byte(s) to stdin of job ${input.job_id}: ${JSON.stringify(preview)}`,
    };
  },
};
