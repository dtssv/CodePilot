// task_board: a shared task board for coordinating parallel sub-agents,
// one tool with an `action` selector. Ownership is stamped with the
// caller's session id (a claimed task can't be completed/annotated by
// another). Read-only list/get for all; mutating actions need write tier.
// Backed by append-only JSONL; fully fail-soft.

import { z } from "zod";
import type { ToolDef } from "./types.js";
import { TaskBoard, type TaskSnapshot } from "../taskBoard.js";

const schema = z.object({
  action: z
    .enum(["list", "get", "create", "claim", "complete", "update"])
    .describe(
      "list: all tasks; get: one task; create: add an open task; " +
        "claim: take an open task; complete: finish a task you own; " +
        "update: add a progress note to a task you own.",
    ),
  id: z.string().optional().describe("Task id (required for get/claim/complete/update)."),
  title: z.string().optional().describe("Task title (required for create)."),
  detail: z.string().optional().describe("Optional longer description (create)."),
  result: z.string().optional().describe("Optional outcome summary (complete)."),
  note: z.string().optional().describe("Progress note (required for update)."),
});

function render(task: TaskSnapshot): string {
  const bits = [
    `${task.id} [${task.status}] ${task.title}`,
    task.owner ? `owner=${task.owner}` : null,
    task.detail ? `detail: ${task.detail}` : null,
    task.result ? `result: ${task.result}` : null,
    task.notes.length ? `notes:\n  - ${task.notes.join("\n  - ")}` : null,
  ].filter(Boolean);
  return bits.join("\n");
}

export const taskBoardTool: ToolDef<typeof schema> = {
  name: "task_board",
  description:
    "Shared task board for parallel sub-agents: create tasks, claim one (single-owner), " +
    "complete or annotate tasks you own, and list/get tasks. Ownership is per sub-agent, " +
    "so a claimed task cannot be taken or finished by another. Persisted per project.",
  inputSchema: schema,
  // Mutations are gated by the write tier; read actions short-circuit below.
  permission: "write",
  async execute(input, ctx) {
    const dir = ctx.projectStateDir;
    if (!dir) {
      return { content: "task board unavailable: no project state dir", isError: true };
    }
    const owner = ctx.sessionId ?? "unknown";
    const board = new TaskBoard(dir);

    try {
      switch (input.action) {
        case "list": {
          const tasks = await board.list();
          if (tasks.length === 0) return { content: "task board is empty" };
          return { content: tasks.map(render).join("\n\n") };
        }
        case "get": {
          if (!input.id) return { content: "get requires `id`", isError: true };
          const task = await board.get(input.id);
          return task
            ? { content: render(task) }
            : { content: `unknown task ${input.id}`, isError: true };
        }
        case "create": {
          if (!input.title) return { content: "create requires `title`", isError: true };
          const r = await board.create(input.title, input.detail);
          return { content: r.task ? `${r.reason}\n${render(r.task)}` : r.reason, isError: !r.ok };
        }
        case "claim": {
          if (!input.id) return { content: "claim requires `id`", isError: true };
          const r = await board.claim(input.id, owner);
          return { content: r.reason, isError: !r.ok };
        }
        case "complete": {
          if (!input.id) return { content: "complete requires `id`", isError: true };
          const r = await board.complete(input.id, owner, input.result);
          return { content: r.reason, isError: !r.ok };
        }
        case "update": {
          if (!input.id || !input.note) {
            return { content: "update requires `id` and `note`", isError: true };
          }
          const r = await board.update(input.id, owner, input.note);
          return { content: r.reason, isError: !r.ok };
        }
      }
    } catch (err) {
      return { content: `task_board failed: ${(err as Error).message}`, isError: true };
    }
    return { content: `unknown action ${input.action}`, isError: true };
  },
};
