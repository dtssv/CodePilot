/**
 * Slash command dispatch.
 *
 * Each command returns a `CommandResult` describing what the App should do
 * next (send a prompt to the session, change state, dispatch an async action,
 * etc.). Commands are pure functions of `(args, ctx)`; side effects (state
 * changes, prompt dispatch) are realized by the caller.
 *
 * Two orthogonal mode switches are exposed to the user:
 *
 *   - **Permission mode** (`/mode ask|auto-edit|yolo`) — controls how the
 *     `PermissionEngine` reacts to tool calls (always prompt, prompt for
 *     writes only, never prompt). Independent of which tools are exposed.
 *   - **Collaboration mode** (`/agent chat|plan|agent`) — Cursor-style
 *     switch that controls *which tools* the model can see and how the
 *     system prompt is shaped (read-only Q&A, plan-only exploration, or
 *     full autonomy). Persisted to the session and replayed on resume.
 *
 * They are deliberately kept on separate commands so users don't have to
 * memorize positional argument rules.
 */
import type { AgentMode, PermissionMode } from "@codepilot/core";
import type { SessionController } from "./controller.js";

export type CommandResult =
  | { kind: "noop" }
  | { kind: "system"; text: string }
  | { kind: "submit-prompt"; text: string }
  | { kind: "set-model"; model: string }
  | { kind: "set-mode"; mode: PermissionMode }
  | { kind: "set-agent-mode"; mode: AgentMode }
  | { kind: "list-sessions" }
  | { kind: "resume"; sessionId: string }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "show-plan" }
  | { kind: "compact" }
  | { kind: "goal"; objective: string };

export interface CommandContext {
  controller: SessionController;
  cwd: string;
}

const AGENT_MODES: readonly AgentMode[] = ["chat", "plan", "agent"];

export const HELP_TEXT = `Available commands:
  /help                              Show this help
  /model <name>                      Switch the model (e.g. /model claude-sonnet-4-5)

  -- permission mode (how the user is prompted for tool calls) --
  /mode <ask|auto-edit|yolo>         Switch the permission mode

  -- collaboration mode (which tools the model can call) --
  /agent <chat|plan|agent>           Switch the collaboration mode
       chat   read-only Q&A; no edits, no shell
       plan   read-only + plan_update; model produces a plan
       agent  full autonomy (default)

  /plan                              Show the current plan
  /compact                           Trigger compaction (if supported by core)
  /resume <session-id>               Resume an existing session
  /sessions                          List saved sessions
  /goal <objective>                  Long-running goal mode
  /clear                             Clear the visible event log
  /exit                              Exit CodePilot
`;

export function runCommand(raw: string, _ctx: CommandContext): CommandResult {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) {
    return { kind: "submit-prompt", text: trimmed };
  }
  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";
  const rest = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "":
      return { kind: "noop" };
    case "help":
    case "?":
      return { kind: "system", text: HELP_TEXT };
    case "model": {
      if (rest === "") return { kind: "system", text: "Usage: /model <name>" };
      return { kind: "set-model", model: rest };
    }
    case "mode": {
      if (rest !== "ask" && rest !== "auto-edit" && rest !== "yolo") {
        return {
          kind: "system",
          text:
            "Usage: /mode <ask|auto-edit|yolo>\n" +
            "(This is the *permission* mode. For Cursor-style collaboration mode, use /agent <chat|plan|agent>.)",
        };
      }
      return { kind: "set-mode", mode: rest };
    }
    case "agent": {
      if (!AGENT_MODES.includes(rest as AgentMode)) {
        return {
          kind: "system",
          text: `Usage: /agent <chat|plan|agent>`,
        };
      }
      return { kind: "set-agent-mode", mode: rest as AgentMode };
    }
    case "plan":
      return { kind: "show-plan" };
    case "compact":
      return { kind: "compact" };
    case "resume": {
      if (rest === "") return { kind: "system", text: "Usage: /resume <session-id>" };
      return { kind: "resume", sessionId: rest };
    }
    case "sessions":
      return { kind: "list-sessions" };
    case "goal": {
      if (rest === "") return { kind: "system", text: "Usage: /goal <objective>" };
      return { kind: "goal", objective: rest };
    }
    case "clear":
      return { kind: "clear" };
    case "exit":
    case "quit":
      return { kind: "exit" };
    default:
      return { kind: "system", text: `Unknown command: /${cmd}. Try /help.` };
  }
}

/**
 * Whether the input should be treated as a slash command rather than a prompt.
 */
export function isCommand(input: string): boolean {
  return input.trim().startsWith("/");
}
