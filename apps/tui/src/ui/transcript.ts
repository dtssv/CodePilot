/** Small queries over transcript rows shared by the status line and the plan view. */
import type { PlanStep } from "@codepilot/core";
import type { Row, ToolRow } from "./state.js";

export function planProgress(steps: readonly PlanStep[] | undefined): { done: number; total: number; current?: PlanStep } {
  if (!steps || steps.length === 0) return { done: 0, total: 0 };
  return {
    done: steps.filter((s) => s.status === "completed").length,
    total: steps.length,
    current: steps.find((s) => s.status === "in_progress"),
  };
}

/** The step running right now, for the activity line. */
export function runningTool(rows: readonly Row[]): ToolRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "tool" && r.tool.status === "running") return r.tool;
    if (r.kind === "user") return undefined;
  }
  return undefined;
}
