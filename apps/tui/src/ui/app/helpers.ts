import { CATEGORY_ACTIVE, glyph } from "../theme.js";
import { wrappedHeight } from "../textWidth.js";
import { planProgress, runningTool } from "../transcript.js";
import type { Row, TuiState } from "../state.js";

/** How the UI reached its engine, surfaced quietly in the welcome header. */
export interface ConnectionInfo {
  /** "shared" — this UI started/joined the shared daemon's new session;
   *  "following" — it is tailing an existing shared session;
   *  "local" — a standalone in-process engine drives it. */
  mode: "shared" | "following" | "local";
  sessionId?: string;
}

/** Clear screen and scrollback, cursor home — before the transcript is reprinted. */
export const CLEAR_ALL = "\u001b[2J\u001b[3J\u001b[H";

export type PrintedItem = { key: string; row?: Row };

export function connectionLabel(connection: ConnectionInfo | undefined): string | undefined {
  return connection?.mode === "following"
    ? "following a shared session"
    : connection?.mode === "shared"
      ? "shared server"
      : connection?.mode === "local"
        ? "local engine"
        : undefined;
}

/** Keep a multi-line notice from crowding out the transcript. */
export function clipNotice(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : `${lines.slice(0, maxLines - 1).join("\n")}\n… ${lines.length - maxLines + 1} more lines`;
}

/** Generous row estimate for a live transcript row, so the redrawn region can
 * be clamped before it reaches the terminal height. */
export function estimateRowHeight(row: Row, cols: number): number {
  const width = Math.max(10, cols - 6);
  switch (row.kind) {
    case "assistant": {
      const fences = (row.msg.text.match(/^\s*(```|~~~)/gm) ?? []).length;
      return 2 + wrappedHeight(row.msg.text, width) + fences + (row.msg.reasoning ? 5 : 0);
    }
    case "tool": {
      const runs = row.tool.subagents ?? [];
      const sub = runs.reduce((n, r) => n + Math.min(r.steps.length, 4) + 4, 0);
      return 4 + Math.min(10, wrappedHeight(row.tool.target, width)) + sub;
    }
    case "plan":
      return 2 + row.plan.length;
    default:
      return 4;
  }
}

/** What the agent is doing right now, in the same words as the other clients. */
export function activityLabel(state: TuiState): string {
  switch (state.status) {
    case "compacting":
      return "Compacting context…";
    case "waiting_permission":
      return "Waiting for your approval…";
    case "waiting_question":
      return "Waiting for your answer…";
  }
  const tool = runningTool(state.rows);
  if (tool) {
    const verb = tool.category === "other" ? `Calling ${tool.name}` : CATEGORY_ACTIVE[tool.category];
    return tool.target ? `${verb} ${tool.target}` : `${verb}…`;
  }
  if (state.activity?.phase === "model") return "Waiting for model response";
  const current = planProgress(state.plan).current;
  return current ? `Thinking ${glyph.dot} ${current.title}` : "Thinking…";
}