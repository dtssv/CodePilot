import type { PlanStep, PermissionResolution, QuestionAnswers } from "@codepilot/core";
import type { PendingPermission, PendingQuestion } from "../../protocol/client.js";
import type { Activity, SubagentRun, UiStatus } from "../../state/reducer.js";
import type { Row } from "../../state/rows.js";

export type Density = "comfortable" | "compact";

export interface TranscriptProps {
  rows: Row[];
  status: UiStatus;
  permission?: PendingPermission;
  question?: PendingQuestion;
  activity?: Activity;
  density?: Density;
 /** Current plan steps, used to show "step N/M: <title>" live while tools run
  * so the user sees progress even between the model's plan_update calls. */
  plan?: PlanStep[];
 /** Render the latest plan as a full card (off when a side panel shows it). */
  planInline?: boolean;
  onDecide(resolution: PermissionResolution): void;
  onAnswer(answers: QuestionAnswers): void;
  onRetry(): void;
 /** Sub-agents spawned by `task` calls, keyed by the parent tool call id. */
  subagents?: Record<string, SubagentRun[]>;
  /** Open a workspace path in the in-app preview (or host editor). An optional
   * `line` is honored by the IDE-host path (embedded); the in-app preview
   * ignores it. */
  onOpenPath?: (path: string, line?: number) => void;
  /** Insert a code block into the IDE editor (embedded only). When set, code
   * blocks show an "Insert" action; returns false if the host declined. */
  onInsertCode?: (text: string) => boolean;
  /** The scroll container that wraps this transcript. When provided, drilling
   * into a sub-agent and back restores each view's own scroll position instead
   * of leaking the sub-agent's scroll offset onto the main task view. */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** Active session — scopes sub-agent scroll restore so A→B does not leak. */
  sessionId?: string;
}

export interface SubagentNav {
  runs: Record<string, SubagentRun[]>;
  open(toolCallId: string, index: number): void;
}