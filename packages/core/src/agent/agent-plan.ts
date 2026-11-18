// Plan / turn-end heuristics: unfinished steps, waiting-for-user, soft-stop prose.

import type { Event } from "../types.js";
import { extractPlan } from "../compaction/compaction.js";

/** Latest plan still has pending or in_progress steps. */
export function hasUnfinishedPlan(events: Event[]): boolean {
  const plan = extractPlan(events);
  if (!plan || plan.length === 0) return false;
  return plan.some((s) => s.status === "pending" || s.status === "in_progress");
}

/** Assistant text that clearly hands the floor to the user. */
export function isWaitingForUser(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[?？]\s*$/.test(t)) return true;
  return (
    /请确认|请选择|请告诉我|请回复|等你|等您|waiting (for|on) (your|you)|let me know|should I\b|do you want|would you like|your (choice|preference|call)/i.test(
      t
    )
  );
}

/** Soft-stop prose: model announced more work but emitted no tool calls. */
export function looksLikeIncompleteTurn(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (
    /\b(next[,:]?\s+I(?:'ll| will)|I(?:'ll| will)\s+(now|next|continue|proceed)|moving on to|now I(?:'ll| will)|let me (now |next )?)/i.test(
      t
    )
  ) {
    return true;
  }
  return /接下来|下一步我|然后我(?:将|会)|我接着|继续(?:完成|处理|实现)/.test(t);
}
