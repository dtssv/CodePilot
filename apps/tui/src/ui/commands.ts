/**
 * Slash command dispatch.
 *
 * Each command returns a `CommandResult` describing what the App should do
 * next (send a prompt to the session, change state, dispatch an async action,
 * etc.). Commands are pure functions of `(args, ctx)`; side effects (state
 * changes, prompt dispatch) are realized by the caller.
 */
import type { PermissionMode } from "@codepilot/core";
import type { SessionController } from "./controller.js";

export type CommandResult =
  | { kind: "noop" }
  | { kind: "system"; text: string }
  | { kind: "submit-prompt"; text: string }
  | { kind: "set-model"; model: string }
  | { kind: "set-mode"; mode: PermissionMode }
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

export const HELP_TEXT = `Available commands:
  /help                         Show this help
  /model <name>                 Switch the model (e.g. /model claude-sonnet-4-5)
  /mode <ask|auto-edit|yolo>    Switch the permission mode
  /plan                         Show the current plan
  /compact                      Trigger compaction (if supported by core)
  /resume <session-id>          Resume an existing session
  /sessions                     List saved sessions
  /goal <objective>             Long-running goal mode
  /clear                        Clear the visible event log
  /exit                         Exit CodePilot
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
          text: "Usage: /mode <ask|auto-edit|yolo>",
        };
      }
      return { kind: "set-mode", mode: rest };
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