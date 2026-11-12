// Parent-only control tools for background sub-agents (`task` with
// `run: "background"`): list them, wait for one to finish, or interrupt one.
// These are deliberately NOT a mailbox / parent↔child chat channel — a
// background sub-agent delivers exactly one completion summary, and to iterate
// with it the parent uses the existing `continue_session_id` on a new `task`.
//
// Each tool carries a `registry` field set per session (mirroring taskTool.runner),
// so parallel sessions never see each other's background jobs. Sub-agents do not
// get these tools (nested dispatch is banned), so they are registered only on the
// parent tool surface.

import { z } from "zod";
import type { ToolDef } from "./types.js";
import type { BackgroundSubagentRegistry, BackgroundSubagentMeta } from "./subagentJobs.js";

function fmtAge(meta: BackgroundSubagentMeta): string {
  const end = meta.finishedAt ?? Date.now();
  const secs = Math.max(0, Math.round((end - meta.startedAt) / 1000));
  return `${secs}s`;
}

function describe(meta: BackgroundSubagentMeta): string {
  const obj = meta.objective.length > 80 ? `${meta.objective.slice(0, 77)}…` : meta.objective;
  return `#${meta.runSeq} ${meta.sessionId} [${meta.status}] ${fmtAge(meta)} — ${obj}`;
}

const listSchema = z.object({});

export const subagentListTool: ToolDef<typeof listSchema> & {
  registry?: BackgroundSubagentRegistry;
} = {
  name: "subagent_list",
  description:
    "List the background sub-agents dispatched this session (`task` with " +
    "`run: \"background\"`), with their status (running / ok / failed / interrupted). " +
    "Use to check on work you dispatched without blocking.",
  inputSchema: listSchema,
  permission: "read",
  async execute() {
    const list = this.registry?.list() ?? [];
    if (list.length === 0) {
      return { content: "No background sub-agents have been dispatched this session." };
    }
    const lines = list.map(describe).join("\n");
    return { content: `Background sub-agents (${list.length}):\n\n${lines}` };
  },
};

const waitSchema = z.object({
  session_id: z
    .string()
    .describe("The background sub-agent's session_id (from the task result or subagent_list)."),
});

export const subagentWaitTool: ToolDef<typeof waitSchema> & {
  registry?: BackgroundSubagentRegistry;
} = {
  name: "subagent_wait",
  description:
    "Block until a background sub-agent finishes, then return its final status " +
    "and conclusion. Use when you have reached a point where you need its result.",
  inputSchema: waitSchema,
  permission: "read",
  async execute(input) {
    if (!this.registry) {
      return { content: "No background sub-agent registry in this context.", isError: true };
    }
    const meta = await this.registry.wait(input.session_id);
    if (!meta) {
      return {
        content: `No background sub-agent with session_id ${input.session_id}.`,
        isError: true,
      };
    }
    const summary = meta.summary ?? "(no conclusion)";
    const header = `sub-agent ${meta.sessionId} finished: ${meta.status} in ${meta.steps ?? 0} step(s).`;
    return {
      content: `${header}\n\nConclusion:\n\n${summary}`,
      isError: meta.status === "failed",
    };
  },
};

const interruptSchema = z.object({
  session_id: z
    .string()
    .describe("The background sub-agent's session_id to interrupt."),
});

export const subagentInterruptTool: ToolDef<typeof interruptSchema> & {
  registry?: BackgroundSubagentRegistry;
} = {
  name: "subagent_interrupt",
  description:
    "Stop a running background sub-agent by session_id. It aborts at its next " +
    "checkpoint and is marked interrupted; its permit is released for other work.",
  inputSchema: interruptSchema,
  permission: "execute",
  async execute(input) {
    if (!this.registry) {
      return { content: "No background sub-agent registry in this context.", isError: true };
    }
    const ok = this.registry.interrupt(input.session_id);
    if (!ok) {
      const meta = this.registry.get(input.session_id);
      if (!meta) {
        return {
          content: `No background sub-agent with session_id ${input.session_id}.`,
          isError: true,
        };
      }
      return {
        content: `sub-agent ${input.session_id} is already ${meta.status} — nothing to interrupt.`,
        isError: true,
      };
    }
    return { content: `interrupting background sub-agent ${input.session_id}.` };
  },
};
