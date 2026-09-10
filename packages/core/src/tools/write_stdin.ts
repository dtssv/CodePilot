// write_stdin: send input to a background job's stdin.
//
// Interactive long-running processes (REPLs, dev servers, CLIs that prompt
// for input) started with `bash(run_in_background: true)` keep their stdin
// open. This tool lets the agent send text — or raw bytes — to that stdin,
// enabling "type into the running process" workflows that codex supports.

import { z } from "zod";
import type { ToolDef } from "./types.js";
import { getJob, writeJobStdin } from "./bashJobs.js";

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
    "Send text to the stdin of a background job started with " +
    "`bash(run_in_background: true)`. This lets you interact with running " +
    "REPLs, dev servers, and CLIs that read stdin — e.g. answer a Y/N prompt, " +
    "type a command into a running shell, or pipe data into a process.\n\n" +
    "When to use: a background process is waiting for input (its log shows a " +
    "prompt or it's blocked on a read), and you need to send a response.\n" +
    "When NOT to use: for one-shot commands — use `bash` directly. For reading " +
    "output, use `bash_output`.\n\n" +
    "A newline is appended automatically (most tools expect it). Set `raw: true` " +
    "to send exact bytes without a trailing newline.",
  inputSchema: schema,
  permission: "execute",
  async execute(input, ctx) {
    const job = await getJob(ctx.cwd, input.job_id);
    if (!job) {
      return { content: `unknown job: ${input.job_id}`, isError: true };
    }
    if (job.meta.status !== "running") {
      return {
        content: `job ${input.job_id} is not running (status: ${job.meta.status})`,
        isError: true,
      };
    }
    const ok = await writeJobStdin(ctx.cwd, input.job_id, input.input, {
      appendNewline: !input.raw,
    });
    if (!ok) {
      return {
        content: `failed to write to stdin of job ${input.job_id} (the process may have closed its stdin)`,
        isError: true,
      };
    }
    const sent = input.raw ? input.input : input.input + "\\n";
    const preview = sent.length > 100 ? sent.slice(0, 100) + "…" : sent;
    return {
      content: `wrote ${sent.length} byte(s) to stdin of job ${input.job_id}: ${JSON.stringify(preview)}`,
    };
  },
};
