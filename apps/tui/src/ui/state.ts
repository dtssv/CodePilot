/**
 * TUI state model + reducer.
 *
 * The TUI keeps a *normalized* event log plus per-message streaming buffers.
 * On every incoming core `Event`, we dispatch a `TuiAction`; the reducer
 * produces the next `TuiState` which drives the renderer.
 *
 * Why a reducer (vs. mutating in effects)?
 *  - Streaming `message_delta` events must fold into the current message
 *    without rebuilding the entire event log.
 *  - The same logic is testable in isolation.
 */
import type {
  ContentBlock,
  Event,
  PlanStep,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  UsageInfo,
} from "@codepilot/core";

/** Per-message render state. */
export interface MessageRow {
  id: string;
  role: "user" | "assistant";
  /** Aggregated text so far. For assistant rows this grows as deltas arrive. */
  text: string;
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
  /** Full result text (may be large — UI can collapse). */
  resultText?: string;
  resultIsError?: boolean;
  artifactRef?: string;
  status: "running" | "ok" | "error";
}

/** UI status derived from core status events + our own knowledge. */
export type UiStatus = "idle" | "thinking" | "executing" | "compacting" | "waiting_permission";

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
  permissionMode: "ask" | "auto-edit" | "yolo";
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
  /** True while a prompt is in flight (between prompt() and the next status:idle). */
  busy: boolean;
  /** Last system message, used for ephemeral notices. */
  notice: string | undefined;
  /** Session list (populated by /sessions). */
  sessions: { id: string; title: string; updatedAt: number; cwd: string }[];
}

export type Row =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; msg: MessageRow }
  | { kind: "tool"; tool: ToolRow }
  | { kind: "plan"; plan: PlanStep[]; at: number }
  | { kind: "compaction"; summary: string; at: number }
  | { kind: "usage"; usage: UsageInfo; at: number }
  | { kind: "error"; message: string; recoverable: boolean; at: number }
  | { kind: "system"; text: string; at: number };

export type TuiAction =
  | { type: "init"; sessionId: string | undefined; cwd: string; model: string | undefined; permissionMode: TuiState["permissionMode"] }
  | { type: "event"; event: Event }
  | { type: "set-input"; value: string }
  | { type: "permission-pending"; req: PendingPermission }
  | { type: "permission-resolve" }
  | { type: "set-status"; status: UiStatus }
  | { type: "set-busy"; busy: boolean }
  | { type: "set-notice"; text: string | undefined }
  | { type: "set-plan"; plan: PlanStep[] }
  | { type: "set-model"; model: string | undefined }
  | { type: "set-mode"; mode: TuiState["permissionMode"] }
  | { type: "set-sessions"; sessions: TuiState["sessions"] }
  | { type: "clear" }
  | { type: "exit" };

const emptyUsage: UsageInfo = { input: 0, output: 0 };

export function initialState(opts: {
  sessionId: string | undefined;
  cwd: string;
  model: string | undefined;
  permissionMode: TuiState["permissionMode"];
}): TuiState {
  return {
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
    status: "idle",
    rows: [],
    plan: undefined,
    usage: { ...emptyUsage },
    input: "",
    permission: undefined,
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
      return { ...state, model: action.model };
    case "set-mode":
      return { ...state, permissionMode: action.mode };
    case "set-sessions":
      return { ...state, sessions: action.sessions };
    case "permission-pending":
      return { ...state, permission: action.req, status: "waiting_permission" };
    case "permission-resolve":
      return { ...state, permission: undefined };
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
              rows[i] = { kind: "assistant", msg: newMsg };
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
              rows.push({
                kind: "tool",
                tool: {
                  id,
                  name: t.name,
                  inputSummary: summarizeInput(t.name, t.input),
                  status: "running",
                },
              });
            }
          }
          for (const tr of toolResults) {
            rows.push({
              kind: "tool",
              tool: {
                id: tr.toolCallId,
                name: "(tool result)",
                inputSummary: "",
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
          if (d.type === "text") {
            // Fold into the currently streaming assistant row, creating one
            // if needed.
            const rows = state.rows.slice();
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
            target.text += d.text;
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
              ...state.rows,
              {
                kind: "tool",
                tool: {
                  id: ev.id,
                  name: ev.name,
                  inputSummary: summarizeInput(ev.name, ev.input),
                  status: "running",
                },
              },
            ],
          };
        }
        case "tool_result": {
          const rows = state.rows.slice();
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
        case "status":
          return {
            ...state,
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
      }
    }
  }
}