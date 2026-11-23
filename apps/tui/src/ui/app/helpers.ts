import { CATEGORY_ACTIVE, glyph } from "../theme.js";
import { wrappedHeight } from "../textWidth.js";
import { planProgress, runningTool } from "../transcript.js";
import type { Row, TuiState } from "../state.js";

/** How the UI reached its engine, surfaced quietly in the welcome header. */
export interface ConnectionInfo {
  /** "shared" — this UI started/joined the shared daemon's new session;
   *  "following" — it is tailing an existing shared session;
   *  "local" — a standalone in-process engine drives it. */
  mode: "shared" | "following" | "local";
  sessionId?: string;
}

/** Clear the visible screen and home the cursor. Deliberately NOT `3J`: with the
transcript living in our own viewport there is nothing of ours in the scrollback,
and wiping it would destroy the user's shell history above the app. */
export const CLEAR_SCREEN = "\u001b[2J\u001b[H";

/** Clear screen and scrollback, cursor home. Only for a deliberate full reprint. */
export const CLEAR_ALL = "\u001b[2J\u001b[3J\u001b[H";

export type PrintedItem = { key: string; row?: Row };

export function connectionLabel(connection: ConnectionInfo | undefined): string | undefined {
  return connection?.mode === "following"
    ? "following a shared session"
    : connection?.mode === "shared"
      ? "shared server"
      : connection?.mode === "local"
        ? "local engine"
        : undefined;
}

/** Keep a multi-line notice from crowding out the transcript. */
export function clipNotice(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : `${lines.slice(0, maxLines - 1).join("\n")}\n… ${lines.length - maxLines + 1} more lines`;
}

/** Generous row estimate, so the viewport never undercounts and clips content.
 *
 * `view` describes whether the row is expanded and focused: an open tool card
 * grows by its body (output preview or diff), and the collapsed header always
 * costs at least two lines so the caret has somewhere to sit. */
export function rowHeight(
  row: Row,
  cols: number,
  view?: { open?: boolean; focused?: boolean },
): number {
  const width = Math.max(10, cols - 6);
  const focusPad = view?.focused ? 1 : 0;
  switch (row.kind) {
    case "assistant": {
      const fences = (row.msg.text.match(/^\s*(```|~~~)/gm) ?? []).length;
      const reasoning = row.msg.reasoning ? (view?.open === false ? 2 : 9) : 0;
      return 2 + wrappedHeight(row.msg.text, width) + fences + reasoning + focusPad;
    }
    case "tool": {
      // Sub-agent runs are rendered as their own entries, so this row is only its
      // own header (plus its own output when expanded). Counting the runs here
      // too is what desynced the estimated heights from the screen and made
      // clicks land on the wrong row.
      const nested = (row.tool.subagents?.length ?? 0) > 0;
      const body =
        view?.open && !nested
          ? Math.min(16, (row.tool.resultText ?? "").split("\n").length) +
            (row.tool.category === "edit" || row.tool.category === "write" ? 12 : 0)
          : 0;
      const head = 1 + Math.min(2, wrappedHeight(row.tool.target, width));
      return head + body + focusPad;
    }
    case "plan":
      return 2 + (view?.open === false ? 0 : row.plan.length) + focusPad;
    case "system":
      // Multi-line reference output (/help) is rendered verbatim, so its height
      // must follow the wrapped line count — a fixed guess would desync the
      // viewport and the caret. The row prints a bullet before the text, and
      // that bullet wraps with it, so it counts toward the measured width.
      return 1 + wrappedHeight(`${glyph.dot} ${row.text}`, width) + focusPad;
    default:
      return 4 + focusPad;
  }
}

/** What the agent is doing right now, in the same words as the other clients. */
export function activityLabel(state: TuiState): string {
  switch (state.status) {
    case "compacting":
      return "Compacting context…";
    case "waiting_permission":
      return "Waiting for your approval…";
    case "waiting_question":
      return "Waiting for your answer…";
  }
  const tool = runningTool(state.rows);
  if (tool) {
    const verb = tool.category === "other" ? `Calling ${tool.name}` : CATEGORY_ACTIVE[tool.category];
    return tool.target ? `${verb} ${tool.target}` : `${verb}…`;
  }
  if (state.activity?.phase === "model") return "Waiting for model response";
  const current = planProgress(state.plan).current;
  return current ? `Thinking ${glyph.dot} ${current.title}` : "Thinking…";
}