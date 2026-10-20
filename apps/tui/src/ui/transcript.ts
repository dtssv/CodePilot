/**
 * Rows → render blocks, with the same presentation rules as the web UI
 * (apps/web/src/state/selectors.ts):
 * - one user bubble per user message,
 * - everything until the next user message folds into one `assistant_turn`
 * (single assistant glyph) so tool loops still read as 一问一答,
 * - consecutive tool rows collapse into one step group inside the turn,
 * - usage rows are dropped (totals live in the status bar),
 * - only the latest plan renders in full; earlier ones become a one-line
 * marker,
 * - plan_update calls are hidden (the plan block shows them),
 * - assistant messages without visible content are skipped.
 */
import { hasVisibleAssistantContent, type PlanStep } from "@codepilot/core";
import type { MessageRow, Row, ToolRow } from "./state.js";

export type TurnPart =
  | { kind: "message"; msg: MessageRow }
  | { kind: "steps"; tools: ToolRow[] }
  | { kind: "plan"; steps: PlanStep[]; latest: boolean }
  | { kind: "row"; row: Exclude<Row, { kind: "assistant" | "user" | "tool" | "plan" | "usage" }> };

export type Block =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant_turn"; key: string; parts: TurnPart[] };

export function groupRows(rows: readonly Row[]): Block[] {
  let lastPlan = -1;
  rows.forEach((r, i) => {
    if (r.kind === "plan") lastPlan = i;
  });

  const blocks: Block[] = [];
  let turnParts: TurnPart[] = [];
  let turnKey = "";

  const flushTurn = (): void => {
    if (turnParts.length === 0) return;
    blocks.push({
      kind: "assistant_turn",
      key: turnKey || `turn-${blocks.length}`,
      parts: turnParts,
    });
    turnParts = [];
    turnKey = "";
  };

  rows.forEach((r, i) => {
    switch (r.kind) {
      case "usage":
        return;
      case "user":
        flushTurn();
        blocks.push({ kind: "user", key: `u-${r.id}-${i}`, text: r.text });
        return;
      case "assistant":
        if (!hasVisibleAssistantContent(r.msg.text) && !r.msg.reasoning) return;
        if (!turnKey) turnKey = `turn-${r.msg.id}`;
        turnParts.push({ kind: "message", msg: r.msg });
        return;
      case "tool": {
        if (r.tool.category === "plan") return;
        if (!turnKey) turnKey = `turn-s-${r.tool.id}`;
        const prev = turnParts[turnParts.length - 1];
        if (prev?.kind === "steps") prev.tools.push(r.tool);
        else turnParts.push({ kind: "steps", tools: [r.tool] });
        return;
      }
      case "plan":
        if (!turnKey) turnKey = `turn-p-${i}`;
        turnParts.push({ kind: "plan", steps: r.plan, latest: i === lastPlan });
        return;
      default:
        if (!turnKey) turnKey = `turn-${r.kind}-${i}`;
        turnParts.push({ kind: "row", row: r });
    }
  });
  flushTurn();
  return blocks;
}

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
