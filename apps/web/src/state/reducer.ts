// Transcript state machine: protocol events in, rows out.
//
// Kept as a pure reducer (no React, no client) so the interesting behaviour —
// delta accumulation, tool pairing, status transitions, usage totals — is
// testable without a browser. `App.tsx` is a thin `useReducer` over this.

import type { AgentMode, Event, PlanStep, UsageInfo } from "@codepilot/core";
import { fileChangeFromToolCall, isFileMutation } from "./diff.js";
import { messageText, type Row } from "./rows.js";
import type { PendingPermission, PendingQuestion } from "../protocol/client.js";

export type UiStatus = "idle" | "thinking" | "waiting_permission" | "waiting_question" | "compacting";

export interface AppState {
  connection: "disconnected" | "connecting" | "connected";
  /** Set while disconnected or after a failure. */
  connectionError?: string;
  sessionId?: string;
  cwd: string;
  model?: string;
  agentMode: AgentMode;
  status: UiStatus;
  rows: Row[];
  plan: PlanStep[];
  usage: UsageInfo;
  permission?: PendingPermission;
  question?: PendingQuestion;
  /** Banner text for transient notices (mode switches, forks, errors). */
  notice?: string;
  sessions: { id: string; title: string; updatedAt: number; cwd: string }[];
}

export type Action =
  | { type: "connecting" }
  | { type: "connected"; cwd: string; modes: AgentMode[] }
  | { type: "disconnected"; error?: string }
  | { type: "session-opened"; sessionId: string; agentMode: AgentMode; history?: Event[] }
  | { type: "event"; event: Event }
  | { type: "sending" }
  | { type: "permission"; req: PendingPermission }
  | { type: "permission-resolved" }
  | { type: "question"; req: PendingQuestion }
  | { type: "question-resolved" }
  | { type: "sessions"; sessions: AppState["sessions"] }
  | { type: "notice"; text?: string }
  | { type: "agent-mode"; mode: AgentMode };

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
      return { ...state, connection: "connecting", connectionError: undefined };
    case "connected":
      return {
        ...state,
        connection: "connected",
        connectionError: undefined,
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
      };
    case "session-opened": {
      const base: AppState = {
        ...state,
        sessionId: action.sessionId,
        agentMode: action.agentMode,
        status: "idle",
        rows: [],
        plan: [],
        usage: { input: 0, output: 0 },
        permission: undefined,
        question: undefined,
      };
      // Replaying history through the same reducer keeps resumed sessions and
      // live ones on exactly one code path.
      return (action.history ?? []).reduce(
        (acc, event) => reducer(acc, { type: "event", event }),
        base,
      );
    }
    // The prompt itself is not added here: `agent.ts` appends the user message
    // to the transcript, so it arrives as an `event` like everything else.
    // Adding an optimistic row too would show every prompt twice.
    case "sending":
      return { ...state, status: "thinking", notice: undefined };
    case "permission":
      return { ...state, permission: action.req, status: "waiting_permission" };
    case "permission-resolved":
      return { ...state, permission: undefined, status: "thinking" };
    case "question":
      return { ...state, question: action.req, status: "waiting_question" };
    case "question-resolved":
      return { ...state, question: undefined, status: "thinking" };
    case "sessions":
      return { ...state, sessions: action.sessions };
    case "notice":
      return { ...state, notice: action.text };
    case "agent-mode":
      return { ...state, agentMode: action.mode };
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: AppState, e: Event): AppState {
  const at = Date.now();
  switch (e.type) {
    case "message_delta": {
      if (e.delta.type !== "text") return state; // tool-input JSON is internal
      const rows = [...state.rows];
      const idx = findStreamingMessage(rows, e.messageId);
      if (idx >= 0) {
        const row = rows[idx] as Extract<Row, { kind: "message" }>;
        rows[idx] = {
          ...row,
          msg: { ...row.msg, text: row.msg.text + e.delta.text },
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
      } else if (text !== "") {
        rows.push({
          kind: "message",
          at,
          msg: {
            id: e.id,
            role: e.role,
            text,
            model: e.model,
            streaming: false,
          },
        });
      }
      return { ...state, rows, model: e.model ?? state.model };
    }

    case "tool_call": {
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
            },
          },
        ],
      };
    }

    case "tool_result": {
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
        },
      };
      return { ...state, rows };
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
        rows: [...state.rows, { kind: "compaction", at, summary: e.summary }],
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

    case "status":
      return {
        ...state,
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