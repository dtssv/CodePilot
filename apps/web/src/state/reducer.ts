// Transcript state machine: protocol events in, rows out.
//
// Kept as a pure reducer (no React, no client) so the interesting behaviour —
// delta accumulation, tool pairing, status transitions, usage totals — is
// testable without a browser. `App.tsx` is a thin `useReducer` over this.

import type { AgentMode, Event, FollowUpItem, PlanStep, UsageInfo } from "@codepilot/core";
import { fileChangeFromToolCall, isFileMutation } from "./diff.js";
import { messageText, type Row } from "./rows.js";
import type { PendingPermission, PendingQuestion } from "../protocol/client.js";
import { t } from "../i18n.js";

export type UiStatus = "idle" | "thinking" | "waiting_permission" | "waiting_question" | "compacting";

export interface AppState {
  connection: "disconnected" | "connecting" | "connected";
 /** Attempt counter while automatic reconnect is underway. */
  reconnectAttempt?: number;
 /** Set while disconnected or after a failure. */
  connectionError?: string;
  sessionId?: string;
  cwd: string;
  model?: string;
 /** Named provider preset id when known (cross-vendor picker). */
  providerId?: string;
  agentMode: AgentMode;
  status: UiStatus;
  rows: Row[];
  plan: PlanStep[];
  usage: UsageInfo;
  permission?: PendingPermission;
  question?: PendingQuestion;
 /** Banner text for transient notices (mode switches, forks, errors). */
  notice?: string;
 /** Timing of the most recent LLM request (from the core `request` event),
 * surfaced so the UI can show how long the last turn took. */
  lastRequest?: { durationMs: number; ttftMs?: number; inputTokens?: number; outputTokens?: number };
 /** What the running turn is waiting on right now (model vs tools). */
  activity?: Activity;
 /** Sub-agents spawned by `task` calls, keyed by the parent tool call id. */
  subagents?: Record<string, SubagentRun[]>;
 /** Every unanswered prompt, across sessions, oldest first. `permission`
 * and `question` are the head of the queue for the session on screen —
 * parallel tool calls raise several at once, and other sessions' prompts
 * wait here until the user switches back to them. */
  pending?: PendingPrompts;
  sessions: { id: string; title: string; updatedAt: number; cwd: string }[];
 /** Follow-up prompts waiting while the current run is busy. */
  followUps?: FollowUpItem[];
}

export interface SubagentRun {
  index: number;
  objective: string;
  state: "running" | "ok" | "failed";
 /** The sub-agent's own transcript, reduced like a session. */
  view: AppState;
}

export interface Activity {
  phase: "model" | "tools";
  since: number;
  tools?: string[];
}

export type Action =
  | { type: "connecting" }
  | { type: "connected"; cwd: string; modes: AgentMode[] }
  | { type: "disconnected"; error?: string }
  | { type: "reconnecting"; attempt: number }
  | { type: "reconnected" }
  | { type: "session-opened"; sessionId: string; agentMode: AgentMode; history?: Event[] }
  | { type: "event"; event: Event }
  | { type: "sending" }
  | { type: "permission"; req: PendingPermission }
  | { type: "permission-resolved"; requestId?: string }
  | { type: "question"; req: PendingQuestion }
  | { type: "question-resolved"; requestId?: string }
  | { type: "sessions"; sessions: AppState["sessions"] }
  | { type: "notice"; text?: string }
  | { type: "agent-mode"; mode: AgentMode }
  | { type: "endpoint"; model: string; providerId?: string }
  | { type: "set-cwd"; cwd: string }
  | { type: "session-closed" };

export function initialState(cwd = ""): AppState {
  return {
    connection: "disconnected",
    cwd,
    agentMode: "agent",
    status: "idle",
    rows: [],
    plan: [],
    usage: { input: 0, output: 0 },
    sessions: [],
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "connecting":
      return { ...state, connection: "connecting", connectionError: undefined, reconnectAttempt: undefined };
    case "connected":
      return {
        ...state,
        connection: "connected",
        connectionError: undefined,
        reconnectAttempt: undefined,
        cwd: action.cwd,
      };
    case "disconnected":
      return {
        ...state,
        connection: "disconnected",
        connectionError: action.error,
 // Keep rows: a dropped socket should not erase the transcript the
 // user is reading. `session/resume` refills it on reconnect.
        status: "idle",
        permission: undefined,
        question: undefined,
        pending: undefined,
      };
    case "reconnecting":
      return { ...state, connection: "connecting", reconnectAttempt: action.attempt };
    case "reconnected":
      return { ...state, connection: "connected", reconnectAttempt: undefined, connectionError: undefined };
    case "session-opened": {
      const base: AppState = {
        ...state,
        sessionId: action.sessionId,
        agentMode: action.agentMode,
        status: "idle",
        activity: undefined,
        rows: [],
        plan: [],
        usage: { input: 0, output: 0 },
        subagents: undefined,
        permission: undefined,
        question: undefined,
      };
 // Replaying history through the same reducer keeps resumed sessions and
 // live ones on exactly one code path.
      const replayed = (action.history ?? []).reduce(
        (acc, event) => reducer(acc, { type: "event", event }),
        base,
      );
      return showPrompts(replayed, state.pending, false);
    }
 // The prompt itself is not added here: `agent.ts` appends the user message
 // to the transcript, so it arrives as an `event` like everything else.
 // Adding an optimistic row too would show every prompt twice.
    case "sending":
      return { ...state, status: "thinking", notice: undefined };
    case "permission": {
      const q = pendingOf(state);
      const permissions = [...q.permissions.filter((p) => p.requestId !== action.req.requestId), action.req];
      return showPrompts(state, { ...q, permissions });
    }
    case "permission-resolved": {
      const id = action.requestId ?? state.permission?.requestId;
      const q = pendingOf(state);
      return showPrompts(state, { ...q, permissions: q.permissions.filter((p) => p.requestId !== id) });
    }
    case "question": {
      const q = pendingOf(state);
      const questions = [...q.questions.filter((x) => x.requestId !== action.req.requestId), action.req];
      return showPrompts(state, { ...q, questions });
    }
    case "question-resolved": {
      const id = action.requestId ?? state.question?.requestId;
      const q = pendingOf(state);
      return showPrompts(state, { ...q, questions: q.questions.filter((x) => x.requestId !== id) });
    }
    case "sessions":
      return { ...state, sessions: action.sessions };
    case "notice":
      return { ...state, notice: action.text };
    case "agent-mode":
      return { ...state, agentMode: action.mode };
    case "endpoint":
      return {
        ...state,
        model: action.model,
        providerId: action.providerId ?? state.providerId,
      };
    case "set-cwd":
      return { ...state, cwd: action.cwd };
    case "session-closed": {
 // Drop prompts that belonged to the session we just left; keep any
 // parked prompts from other sessions for when the user returns.
      const closedId = state.sessionId;
      const pending = state.pending
        ? {
            permissions: state.pending.permissions.filter((p) => p.sessionId !== closedId),
            questions: state.pending.questions.filter((x) => x.sessionId !== closedId),
          }
        : undefined;
      return {
        ...state,
        sessionId: undefined,
        model: undefined,
        providerId: undefined,
        status: "idle",
        rows: [],
        plan: [],
        usage: { input: 0, output: 0 },
        activity: undefined,
        subagents: undefined,
        followUps: undefined,
        lastRequest: undefined,
        permission: undefined,
        question: undefined,
        pending,
      };
    }
    case "event":
      return applyEvent(state, action.event);
  }
}

interface PendingPrompts {
  permissions: PendingPermission[];
  questions: PendingQuestion[];
}

function pendingOf(state: AppState): PendingPrompts {
  return state.pending ?? { permissions: [], questions: [] };
}

/** Point `permission` / `question` at the oldest prompt of the session on
 * screen and derive the waiting status from them. `live` is false while a
 * session is being opened: its status then comes from the replayed history.
 * With no session open, never surface a parked prompt (switching workspace
 * mid-run must not pop the previous session's approval dialog). */
function showPrompts(state: AppState, pending: PendingPrompts | undefined, live = true): AppState {
  const q = pending ?? { permissions: [], questions: [] };
  const mine = (sessionId: string): boolean =>
    Boolean(state.sessionId) && sessionId === state.sessionId;
  const permission = q.permissions.find((p) => mine(p.sessionId));
  const question = q.questions.find((x) => mine(x.sessionId));
  const waiting = state.status === "waiting_permission" || state.status === "waiting_question";
  const status = permission
    ? "waiting_permission"
    : question
      ? "waiting_question"
      : live && waiting
        ? "thinking"
        : state.status;
  return { ...state, pending: q, permission, question, status };
}

function applySubagent(state: AppState, e: Extract<Event, { type: "subagent" }>): AppState {
  const runs = [...(state.subagents?.[e.parentToolCallId] ?? [])];
  let i = runs.findIndex((r) => r.index === e.index);
  if (i < 0) {
    runs.push({ index: e.index, objective: e.objective, state: "running", view: initialState(state.cwd) });
    runs.sort((a, b) => a.index - b.index);
    i = runs.findIndex((r) => r.index === e.index);
  }
  const run = runs[i]!;
  runs[i] = {
    ...run,
    state: e.state ?? run.state,
    view: e.event ? applyEvent(run.view, e.event) : run.view,
  };
  return { ...state, subagents: { ...state.subagents, [e.parentToolCallId]: runs } };
}

function applyEvent(state: AppState, e: Event): AppState {
 // Prefer the event's own timestamp (persisted by the agent loop) so a
 // replayed session shows original times, not the replay moment. Falls back
 // to now for events without one (status/usage/etc.).
  const at = (e as { ts?: number }).ts ?? Date.now();
  switch (e.type) {
    case "message_delta": {
      if (e.delta.type === "reasoning") {
        const rows = [...state.rows];
        const idx = findStreamingMessage(rows, e.messageId);
        if (idx >= 0) {
          const row = rows[idx] as Extract<Row, { kind: "message" }>;
          rows[idx] = {
            ...row,
            msg: {
              ...row.msg,
              reasoning: (row.msg.reasoning ?? "") + e.delta.text,
              firstTokenAt: row.msg.firstTokenAt ?? at,
            },
          };
        } else {
          rows.push({
            kind: "message",
            at,
            msg: {
              id: e.messageId,
              role: "assistant",
              text: "",
              reasoning: e.delta.text,
              streaming: true,
              firstTokenAt: at,
            },
          });
        }
        return { ...state, rows, status: "thinking" };
      }
      if (e.delta.type !== "text") return state; // tool-input JSON is internal
      const rows = [...state.rows];
      const idx = findStreamingMessage(rows, e.messageId);
      if (idx >= 0) {
        const row = rows[idx] as Extract<Row, { kind: "message" }>;
        rows[idx] = {
          ...row,
          msg: {
            ...row.msg,
            text: row.msg.text + e.delta.text,
            firstTokenAt: row.msg.firstTokenAt ?? at,
          },
        };
      } else {
        rows.push({
          kind: "message",
          at,
          msg: {
            id: e.messageId,
            role: "assistant",
            text: e.delta.text,
            streaming: true,
            firstTokenAt: at,
          },
        });
      }
      return { ...state, rows, status: "thinking" };
    }

    case "message": {
      const text = messageText(e);
      const rows = [...state.rows];
      const idx = findStreamingMessage(rows, e.id);
      if (idx >= 0) {
        const row = rows[idx] as Extract<Row, { kind: "message" }>;
        rows[idx] = {
          ...row,
 // The terminal event carries the authoritative text; deltas may have
 // been dropped (reconnect mid-stream), so we replace rather than keep
 // whatever accumulated — unless it is empty (tool-only message).
          msg: {
            ...row.msg,
            text: text || row.msg.text,
            model: e.model ?? row.msg.model,
            streaming: false,
          },
        };
      } else if (text !== "" || e.images?.length || e.files?.length) {
        rows.push({
          kind: "message",
          at,
          msg: {
            id: e.id,
            role: e.role,
            text,
            images: e.images,
            files: e.files,
            model: e.model,
            streaming: false,
          },
        });
      }
      return { ...state, rows, model: e.model ?? state.model };
    }

    case "tool_call": {
      // Silent bookkeeping — keep out of the transcript.
      if (e.name === "memory_write") {
        return { ...state, status: "thinking" };
      }
      return {
        ...state,
        status: "thinking",
        rows: [
          ...state.rows,
          {
            kind: "tool",
            at,
            tool: {
              id: e.id,
              name: e.name,
              input: e.input,
              status: "running",
              change: isFileMutation(e.name)
                ? fileChangeFromToolCall(e.name, e.input)
                : null,
              startedAt: at,
            },
          },
        ],
      };
    }

    case "tool_result": {
      if (e.name === "memory_write") {
        return state;
      }
      const rows = [...state.rows];
      const idx = rows.findIndex(
        (r) => r.kind === "tool" && r.tool.id === e.toolCallId,
      );
      if (idx < 0) {
 // A result with no call in view (resumed mid-turn): show it standalone
 // rather than dropping the only record of what happened.
        rows.push({
          kind: "tool",
          at,
          tool: {
            id: e.toolCallId,
            name: e.name,
            input: undefined,
            status: e.isError ? "error" : "ok",
            result: e.content,
            artifactRef: e.artifactRef,
            images: e.images,
          },
        });
        return { ...state, rows };
      }
      const row = rows[idx] as Extract<Row, { kind: "tool" }>;
      rows[idx] = {
        ...row,
        tool: {
          ...row.tool,
          status: e.isError ? "error" : "ok",
          result: e.content,
          artifactRef: e.artifactRef,
          images: e.images,
          finishedAt: at,
        },
      };
      return { ...state, rows };
    }

    case "retry": {
 // The discarded attempt's partial text and never-executed tool calls
 // are dropped; the regenerated turn streams in fresh. Consecutive
 // retries replace each other so the transcript shows one notice.
      const dropTools = new Set(e.discardToolCallIds ?? []);
      const rows = state.rows.filter((r) => {
        if (r.kind === "message" && e.discardMessageId && r.msg.id === e.discardMessageId) return false;
        if (r.kind === "tool" && dropTools.has(r.tool.id)) return false;
        return true;
      });
      while (rows.length > 0 && rows[rows.length - 1]!.kind === "retry") rows.pop();
      rows.push({
        kind: "retry",
        at,
        retry: { attempt: e.attempt, maxAttempts: e.maxAttempts, delayMs: e.delayMs, reason: e.reason },
      });
      return { ...state, rows, status: "thinking" };
    }

    case "plan":
      return {
        ...state,
        plan: e.steps,
        rows: [...state.rows, { kind: "plan", at, steps: e.steps }],
      };

    case "usage":
      return {
        ...state,
        usage: addUsage(state.usage, e.usage),
        rows: [...state.rows, { kind: "usage", at, usage: e.usage }],
      };

    case "compaction":
      return {
        ...state,
        rows: [...state.rows, { kind: "compaction", at, summary: e.summary, foldKind: e.kind }],
      };

    case "error":
      return {
        ...state,
        status: e.recoverable ? state.status : "idle",
        rows: [
          ...state.rows,
          { kind: "error", at, message: e.message, recoverable: e.recoverable },
        ],
      };

    case "activity": {
      const tools = e.tools?.filter((n) => n !== "memory_write");
      return {
        ...state,
        activity: {
          phase: e.phase,
          since: e.since,
          tools: tools && tools.length > 0 ? tools : undefined,
        },
      };
    }

    case "stop_continue": {
      const short =
        e.reason.length > 160 ? `${e.reason.slice(0, 157)}…` : e.reason;
      return {
        ...state,
        notice: `${t("Verifying… continuing")} (${e.count}/${e.cap}): ${short}`,
        status: "thinking",
      };
    }

    case "followup":
      return { ...state, followUps: e.items };

    case "status":
      return {
        ...state,
        activity: e.status === "idle" ? undefined : state.activity,
        status:
          e.status === "idle"
            ? "idle"
            : e.status === "compacting"
              ? "compacting"
              : e.status === "waiting_permission"
                ? "waiting_permission"
                : // "running": don't clobber a dialog that is already up.
                  state.status === "waiting_permission" ||
                    state.status === "waiting_question"
                  ? state.status
                  : "thinking",
      };

    case "mode":
      return {
        ...state,
        agentMode: e.mode,
        notice: `mode → ${e.mode}`,
        rows: [...state.rows, { kind: "mode", at, mode: e.mode }],
      };

    case "model":
      return {
        ...state,
        model: e.model,
        providerId: e.providerId ?? state.providerId,
        notice: e.providerId
          ? `model → ${e.providerId} · ${e.model}`
          : `model → ${e.model}`,
      };

    case "mode_request":
      return {
        ...state,
        notice: `agent asked for ${e.mode} mode${e.reason ? `: ${e.reason}` : ""}`,
      };

    case "team_message":
      return {
        ...state,
        rows: [
          ...state.rows,
          {
            kind: "team",
            at: e.timestamp,
            team: {
              from: e.from,
              to: e.to,
              text: e.content,
              kind: e.kind ?? "msg",
              at: e.timestamp,
            },
          },
        ],
      };

    case "subagent":
      return applySubagent(state, e);

    case "request":
 // Per-request timing metadata. Not a transcript row — just record the
 // latest timing for optional display. Never mutates rows.
      return {
        ...state,
        lastRequest: {
          durationMs: e.durationMs,
          ttftMs: e.ttftMs,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
        },
      };

    default:
 // Unknown / future event types must never corrupt the store. Returning
 // the state unchanged keeps the reducer total — a missing case used to
 // return undefined, which then crashed the next event at `state.rows`.
      return state;
  }
}

/** Index of the row holding this streaming message, or -1. */
function findStreamingMessage(rows: Row[], id: string): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.kind === "message" && r.msg.id === id) return i;
  }
  return -1;
}

export function addUsage(a: UsageInfo, b: UsageInfo): UsageInfo {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: sumOptional(a.cacheRead, b.cacheRead),
    cacheWrite: sumOptional(a.cacheWrite, b.cacheWrite),
    costUSD: sumOptional(a.costUSD, b.costUSD),
  };
}

function sumOptional(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}