/**
 * TUI state model + reducer.
 *
 * The TUI keeps a *normalized* event log plus per-message streaming buffers.
 * On every incoming core `Event`, we dispatch a `TuiAction`; the reducer
 * produces the next `TuiState` which drives the renderer.
 *
 * Why a reducer (vs. mutating in effects)?
 * - Streaming `message_delta` events must fold into the current message
 * without rebuilding the entire event log.
 * - The same logic is testable in isolation.
 */
import type {
  AgentMode,
  ContentBlock,
  Event,
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
}

/** UI status derived from core status events + our own knowledge. */
export type UiStatus = "idle" | "thinking" | "executing" | "compacting" | "waiting_permission" | "waiting_question";

/** A pending permission request the user must resolve. */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string;
}

export interface TuiState {
  sessionId: string | undefined;
  cwd: string;
  model: string | undefined;
 /** Named provider preset id when known. */
  providerId?: string;
  permissionMode: "ask" | "auto-edit" | "yolo";
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
}

export type Row =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; msg: MessageRow }
  | { kind: "tool"; tool: ToolRow }
  | { kind: "plan"; plan: PlanStep[]; at: number }
  | { kind: "compaction"; summary: string; at: number }
  | { kind: "usage"; usage: UsageInfo; at: number }
  | { kind: "error"; message: string; recoverable: boolean; at: number }
  | { kind: "system"; text: string; at: number }
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

function newToolRow(id: string, name: string, input: unknown): ToolRow {
  return {
    id,
    name,
    inputSummary: summarizeInput(name, input),
    category: toolCategory(name),
    target: toolTarget(input),
    ...changeCounts(name, input),
    status: "running",
    startedAt: Date.now(),
  };
}

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
          const toolUses = ev.content.filter(isToolUseBlock);
          const toolResults = ev.content.filter(isToolResultBlock);
          if (ev.role === "user") {
            return {
              ...state,
              rows: [...state.rows, { kind: "user", id: ev.id, text }],
            };
          }
 // Assistant final message: either update the streaming row in place
 // or append a new one if no delta preceded it.
          const newMsg: MessageRow = {
            id: ev.id,
            role: "assistant",
            text,
            blocks: ev.content,
            model: ev.model,
            streaming: false,
          };
          const rows = state.rows.slice();
 // Replace the last streaming assistant (if any) with the final version.
          let replaced = false;
          for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i]!;
            if (r.kind === "assistant" && r.msg.streaming) {
 // Carry over reasoning accumulated from deltas — the terminal
 // `message` event only carries the visible answer.
              rows[i] = { kind: "assistant", msg: { ...newMsg, reasoning: r.msg.reasoning ?? newMsg.reasoning } };
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
              rows.push({ kind: "tool", tool: newToolRow(id, t.name, t.input) });
            }
          }
          for (const tr of toolResults) {
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
            let target: MessageRow | undefined;
            for (let i = rows.length - 1; i >= 0; i--) {
              const r = rows[i]!;
              if (r.kind === "assistant" && r.msg.streaming) {
                target = r.msg;
                break;
              }
            }
            if (target === undefined) {
              const fresh: MessageRow = {
                id: ev.messageId,
                role: "assistant",
                text: "",
                streaming: true,
              };
              rows.push({ kind: "assistant", msg: fresh });
              target = fresh;
            }
            if (d.type === "reasoning") target.reasoning = (target.reasoning ?? "") + d.text;
            else target.text += d.text;
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
              { kind: "tool", tool: newToolRow(ev.id, ev.name, ev.input) },
            ],
          };
        }
        case "tool_result": {
          const rows = clearTransientRetryRows(state.rows.slice());
          for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i]!;
            if (r.kind === "tool" && r.tool.id === ev.toolCallId) {
              rows[i] = {
                kind: "tool",
                tool: {
                  ...r.tool,
                  resultText: ev.content,
                  resultIsError: ev.isError,
                  artifactRef: ev.artifactRef,
                  status: ev.isError ? "error" : "ok",
                  finishedAt: Date.now(),
                },
              };
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
        case "stop_continue": {
          const short =
            ev.reason.length > 120 ? `${ev.reason.slice(0, 117)}…` : ev.reason;
          return {
            ...state,
            notice: `Verifying… continuing (${ev.count}/${ev.cap}): ${short}`,
            status: "thinking",
          };
        }
        case "subagent":
          if (ev.event?.type !== "tool_call") return state;
          return {
            ...state,
            activity: {
              phase: "tools",
              since: state.activity?.since ?? Date.now(),
              tools: [`task #${ev.index + 1} → ${ev.event.name}`],
            },
          };
        case "status":
          return {
            ...state,
            activity: ev.status === "idle" ? undefined : state.activity,
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