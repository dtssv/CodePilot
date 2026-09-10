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
import type { AgentMode, PermissionMode, SlashCommand } from "@codepilot/core";
import { resolveSlashCommand } from "@codepilot/core";
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
  | { kind: "goal"; objective: string }
  /** A custom slash command (from .codepilot/commands/*.md). The rendered
   *  prompt is sent to the session; optional model + allowedTools overrides
   *  apply to this turn only (claude-code semantics). */
  | {
      kind: "custom-command";
      prompt: string;
      model?: string;
      allowedTools?: string[];
      commandName: string;
    }
  /** Input started with `/` but matched neither a built-in nor a known
   *  custom command. Surfaced so the caller can show "Unknown command". */
  | { kind: "unknown-command"; name: string };

export interface CommandContext {
  controller: SessionController;
  cwd: string;
}

/**
 * The list of slash commands, for autocomplete UIs.
 * Keep in sync with the `switch` in `runCommand`.
 */
export interface CommandInfo {
  name: string;
  description: string;
  /** Optional inline argument hint, e.g. "<name>". */
  args?: string;
}

export const COMMANDS: readonly CommandInfo[] = [
  { name: "help", description: "Show available commands" },
  { name: "model", description: "Switch the model", args: "<name>" },
  { name: "mode", description: "Switch permission mode", args: "<ask|auto-edit|yolo>" },
  { name: "agent", description: "Switch collaboration mode", args: "<chat|plan|agent>" },
  { name: "plan", description: "Show the current plan" },
  { name: "compact", description: "Trigger compaction" },
  { name: "resume", description: "Resume an existing session", args: "<session-id>" },
  { name: "sessions", description: "List saved sessions" },
  { name: "goal", description: "Long-running goal mode", args: "<objective>" },
  { name: "clear", description: "Clear the visible event log" },
  { name: "exit", description: "Exit CodePilot" },
];

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

  -- custom commands (from .codepilot/commands/*.md & ~/.codepilot/commands/*.md) --
  /<name> <args>                     Run a custom prompt template.
                                     The file body becomes the next user
                                     message; $ARGUMENTS / $1 / $2… are
                                     interpolated. Optional frontmatter:
                                     description, argument-hint, allowed-tools,
                                     model. Type / and autocomplete lists them.
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
      // Not a built-in. The caller (App) tries custom-command resolution
      // next; if that also fails it shows "Unknown command".
      return { kind: "unknown-command", name: cmd };
  }
}

/**
 * The set of built-in command names. Custom commands (from
 * `.codepilot/commands/*.md`) with these names are skipped during discovery
 * so the control surface stays stable.
 */
export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "help",
  "?",
  "model",
  "mode",
  "agent",
  "plan",
  "compact",
  "resume",
  "sessions",
  "goal",
  "clear",
  "exit",
  "quit",
]);

/**
 * Resolve a `/name args` input against built-in commands first, then custom
 * commands. Built-ins always win (a custom `/model.md` cannot shadow the
 * built-in `/model`). Returns:
 *  - built-in result (unchanged from `runCommand`),
 *  - `{ kind: "custom-command", ... }` when a custom command matches,
 *  - `{ kind: "system", text: "Unknown command..." }` when nothing matches,
 *  - `{ kind: "system", text: "Usage: /name <hint>" }` when a custom command
 *    that expects args was invoked without any.
 */
export function runCommandWithCustom(
  raw: string,
  ctx: CommandContext,
  customCommands: readonly SlashCommand[]
): CommandResult {
  const builtin = runCommand(raw, ctx);
  if (builtin.kind !== "unknown-command") return builtin;
  // Try custom command resolution.
  const resolved = resolveSlashCommand(raw, customCommands);
  if (resolved.ok) {
    return {
      kind: "custom-command",
      prompt: resolved.prompt,
      model: resolved.command.model,
      allowedTools: resolved.command.allowedTools,
      commandName: resolved.command.name,
    };
  }
  if (resolved.reason === "not-a-command") {
    // Shouldn't happen (runCommand already handled the non-slash case), but
    // be defensive.
    return { kind: "submit-prompt", text: raw.trim() };
  }
  if (resolved.reason === "no-args") {
    return { kind: "system", text: resolved.message };
  }
  // not-found
  return {
    kind: "system",
    text: `Unknown command: /${resolved.name}. Try /help.`,
  };
}

/**
 * Build the autocomplete list combining built-in + custom commands. Custom
 * commands are appended after built-ins and tagged with their description /
 * argument hint.
 */
export function buildCommandList(
  customCommands: readonly SlashCommand[]
): readonly CommandInfo[] {
  const customInfos: CommandInfo[] = customCommands.map((c) => ({
    name: c.name,
    description: c.description || "(custom command)",
    args: c.argumentHint,
  }));
  return [...COMMANDS, ...customInfos];
}

/**
 * Whether the input should be treated as a slash command rather than a prompt.
 */
export function isCommand(input: string): boolean {
  return input.trim().startsWith("/");
}
