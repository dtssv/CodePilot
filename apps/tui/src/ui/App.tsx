/**
 * Root TUI component.
 *
 * Responsibilities:
 *  - Hold TuiState (single source of truth).
 *  - Subscribe to the Session event stream and dispatch TuiAction events.
 *  - Drive the permission UI: when a permission request arrives, show the
 *    prompt and resolve the bridge's waitDecision() promise when the user
 *    picks an option.
 *  - Route input: slash commands → runCommand(); otherwise → session.prompt().
 *  - Handle Ctrl+C: cancel running prompt or exit.
 */
import React from "react";
import { Box, Text } from "ink";
import type {
  Event,
  PermissionDecision,
  PermissionMode,
  Session,
} from "@codepilot/core";

import { RowView } from "./EventView.js";
import { InputBox } from "./InputBox.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { StatusBar } from "./StatusBar.js";
import { Spinner } from "./Spinner.js";
import { initialState, reducer, type TuiState } from "./state.js";
import { isCommand, runCommand } from "./commands.js";
import type { PermissionBridge, SessionController } from "./controller.js";

export interface AppProps {
  session: Session;
  controller: SessionController;
  permissionBridge: PermissionBridge;
  cwd: string;
  model: string | undefined;
  permissionMode: PermissionMode;
  initialPrompt?: string | undefined;
}

export function App(props: AppProps): React.ReactElement {
  const { session, controller, permissionBridge, cwd, model, permissionMode, initialPrompt } = props;

  const [state, dispatch] = React.useReducer(reducer, undefined, () =>
    initialState({
      sessionId: session.id,
      cwd,
      model,
      permissionMode,
    }),
  );

  // 1. Subscribe to session events.
  React.useEffect(() => {
    const unsub = session.subscribe((ev: Event) => {
      dispatch({ type: "event", event: ev });
      if (ev.type === "status" && ev.status === "idle") {
        dispatch({ type: "set-busy", busy: false });
      }
    });
    // Replay historical events to seed the view (in case of resume).
    for (const ev of session.getEvents()) {
      dispatch({ type: "event", event: ev });
    }
    return unsub;
  }, [session]);

  // 2. Permission bridge: when core calls onPermissionRequest, it pushes
  //    a request into the bridge and awaits a decision. The UI side reacts
  //    to the bridge's "pending" emitter by setting state.permission.
  React.useEffect(() => {
    return permissionBridge.onPending((req) => {
      dispatch({
        type: "permission-pending",
        req: {
          requestId: req.requestId,
          toolName: req.toolName,
          input: req.input,
          reason: req.reason,
        },
      });
    });
  }, [permissionBridge]);

  const onPermissionDecide = React.useCallback(
    (decision: PermissionDecision) => {
      const pending = state.permission;
      if (pending !== undefined) {
        permissionBridge.resolve(pending.requestId, decision);
      }
      dispatch({ type: "permission-resolve" });
      dispatch({ type: "set-status", status: state.busy ? "thinking" : "idle" });
    },
    [state.permission, state.busy, permissionBridge],
  );

  // 3. Submit handler.
  const doSubmit = React.useCallback(
    async (text: string) => {
      if (isCommand(text)) {
        const result = runCommand(text, { controller, cwd });
        switch (result.kind) {
          case "noop":
            return;
          case "system":
            dispatch({ type: "set-notice", text: result.text });
            return;
          case "submit-prompt":
            text = result.text;
            break;
          case "set-model":
            dispatch({ type: "set-model", model: result.model });
            dispatch({ type: "set-notice", text: `Model set to ${result.model}` });
            return;
          case "set-mode":
            dispatch({ type: "set-mode", mode: result.mode });
            dispatch({ type: "set-notice", text: `Permission mode: ${result.mode}` });
            return;
          case "show-plan": {
            const plan = state.plan;
            dispatch({
              type: "set-notice",
              text:
                plan === undefined
                  ? "(no plan yet)"
                  : plan.map((s, i) => `${i + 1}. [${s.status}] ${s.title}`).join("\n"),
            });
            return;
          }
          case "compact":
            dispatch({
              type: "set-notice",
              text: "Manual compaction requested — if core supports it, look for a status:compacting event shortly.",
            });
            return;
          case "list-sessions":
            try {
              const ss =
                controller.kind === "mock"
                  ? await controller.listSessions()
                  : await controller.core.listSessions(controller.cwd);
              dispatch({ type: "set-sessions", sessions: ss });
              dispatch({
                type: "set-notice",
                text:
                  ss.length === 0
                    ? "(no saved sessions)"
                    : ss
                        .map((s) => `${s.id.slice(0, 8)}  ${s.title}  ${new Date(s.updatedAt).toISOString()}`)
                        .join("\n"),
              });
            } catch (err: unknown) {
              dispatch({
                type: "set-notice",
                text: `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            return;
          case "resume":
            dispatch({
              type: "set-notice",
              text: `Resuming session ${result.sessionId.slice(0, 8)}… (restart TUI with --resume ${result.sessionId} for a full history view)`,
            });
            return;
          case "goal":
            dispatch({ type: "set-notice", text: `Goal started: ${result.objective}` });
            try {
              const r =
                controller.kind === "mock"
                  ? await controller.runGoal({ objective: result.objective, cwd })
                  : await controller.core.runGoal({ objective: result.objective, cwd });
              dispatch({
                type: "set-notice",
                text: `Goal ${r.status}${r.reason ? `: ${r.reason}` : ""}`,
              });
            } catch (err: unknown) {
              dispatch({
                type: "set-notice",
                text: `Goal failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            return;
          case "clear":
            dispatch({ type: "clear" });
            dispatch({ type: "set-notice", text: "Cleared." });
            return;
          case "exit":
            setExitPending(true);
            return;
        }
      }
      // Real prompt dispatch.
      try {
        dispatch({ type: "set-busy", busy: true });
        dispatch({ type: "set-status", status: "thinking" });
        await session.prompt(text);
      } catch (err: unknown) {
        dispatch({
          type: "set-notice",
          text: `Prompt error: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        dispatch({ type: "set-busy", busy: false });
        dispatch({ type: "set-status", status: "idle" });
      }
    },
    [session, controller, cwd, state.plan],
  );

  // 4. Initial prompt.
  const initialSubmittedRef = React.useRef(false);
  React.useEffect(() => {
    if (initialSubmittedRef.current) return;
    if (initialPrompt === undefined || initialPrompt.trim() === "") return;
    initialSubmittedRef.current = true;
    void doSubmit(initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 5. Cancel handler (Ctrl+C).
  const doCancel = React.useCallback(() => {
    if (state.busy || state.status === "waiting_permission") {
      try {
        session.cancel();
        dispatch({ type: "set-notice", text: "(cancelling…)" });
      } catch (err: unknown) {
        dispatch({
          type: "set-notice",
          text: `Cancel failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }
    setExitPending(true);
  }, [state.busy, state.status, session]);

  // 6. Exit.
  const [exitPending, setExitPending] = React.useState(false);
  React.useEffect(() => {
    if (!exitPending) return;
    void (async () => {
      try {
        await session.dispose();
      } catch {
        /* ignore */
      }
      process.exit(0);
    })();
  }, [exitPending, session]);

  const pendingPerm = state.permission;

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <Box paddingX={1}>
        <Text bold color="magenta">CodePilot</Text>
        <Text dimColor> · {state.cwd}</Text>
      </Box>

      {/* Event log */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1}>
        <ScrollArea rows={state.rows} />
      </Box>

      {/* Notice */}
      {state.notice !== undefined ? (
        <Box paddingX={1} marginY={1} borderStyle="round" borderColor="gray">
          <Text>{state.notice}</Text>
        </Box>
      ) : null}

      {/* Permission prompt or input */}
      {pendingPerm !== undefined ? (
        <Box paddingX={1} marginY={1}>
          <PermissionPrompt
            toolName={pendingPerm.toolName}
            input={pendingPerm.input}
            reason={pendingPerm.reason}
            onDecide={onPermissionDecide}
          />
        </Box>
      ) : (
        <Box paddingX={1} marginY={1}>
          <InputBox
            value={state.input}
            onChange={(v) => dispatch({ type: "set-input", value: v })}
            onSubmit={(t) => {
              dispatch({ type: "set-input", value: "" });
              void doSubmit(t);
            }}
            onCancel={doCancel}
            disabled={state.busy}
            placeholder={
              state.busy
                ? "Working… Ctrl+C to cancel."
                : "Type a message. Enter to send, Shift+Enter for newline. / for commands."
            }
          />
        </Box>
      )}

      {/* Status bar */}
      <StatusBar state={state} />

      {/* Bottom spinner line when busy */}
      {state.busy ? (
        <Box paddingX={1}>
          <Spinner
            label={
              state.status === "compacting"
                ? "compacting…"
                : state.status === "waiting_permission"
                ? "waiting for permission…"
                : state.status === "executing"
                ? "executing…"
                : "thinking…"
            }
          />
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * ScrollArea — renders rows in order. We cap the visible window to avoid
 * unbounded memory in long sessions; full history stays in core's session log.
 */
const MAX_RENDERED_ROWS = 500;

function ScrollArea({ rows }: { rows: TuiState["rows"] }): React.ReactElement {
  const visible =
    rows.length > MAX_RENDERED_ROWS ? rows.slice(rows.length - MAX_RENDERED_ROWS) : rows;
  return (
    <Box flexDirection="column">
      {rows.length > MAX_RENDERED_ROWS ? (
        <Text dimColor>… {rows.length - MAX_RENDERED_ROWS} earlier rows hidden</Text>
      ) : null}
      {visible.map((r, i) => {
        const k = rowKey(r, i);
        return <RowView key={k} row={r} />;
      })}
    </Box>
  );
}

function rowKey(r: import("./state.js").Row, i: number): string {
  switch (r.kind) {
    case "user":
      return `u-${r.id}`;
    case "assistant":
      return `a-${r.msg.id}-${r.msg.streaming ? "s" : "f"}-${i}`;
    case "tool":
      return `t-${r.tool.id}-${r.tool.status}-${i}`;
    case "plan":
      return `p-${r.at}-${i}`;
    case "compaction":
      return `c-${r.at}-${i}`;
    case "usage":
      return `u-${r.at}-${i}`;
    case "error":
      return `e-${r.at}-${i}`;
    case "system":
      return `s-${r.at}-${i}`;
    default: {
      // Exhaustiveness check.
      const _exhaustive: never = r;
      void _exhaustive;
      return `?-${i}`;
    }
  }
}