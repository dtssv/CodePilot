/**
 * TUI state model + reducer. Keeps a normalized event log plus per-message
 * streaming buffers; each core `Event` dispatches a `TuiAction`, the reducer
 * returns the next `TuiState`. `message_delta` folds into the current message
 * without rebuilding the log.
 */
import type {
  AgentMode,
  ContentBlock,
  Event,
  PermissionMode,
  PlanStep,
  QuestionRequest,
  TeamMessageEvent,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  UsageInfo,
} from "@codepilot/core";
import { changeCounts, toolCategory, toolTarget, type ToolCategory } from "./theme.js";

/** Per-message render state. */
export interface MessageRow {
  id: string;
  role: "user" | "assistant";
 /** Aggregated text so far. For assistant rows this grows as deltas arrive. */
  text: string;
 /** Extended-thinking text, accumulated from `reasoning` message deltas
  * (Anthropic extended thinking). Shown dimmed above the answer while the
  * turn streams; empty when the model did not think out loud. */
  reasoning?: string;
 /** Final content blocks if the full `message` event has arrived. */
  blocks?: ContentBlock[];
  model?: string;
 /** When true, more deltas are still expected. */
  streaming: boolean;
}

/** A tool invocation row (call + result). */
export interface ToolRow {
  id: string;
  name: string;
 /** Brief, formatted summary of the input. */
  inputSummary: string;
  category: ToolCategory;
 /** Path, command, pattern… shown next to the step verb. */
  target: string;
 /** Lines added/removed, for edits and writes. */
  added?: number;
  removed?: number;
  startedAt?: number;
  finishedAt?: number;
 /** Full result text (may be large — UI can collapse). */
  resultText?: string;
  resultIsError?: boolean;
  artifactRef?: string;
  status: "running" | "ok" | "error";
 /** Raw tool input, for the detail viewer. */
  input?: unknown;
 /** Sub-agents dispatched by this call (task / spawn_agent), by fan-out index. */
  subagents?: SubagentRun[];
}

/** One sub-agent run nested under the tool call that dispatched it. */
export interface SubagentRun {
  index: number;
  objective: string;
  sessionId?: string;
  runSeq?: number;
  background?: boolean;
  state: "running" | "ok" | "failed" | "interrupted";
  steps: ToolRow[];
 /** Latest assistant text from the sub-agent (its conclusion once finished). */
  text: string;
  startedAt?: number;
  finishedAt?: number;
}

/** UI status derived from core status events + our own knowledge. */
export type UiStatus = "idle" | "thinking" | "executing" | "compacting" | "waiting_permission" | "waiting_question";

/** A pending permission request the user must resolve. */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string;
  /** Live-disk before/after preview for write/edit/apply_patch. */
  preview?: string;
}

export interface TuiState {
  sessionId: string | undefined;
  cwd: string;
  model: string | undefined;
 /** Named provider preset id when known. */
  providerId?: string;
  permissionMode: PermissionMode;
 /** Collaboration mode (which tools the model can call). */
  agentMode: AgentMode;
  status: UiStatus;
 /** Rendered in order. May be a message, tool row, plan row, or system note. */
  rows: Row[];
 /** The most recent plan (from a `plan` event). */
  plan: PlanStep[] | undefined;
 /** Cumulative token usage + cost. */
  usage: UsageInfo;
 /** Input box value (controlled by InputBox). */
  input: string;
 /** Pending permission request, if any. */
  permission: PendingPermission | undefined;
 /** Pending structured question request (ask_user_question / plan_done). */
  question: QuestionRequest | undefined;
 /** Requests raised while another one is on screen (parallel tool calls). */
  queuedPermissions?: PendingPermission[];
  queuedQuestions?: QuestionRequest[];
 /** True while a prompt is in flight (between prompt and the next status:idle). */
  busy: boolean;
 /** Last system message, used for ephemeral notices. */
  notice: string | undefined;
 /** Session list (populated by /sessions). */
  sessions: { id: string; title: string; updatedAt: number; cwd: string }[];
 /** What the running turn is waiting on right now (model vs tools). */
  activity?: { phase: "model" | "tools"; since: number; tools?: string[] };
 /** Latest per-turn budget snapshot (from `turn_budget`), for the status line.
  * `windDownAt`/`maxTurns` are null when unlimited; `warning` marks an imminent
  * wind-down. Cleared when a prompt settles. */
  turnBudget?: { turn: number; windDownAt: number | null; maxTurns: number | null; stalledTurns: number; warning?: boolean };
}

export type Row =
  | { kind: "user"; id: string; text: string; steer?: boolean }
  | { kind: "assistant"; msg: MessageRow }
  | { kind: "tool"; tool: ToolRow }
  | { kind: "plan"; plan: PlanStep[]; at: number }
  | { kind: "compaction"; summary: string; at: number }
  | { kind: "usage"; usage: UsageInfo; at: number }
  | { kind: "error"; message: string; recoverable: boolean; at: number }
  | { kind: "system"; text: string; at: number }
  | {
      kind: "goal";
      round: number;
      maxRounds?: number;
      status: "running" | "completed" | "blocked" | "round_limit";
      detail?: string;
      at: number;
    }
  | { kind: "retry"; attempt: number; maxAttempts: number; delayMs: number; reason: string; at: number }
  | {
      kind: "team";
      from: string;
      to: string;
      text: string;
      msgKind: TeamMessageEvent["kind"];
      at: number;
    };

export type TuiAction =
  | { type: "init"; sessionId: string | undefined; cwd: string; model: string | undefined; permissionMode: TuiState["permissionMode"]; agentMode: AgentMode }
  | { type: "event"; event: Event }
  | { type: "set-input"; value: string }
  | { type: "permission-pending"; req: PendingPermission }
  | { type: "permission-resolve"; requestId?: string }
  | { type: "question-pending"; req: QuestionRequest }
  | { type: "question-resolve"; requestId?: string }
  | { type: "set-status"; status: UiStatus }
  | { type: "set-busy"; busy: boolean }
  | { type: "set-notice"; text: string | undefined }
  | { type: "set-plan"; plan: PlanStep[] }
  | { type: "set-model"; model: string | undefined; providerId?: string }
  | { type: "set-mode"; mode: TuiState["permissionMode"] }
  | { type: "set-agent-mode"; mode: AgentMode }
  | { type: "set-sessions"; sessions: TuiState["sessions"] }
  | { type: "clear" }
  | { type: "exit" };

const emptyUsage: UsageInfo = { input: 0, output: 0 };

export function initialState(opts: {
  sessionId: string | undefined;
  cwd: string;
  model: string | undefined;
  permissionMode: TuiState["permissionMode"];
  agentMode: AgentMode;
}): TuiState {
  return {
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
    agentMode: opts.agentMode,
    status: "idle",
    rows: [],
    plan: undefined,
    usage: { ...emptyUsage },
    input: "",
    permission: undefined,
    question: undefined,
    busy: false,
    notice: undefined,
    sessions: [],
  };
}

/** The collaboration-mode cycle for Shift+Tab, mirroring the other clients'
 * mode switch. Advances Agent → Plan → Ask → Agent. */
export const AGENT_MODE_CYCLE: readonly AgentMode[] = ["agent", "plan", "chat"];

/** Next collaboration mode in the Shift+Tab cycle. */
export function nextAgentMode(mode: AgentMode): AgentMode {
  const i = AGENT_MODE_CYCLE.indexOf(mode);
  return AGENT_MODE_CYCLE[(i + 1) % AGENT_MODE_CYCLE.length] ?? "agent";
}

/** Sum two usage records into a new object. */
export function addUsage(a: UsageInfo, b: UsageInfo): UsageInfo {
  const out: UsageInfo = {
    input: a.input + b.input,
    output: a.output + b.output,
  };
  if (a.cacheRead || b.cacheRead) out.cacheRead = (a.cacheRead ?? 0) + (b.cacheRead ?? 0);
  if (a.cacheWrite || b.cacheWrite) out.cacheWrite = (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
  if (a.costUSD !== undefined || b.costUSD !== undefined) {
    out.costUSD = (a.costUSD ?? 0) + (b.costUSD ?? 0);
  }
  return out;
}

/** Render a small, single-line summary of a tool input. */
export function summarizeInput(_name: string, input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return truncate(input, 80);
  if (typeof input !== "object") return truncate(String(input), 80);
 // Prefer the human-facing subject (paths / command) over raw field dumps —
 // especially apply_patch, whose only field is a long `patch` body.
  const subject = toolTarget(input);
  if (subject) return truncate(subject, 120);
 // Pick a few well-known fields first, then fall back to all primitives.
  const obj = input as Record<string, unknown>;
  const preferredKeys = ["file_path", "path", "command", "cmd", "pattern", "query", "url", "title", "objective", "content"];
  const parts: string[] = [];
  for (const k of preferredKeys) {
    if (typeof obj[k] === "string" || typeof obj[k] === "number") {
      parts.push(`${k}=${truncate(String(obj[k]), 60)}`);
    }
  }
  if (parts.length === 0) {
    for (const [k, v] of Object.entries(obj)) {
      if (parts.length >= 3) break;
      if (k === "patch") continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        parts.push(`${k}=${truncate(String(v), 40)}`);
      }
    }
  }
  if (parts.length === 0) {
    try {
      return truncate(JSON.stringify(input), 80);
    } catch {
      return "(unserializable input)";
    }
  }
  return parts.join(" ");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function newToolRow(id: string, name: string, input: unknown, at?: number): ToolRow {
  return {
    id,
    name,
    inputSummary: summarizeInput(name, input),
    category: toolCategory(name),
    target: toolTarget(input),
    ...changeCounts(name, input),
    status: "running",
    startedAt: at ?? Date.now(),
    input,
  };
}

function finishToolRow(
  tool: ToolRow,
  ev: { content: string; isError?: boolean; artifactRef?: string },
  at?: number,
): ToolRow {
  const finishedAt = at ?? Date.now();
 // A parent result means every sub-agent is done; close any that never got a
 // terminal state event so the Static snapshot does not freeze on "working".
  const subagents = tool.subagents?.map((r) =>
    r.state === "running"
      ? { ...r, state: (ev.isError ? "failed" : "ok") as SubagentRun["state"], finishedAt }
      : r,
  );
  return {
    ...tool,
    resultText: ev.content,
    resultIsError: ev.isError,
    artifactRef: ev.artifactRef,
    status: ev.isError ? "error" : "ok",
    finishedAt,
    ...(subagents ? { subagents } : {}),
  };
}

/** Fold one `subagent` event into the dispatching tool row. */
function applySubagent(tool: ToolRow, ev: Extract<Event, { type: "subagent" }>): ToolRow {
  const runs = (tool.subagents ?? []).slice();
  let i = runs.findIndex((r) => r.index === ev.index);
  if (i < 0) {
    runs.push({
      index: ev.index,
      objective: ev.objective,
      state: "running",
      steps: [],
      text: "",
      startedAt: ev.ts ?? Date.now(),
    });
    runs.sort((a, b) => a.index - b.index);
    i = runs.findIndex((r) => r.index === ev.index);
  }
  const run: SubagentRun = { ...runs[i]! };
  if (ev.sessionId) run.sessionId = ev.sessionId;
  if (ev.runSeq !== undefined) run.runSeq = ev.runSeq;
  if (ev.background) run.background = true;
  if (ev.state) {
    run.state = ev.state;
    if (ev.state !== "running") run.finishedAt = ev.ts ?? Date.now();
  }
  const inner = ev.event;
 // A call rejected before it runs (unknown tool, denied) reports its result
 // ahead of the tool_call, so either event may create the step.
  const addCall = (id: string, name: string, input: unknown, at?: number): void => {
    const existing = run.steps.find((s) => s.id === id);
    if (!existing) {
      run.steps = [...run.steps, newToolRow(id, name, input, at)];
    } else if (existing.input === undefined) {
      const fresh = newToolRow(id, name, input, existing.startedAt);
      run.steps = run.steps.map((s) => (s.id === id ? { ...s, input, target: fresh.target, inputSummary: fresh.inputSummary } : s));
    }
  };
  if (inner?.type === "tool_call") {
    addCall(inner.id, inner.name, inner.input, inner.ts ?? ev.ts);
  } else if (inner?.type === "tool_result") {
    const at = inner.ts ?? ev.ts;
    if (!run.steps.some((s) => s.id === inner.toolCallId)) {
      run.steps = [...run.steps, { ...newToolRow(inner.toolCallId, inner.name, undefined, at), input: undefined }];
    }
    run.steps = run.steps.map((s) => (s.id === inner.toolCallId ? finishToolRow(s, inner, at) : s));
  } else if (inner?.type === "message_delta" && inner.delta?.type === "text" && inner.delta.text) {
    // Live assistant tokens from the sub-agent — without this the task row
    // stays empty until the final message, which looks like a silent reply.
    run.text = (run.text ?? "") + inner.delta.text;
  } else if (inner?.type === "message" && inner.role === "assistant") {
    const text = inner.content.filter(isTextBlock).map((b) => b.text).join("").trim();
    if (text) run.text = text;
    for (const t of inner.content.filter(isToolUseBlock)) addCall(t.id, t.name, t.input, inner.ts ?? ev.ts);
  }
  runs[i] = run;
  return { ...tool, subagents: runs };
}

/** Stable identity for a row, used as the `<Static>` key once it is printed. */
export function rowKeys(rows: readonly Row[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base =
      r.kind === "user" ? `u:${r.id}`
      : r.kind === "assistant" ? `a:${r.msg.id}`
      : r.kind === "tool" ? `t:${r.tool.id}`
 // A goal row is updated in place each round; key it by status so the
 // finished state prints as a new item.
      : r.kind === "goal" ? `goal:${r.status}`
      : `${r.kind}:${"at" in r ? r.at : 0}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

/**
 * How many leading rows are final and can be printed once into terminal
 * scrollback. Streaming messages, running tools and transient retry banners
 * are still changing, so the prefix stops at the first of them; once the turn
 * is idle everything left is final.
 */
export function settledCount(rows: readonly Row[], busy: boolean): number {
  if (!busy) return rows.length;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
 // The prompt's bubble is re-sent with its final content right after it
 // appears, so hold it back until something follows it.
    if (r.kind === "user" && i === rows.length - 1) return i;
    if (r.kind === "assistant" && r.msg.streaming) return i;
    if (r.kind === "tool" && r.tool.status === "running") return i;
    if (r.kind === "retry") return i;
    if (r.kind === "error" && r.recoverable && TRANSIENT_ERROR.test(r.message)) return i;
  }
  return rows.length;
}

const TRANSIENT_ERROR = /\b429\b|rate.?limit|too many requests|overloaded|sustaining heavy rate-limiting/i;

function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === "text";
}
function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}
function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
  return b.type === "tool_result";
}

export function reducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "init":
      return {
        ...state,
        sessionId: action.sessionId,
        cwd: action.cwd,
        model: action.model,
        permissionMode: action.permissionMode,
        agentMode: action.agentMode,
      };
    case "set-input":
      return { ...state, input: action.value };
    case "set-status":
      return { ...state, status: action.status };
    case "set-busy":
      return { ...state, busy: action.busy };
    case "set-notice":
      return { ...state, notice: action.text };
    case "set-plan":
      return {
        ...state,
        plan: action.plan,
        rows: [
          ...state.rows,
          { kind: "plan", plan: action.plan, at: Date.now() },
        ],
      };
    case "set-model":
      return {
        ...state,
        model: action.model,
        providerId: action.providerId ?? state.providerId,
      };
    case "set-mode":
      return { ...state, permissionMode: action.mode };
    case "set-agent-mode":
      return { ...state, agentMode: action.mode };
    case "set-sessions":
      return { ...state, sessions: action.sessions };
    case "permission-pending":
      if (state.permission && state.permission.requestId !== action.req.requestId) {
        const queued = (state.queuedPermissions ?? []).filter((p) => p.requestId !== action.req.requestId);
        return { ...state, queuedPermissions: [...queued, action.req] };
      }
      return { ...state, permission: action.req, status: "waiting_permission" };
    case "permission-resolve": {
      const queued = state.queuedPermissions ?? [];
      if (action.requestId && state.permission?.requestId !== action.requestId) {
        return { ...state, queuedPermissions: queued.filter((p) => p.requestId !== action.requestId) };
      }
      const [next, ...rest] = queued;
      return next
        ? { ...state, permission: next, queuedPermissions: rest, status: "waiting_permission" }
        : { ...state, permission: undefined, queuedPermissions: undefined };
    }
    case "question-pending":
      if (state.question && state.question.requestId !== action.req.requestId) {
        const queued = (state.queuedQuestions ?? []).filter((q) => q.requestId !== action.req.requestId);
        return { ...state, queuedQuestions: [...queued, action.req] };
      }
      return { ...state, question: action.req, status: "waiting_question" };
    case "question-resolve": {
      const queued = state.queuedQuestions ?? [];
      if (action.requestId && state.question?.requestId !== action.requestId) {
        return { ...state, queuedQuestions: queued.filter((q) => q.requestId !== action.requestId) };
      }
      const [next, ...rest] = queued;
      return next
        ? { ...state, question: next, queuedQuestions: rest, status: "waiting_question" }
        : { ...state, question: undefined, queuedQuestions: undefined };
    }
    case "clear":
      return { ...initialState(state), input: state.input };
    case "exit":
      return state;
    case "event": {
      const ev = action.event;
      switch (ev.type) {
        case "message": {
          const text = ev.content.filter(isTextBlock).map((b) => b.text).join("");
          const reasoningFromBlocks = ev.content
            .filter((b): b is { type: "reasoning"; text: string } => b.type === "reasoning")
            .map((b) => b.text)
            .join("");
          const toolUses = ev.content.filter(isToolUseBlock);
          const toolResults = ev.content.filter(isToolResultBlock);
          if (ev.role === "user") {
 // Core notifies a placeholder bubble first and re-sends the final
 // content under the same id, so upsert rather than append.
            const at = state.rows.findIndex((r) => r.kind === "user" && r.id === ev.id);
            const userRow = {
              kind: "user" as const,
              id: ev.id,
              text,
              ...(ev.steer ? { steer: true as const } : {}),
            };
            if (at >= 0) {
              const rows = state.rows.slice();
              rows[at] = userRow;
              return { ...state, rows };
            }
            return {
              ...state,
              rows: [...state.rows, userRow],
            };
          }
 // Assistant final message: either update the streaming row in place
 // or append a new one if no delta preceded it.
          const newMsg: MessageRow = {
            id: ev.id,
            role: "assistant",
            text,
            ...(reasoningFromBlocks ? { reasoning: reasoningFromBlocks } : {}),
            blocks: ev.content,
            model: ev.model,
            streaming: false,
          };
          const rows = state.rows.slice();
 // Replace the last streaming assistant (if any) with the final version.
          let replaced = false;
          const same = rows.findIndex((r) => r.kind === "assistant" && r.msg.id === ev.id);
          if (same >= 0) {
            const prev = rows[same] as Extract<Row, { kind: "assistant" }>;
            rows[same] = { kind: "assistant", msg: { ...newMsg, reasoning: reasoningFromBlocks || prev.msg.reasoning || newMsg.reasoning } };
            replaced = true;
          }
          for (let i = rows.length - 1; i >= 0 && !replaced; i--) {
            const r = rows[i]!;
            if (r.kind === "assistant" && r.msg.streaming) {
 // Prefer persisted reasoning blocks; fall back to streamed deltas.
              rows[i] = {
                kind: "assistant",
                msg: {
                  ...newMsg,
                  reasoning: reasoningFromBlocks || r.msg.reasoning || newMsg.reasoning,
                },
              };
              replaced = true;
              break;
            }
            if (r.kind === "assistant" || r.kind === "user" || r.kind === "tool" || r.kind === "plan" || r.kind === "system") {
              break;
            }
          }
          if (!replaced) rows.push({ kind: "assistant", msg: newMsg });
 // Inline tool_use blocks become tool rows so the user sees them
 // even when the provider didn't emit standalone tool_call events.
          for (const t of toolUses) {
            const id = t.id;
            const exists = rows.some(
              (r) => r.kind === "tool" && r.tool.id === id,
            );
            if (!exists) {
              rows.push({ kind: "tool", tool: newToolRow(id, t.name, t.input, ev.ts) });
            }
          }
          for (const tr of toolResults) {
            const at = rows.findIndex((r) => r.kind === "tool" && r.tool.id === tr.toolCallId);
            if (at >= 0) {
              const prev = rows[at] as Extract<Row, { kind: "tool" }>;
              if (prev.tool.status === "running") rows[at] = { kind: "tool", tool: finishToolRow(prev.tool, tr, ev.ts) };
              continue;
            }
            rows.push({
              kind: "tool",
              tool: {
                id: tr.toolCallId,
                name: "(tool result)",
                inputSummary: "",
                category: "other",
                target: "",
                resultText: tr.content,
                resultIsError: tr.isError,
                artifactRef: tr.artifactRef,
                status: tr.isError ? "error" : "ok",
              },
            });
          }
          return { ...state, rows };
        }
        case "message_delta": {
          const d = ev.delta;
          if (d.type === "text" || d.type === "reasoning") {
 // Fold into the currently streaming assistant row, creating one
 // if needed. Text and reasoning share the same row.
 // Clear transient retry banners (e.g. HTTP 429) once the stream resumes.
            const rows = clearTransientRetryRows(state.rows.slice());
            let at = -1;
            for (let i = rows.length - 1; i >= 0; i--) {
              const r = rows[i]!;
              if (r.kind === "assistant" && r.msg.streaming) {
                at = i;
                break;
              }
            }
            if (at < 0) {
              rows.push({ kind: "assistant", msg: { id: ev.messageId, role: "assistant", text: "", streaming: true } });
              at = rows.length - 1;
            }
            const cur = (rows[at] as Extract<Row, { kind: "assistant" }>).msg;
            rows[at] = {
              kind: "assistant",
              msg:
                d.type === "reasoning"
                  ? { ...cur, reasoning: (cur.reasoning ?? "") + d.text }
                  : { ...cur, text: cur.text + d.text },
            };
            return { ...state, rows, status: "thinking" };
          }
 // tool_input_json deltas update the running tool row's input summary.
          return state;
        }
        case "tool_call": {
          const exists = state.rows.some(
            (r) => r.kind === "tool" && r.tool.id === ev.id,
          );
          if (exists) return state;
          return {
            ...state,
            rows: [
              ...clearTransientRetryRows(state.rows),
              { kind: "tool", tool: newToolRow(ev.id, ev.name, ev.input, ev.ts) },
            ],
          };
        }
        case "tool_result": {
          const rows = clearTransientRetryRows(state.rows.slice());
          for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i]!;
            if (r.kind === "tool" && r.tool.id === ev.toolCallId) {
              rows[i] = { kind: "tool", tool: finishToolRow(r.tool, ev, ev.ts) };
              return { ...state, rows, status: state.busy ? "thinking" : state.status };
            }
          }
          rows.push({
            kind: "tool",
            tool: {
              id: ev.toolCallId,
              name: ev.name,
              inputSummary: "",
              category: toolCategory(ev.name),
              target: "",
              resultText: ev.content,
              resultIsError: ev.isError,
              artifactRef: ev.artifactRef,
              status: ev.isError ? "error" : "ok",
            },
          });
          return { ...state, rows };
        }
        case "plan":
          return {
            ...state,
            plan: ev.steps,
            rows: [
              ...state.rows,
              { kind: "plan", plan: ev.steps, at: Date.now() },
            ],
          };
        case "usage":
          return {
            ...state,
            usage: addUsage(state.usage, ev.usage),
            rows: [
              ...state.rows,
              { kind: "usage", usage: ev.usage, at: Date.now() },
            ],
          };
        case "compaction":
          return {
            ...state,
            rows: [
              ...state.rows,
              { kind: "compaction", summary: ev.summary, at: Date.now() },
            ],
          };
        case "team_message":
          return {
            ...state,
            rows: [
              ...state.rows,
              {
                kind: "team",
                from: ev.from,
                to: ev.to,
                text: ev.content,
                msgKind: ev.kind,
                at: ev.timestamp,
              },
            ],
          };
        case "activity":
          return { ...state, activity: { phase: ev.phase, since: ev.since, tools: ev.tools } };
        case "turn_budget":
          return {
            ...state,
            turnBudget: {
              turn: ev.turn,
              windDownAt: ev.windDownAt,
              maxTurns: ev.maxTurns,
              stalledTurns: ev.stalledTurns,
              ...(ev.warning ? { warning: true } : {}),
            },
          };
        case "stop_continue": {
          const short =
            ev.reason.length > 120 ? `${ev.reason.slice(0, 117)}…` : ev.reason;
          return {
            ...state,
            notice: `Verifying… continuing (${ev.count}/${ev.cap}): ${short}`,
            status: "thinking",
          };
        }
        case "provider_failover":
          // Observational: the chain switched to a backup provider. Surface a
          // transient notice (no sticky row) so the user sees which served the
          // turn and why.
          return {
            ...state,
            notice: `Switched provider: ${ev.from} → ${ev.to} (${ev.failureKind})`,
          };
        case "subagent": {
          const at = state.rows.findIndex((r) => r.kind === "tool" && r.tool.id === ev.parentToolCallId);
          let rows = state.rows;
          if (at >= 0) {
            rows = state.rows.slice();
            rows[at] = { kind: "tool", tool: applySubagent((rows[at] as Extract<Row, { kind: "tool" }>).tool, ev) };
          }
          if (ev.event?.type !== "tool_call") return rows === state.rows ? state : { ...state, rows };
          // Unique, stable label: the session-global runSeq (falls back to the
          // per-fan-out index) plus a short slice of the sub-agent's id, so
          // repeated single-task dispatches no longer all read as "#1".
          const seq = ev.runSeq ?? ev.index + 1;
          const idShort = ev.sessionId ? ` ${ev.sessionId.slice(-6)}` : "";
          return {
            ...state,
            rows,
            activity: {
              phase: "tools",
              since: state.activity?.since ?? Date.now(),
              tools: [`task #${seq}${idShort} → ${ev.event.name}`],
            },
          };
        }
        case "status":
          return {
            ...state,
            activity: ev.status === "idle" ? undefined : state.activity,
            turnBudget: ev.status === "idle" ? undefined : state.turnBudget,
            status:
              ev.status === "idle"
                ? "idle"
                : ev.status === "running"
                ? state.status === "waiting_permission" ? state.status : "thinking"
                : ev.status === "waiting_permission"
                ? "waiting_permission"
                : "compacting",
          };
        case "error":
          return {
            ...state,
            rows: [
              ...state.rows,
              { kind: "error", message: ev.message, recoverable: ev.recoverable, at: Date.now() },
            ],
          };
        case "retry": {
 // The failed attempt's partial output is replayed by the retry;
 // drop it so the transcript does not show the same step twice.
          const discard = new Set(ev.discardToolCallIds ?? []);
          const rows = state.rows.filter(
            (r) =>
              !(r.kind === "assistant" && ev.discardMessageId !== undefined && r.msg.id === ev.discardMessageId) &&
              !(r.kind === "tool" && discard.has(r.tool.id)),
          );
          while (rows.length > 0 && rows[rows.length - 1]!.kind === "retry") rows.pop();
          rows.push({
            kind: "retry",
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts,
            delayMs: ev.delayMs,
            reason: ev.reason,
            at: Date.now(),
          });
          return { ...state, rows, status: "thinking" };
        }
        case "mode":
 // Core pushed a mode change (e.g. via Session.setAgentMode, including
 // changes triggered by remote/CLI clients). Mirror it locally so the
 // StatusBar and any downstream UI stay in sync.
          return {
            ...state,
            agentMode: ev.mode,
            notice: `Collaboration mode: ${ev.mode}`,
          };
        case "model":
          return {
            ...state,
            model: ev.model,
            providerId: ev.providerId ?? state.providerId,
            notice: ev.providerId
              ? `Model → ${ev.providerId} · ${ev.model}`
              : `Model → ${ev.model}`,
          };
        case "mode_request":
 // plan_done was approved by the user; the session has already
 // switched modes, so mirror it here.
          return {
            ...state,
            agentMode: ev.mode,
            notice: `Plan approved — switching to ${ev.mode} mode`,
          };
        case "goal_progress": {
 // Live per-round progress of an active goal loop. We keep ONE durable
 // transcript row for the loop (so a model-initiated goal via `start_goal`
 // is unmistakable and persists in scrollback), updating it each round,
 // plus a compact notice for the status bar. The authoritative record is
 // the checkpoint file.
          const detail =
            ev.status === "completed"
              ? ev.reason
              : ev.status === "blocked"
                ? ev.blockedReason ?? ev.reason
                : ev.status === "round_limit"
                  ? ev.reason
                  : undefined;
          const goalRows = state.rows.slice();
          let goalIdx = -1;
          for (let i = goalRows.length - 1; i >= 0; i--) {
            const r = goalRows[i]!;
            if (r.kind === "goal" && r.status === "running") {
              goalIdx = i;
              break;
            }
          }
          const goalRow: Extract<Row, { kind: "goal" }> = {
            kind: "goal",
            round: ev.round,
            ...(ev.maxRounds !== undefined ? { maxRounds: ev.maxRounds } : {}),
            status: ev.status,
            ...(detail !== undefined ? { detail } : {}),
            at: Date.now(),
          };
          if (goalIdx >= 0) goalRows[goalIdx] = goalRow;
          else goalRows.push(goalRow);
          const cap = ev.maxRounds ? `/${ev.maxRounds}` : "";
          const tail =
            ev.status === "running"
              ? "running…"
              : ev.status === "completed"
                ? `completed${ev.reason ? ` — ${ev.reason}` : ""}`
                : ev.status === "blocked"
                  ? `blocked${ev.blockedReason ? ` — ${ev.blockedReason}` : ""}`
                  : `round limit${ev.reason ? ` — ${ev.reason}` : ""}`;
          return {
            ...state,
            rows: goalRows,
            notice: `Goal · round ${ev.round}${cap} · ${tail}`,
          };
        }
        case "edit_delta": {
 // Live edit progress from edit_file (multi-edit / large file). The
 // tool_result still carries the authoritative summary; this is a
 // transient hint for batches.
          if (ev.total <= 1) return state;
          const name = ev.path.split("/").pop() ?? ev.path;
          return {
            ...state,
            notice: `Editing ${name} · ${ev.index + 1}/${ev.total}`,
          };
        }
        case "interrupted_run": {
 // A prior run for this session was interrupted (crash / daemon kill) and
 // sealed to a clean idle. Advisory only — surface a notice so the user
 // knows they can continue.
          const sealed =
            ev.sealedToolCalls > 0
              ? ` (sealed ${ev.sealedToolCalls} tool call${ev.sealedToolCalls === 1 ? "" : "s"})`
              : "";
          return {
            ...state,
            notice: `Previous run was interrupted — you can continue${sealed}`,
          };
        }
        case "content_replacement":
 // A large payload was offloaded to the artifact store (durable audit
 // record for fork/GC). Non-model, nothing for the user to act on — the
 // owning tool row already shows the stub + ref, so render it quietly.
          return state;
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

/** Drop in-flight retry / rate-limit banners once the turn has resumed. */
function clearTransientRetryRows(rows: TuiState["rows"]): TuiState["rows"] {
  let end = rows.length;
  while (end > 0) {
    const r = rows[end - 1]!;
    if (r.kind === "retry") {
      end--;
      continue;
    }
    if (
      r.kind === "error" &&
      r.recoverable &&
      /\b429\b|rate.?limit|too many requests|overloaded|sustaining heavy rate-limiting/i.test(r.message)
    ) {
      end--;
      continue;
    }
    break;
  }
  return end === rows.length ? rows : rows.slice(0, end);
}