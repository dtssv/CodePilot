// Background sub-agent control helpers (list / wait / interrupt). Prefer calling
// these via `task` with `action: "list"|"wait"|"interrupt"`.

import type { ToolResult } from "./types.js";
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

export function executeSubagentList(registry: BackgroundSubagentRegistry): ToolResult {
  const list = registry.list();
  if (list.length === 0) {
    return { content: "No background sub-agents have been dispatched this session." };
  }
  const lines = list.map(describe).join("\n");
  return { content: `Background sub-agents (${list.length}):\n\n${lines}` };
}

export async function executeSubagentWait(
  registry: BackgroundSubagentRegistry,
  sessionId: string,
): Promise<ToolResult> {
  const meta = await registry.wait(sessionId);
  if (!meta) {
    return {
      content: `No background sub-agent with session_id ${sessionId}.`,
      isError: true,
    };
  }
  const summary = meta.summary ?? "(no conclusion)";
  const header = `sub-agent ${meta.sessionId} finished: ${meta.status} in ${meta.steps ?? 0} step(s).`;
  return {
    content: `${header}\n\nConclusion:\n\n${summary}`,
    isError: meta.status === "failed",
  };
}

export function executeSubagentInterrupt(
  registry: BackgroundSubagentRegistry,
  sessionId: string,
): ToolResult {
  const ok = registry.interrupt(sessionId);
  if (!ok) {
    const meta = registry.get(sessionId);
    if (!meta) {
      return {
        content: `No background sub-agent with session_id ${sessionId}.`,
        isError: true,
      };
    }
    return {
      content: `sub-agent ${sessionId} is already ${meta.status} — nothing to interrupt.`,
      isError: true,
    };
  }
  return { content: `interrupting background sub-agent ${sessionId}.` };
}
