import {
  addScheduledTask,
  listScheduledTasks,
  removeScheduledTask,
  updateScheduledTask,
} from "@codepilot/core";
import { ErrorCode, RpcError } from "../../rpc.js";
import type { ServerContext } from "../context.js";

export async function handleScheduleList(): Promise<{
  tasks: Awaited<ReturnType<typeof listScheduledTasks>>;
}> {
  return { tasks: await listScheduledTasks() };
}

export async function handleScheduleAdd(
  ctx: ServerContext,
  p: {
    title: string;
    prompt: string;
    cwd?: string;
    kind: "idle" | "once" | "daily" | "weekly" | "interval" | "cron";
    at?: string;
    daysOfWeek?: number[];
    cron?: string;
    timezone?: string;
    runAt?: number;
    everyMinutes?: number;
    idleAfterMs?: number;
    delivery?: "new_session" | { sessionId: string };
    paused?: boolean;
    endsAt?: number;
    model?: string;
    providerId?: string;
    agentMode?: "chat" | "plan" | "agent";
  },
): Promise<{ task: Awaited<ReturnType<typeof addScheduledTask>> }> {
  return {
    task: await addScheduledTask({
      title: p.title,
      prompt: p.prompt,
      cwd: p.cwd || ctx.defaultCwd,
      kind: p.kind,
      at: p.at,
      daysOfWeek: p.daysOfWeek,
      cron: p.cron,
      timezone: p.timezone,
      runAt: p.runAt,
      everyMinutes: p.everyMinutes,
      idleAfterMs: p.idleAfterMs,
      delivery: p.delivery,
      paused: p.paused,
      endsAt: p.endsAt,
      model: p.model,
      providerId: p.providerId,
      agentMode: p.agentMode,
    }),
  };
}

export async function handleScheduleUpdate(p: {
  id?: string;
  title?: string;
  prompt?: string;
  cwd?: string;
  at?: string;
  daysOfWeek?: number[];
  cron?: string;
  timezone?: string;
  runAt?: number;
  everyMinutes?: number;
  idleAfterMs?: number;
  delivery?: "new_session" | { sessionId: string };
  paused?: boolean;
  endsAt?: number;
  model?: string;
  providerId?: string;
  agentMode?: "chat" | "plan" | "agent";
  enabled?: boolean;
}): Promise<{ task: NonNullable<Awaited<ReturnType<typeof updateScheduledTask>>> }> {
  if (!p?.id?.trim()) throw new RpcError(ErrorCode.InvalidParams, "id required");
  const { id, ...patch } = p;
  const task = await updateScheduledTask(id, patch);
  if (!task) throw new RpcError(ErrorCode.InvalidParams, `unknown task: ${id}`);
  return { task };
}

export async function handleScheduleRemove(p: { id: string }): Promise<{ removed: boolean }> {
  return { removed: await removeScheduledTask(p.id) };
}