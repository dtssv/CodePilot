/**
 * Slash command dispatch.
 *
 * Selection-style commands (`/model`, `/provider`, `/mode`, `/agent`,
 * `/resume`, `/sessions`, `/goal`) open an interactive picker when invoked
 * without args — users never have to type the parameter by hand. Passing
 * an explicit argument still works as a shortcut.
 */
import type { AgentMode, PermissionMode, SlashCommand } from "@codepilot/core";
import { resolveSlashCommand } from "@codepilot/core";
import type { SessionController } from "./controller.js";

export type CommandResult =
  | { kind: "noop" }
  | { kind: "system"; text: string }
  | { kind: "submit-prompt"; text: string }
  | { kind: "set-model"; model: string; providerId?: string }
  | { kind: "set-provider"; providerId: string }
  | { kind: "list-models" }
  | { kind: "pick-provider" }
  | { kind: "pick-mode" }
  | { kind: "pick-agent" }
  | { kind: "pick-session" }
  | { kind: "pick-goal" }
  | { kind: "connect" }
  | { kind: "set-mode"; mode: PermissionMode }
  | { kind: "set-agent-mode"; mode: AgentMode }
  | { kind: "list-sessions" }
  | { kind: "resume"; sessionId: string }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "show-plan" }
  | { kind: "compact" }
  | { kind: "retry" }
  | { kind: "goal"; objective: string }
  | { kind: "show-mcp" }
  | { kind: "show-hooks" }
  | { kind: "show-agents" }
  | { kind: "show-skills" }
  | { kind: "show-context" }
  | { kind: "show-plugins" }
  | {
      kind: "custom-command";
      prompt: string;
      model?: string;
      allowedTools?: string[];
      commandName: string;
    }
  | { kind: "unknown-command"; name: string };

export interface CommandContext {
  controller: SessionController;
  cwd: string;
}

export interface CommandInfo {
  name: string;
  description: string;
 /** Optional inline argument hint. `[…]` = optional (palette runs immediately). */
  args?: string;
}

export const COMMANDS: readonly CommandInfo[] = [
  { name: "help", description: "Show available commands" },
  { name: "connect", description: "Interactively add a model provider (API key)" },
  { name: "model", description: "Pick a model (↑↓ + Enter)", args: "[provider/model]" },
  { name: "provider", description: "Pick a provider preset (↑↓ + Enter)", args: "[id]" },
  { name: "mode", description: "Pick permission mode (↑↓ + Enter)", args: "[ask|auto-edit|yolo]" },
  { name: "agent", description: "Pick collaboration mode (↑↓ + Enter)", args: "[chat|plan|agent]" },
  { name: "plan", description: "Show the current plan" },
  { name: "compact", description: "Trigger compaction" },
  { name: "retry", description: "Send the last prompt again" },
  { name: "resume", description: "Pick a session to resume (↑↓ + Enter)", args: "[session-id]" },
  { name: "sessions", description: "Pick a session to resume (↑↓ + Enter)" },
  { name: "goal", description: "Start a long-running goal (prompts for objective)", args: "[objective]" },
  { name: "clear", description: "Clear the visible event log" },
  { name: "mcp", description: "Show MCP server status & tools" },
  { name: "hooks", description: "Show configured hooks" },
  { name: "agents", description: "Show custom sub-agents" },
  { name: "skills", description: "Show available skills" },
  { name: "context", description: "Show context window usage" },
  { name: "plugins", description: "Show installed plugins" },
  { name: "exit", description: "Exit CodePilot" },
];

const AGENT_MODES: readonly AgentMode[] = ["chat", "plan", "agent"];
const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto-edit", "yolo"];

export const HELP_TEXT = `Available commands:
  /help                              Show this help
  /connect                           Add a provider (interactive wizard)
  /model                             Pick a model (↑↓ + Enter)
  /provider                          Pick a provider (↑↓ + Enter)
  /mode                              Pick permission mode (↑↓ + Enter)
  /agent                             Pick collaboration mode (↑↓ + Enter)
       chat   read-only Q&A; no edits, no shell
       plan   read-only + plan_update; model produces a plan
       agent  full autonomy (default)

  /plan                              Show the current plan
  /compact                           Trigger compaction
  /resume · /sessions                Pick a session to resume (↑↓ + Enter)
  /goal                              Prompt for a long-running objective
  /clear                             Clear the visible event log

  -- runtime introspection --
  /mcp  /hooks  /agents  /skills  /context  /plugins

  /exit                              Exit CodePilot

  Tip: selection commands accept an optional arg to skip the picker
  (e.g. /model provider/model, /mode yolo).

  -- custom commands (.codepilot/commands/*.md) --
  /<name>                            Run a custom prompt template
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
    case "connect":
      return { kind: "connect" };
    case "model": {
      if (rest === "") return { kind: "list-models" };
      return { kind: "set-model", model: rest };
    }
    case "provider": {
      if (rest === "") return { kind: "pick-provider" };
      return { kind: "set-provider", providerId: rest };
    }
    case "mode": {
      if (rest === "") return { kind: "pick-mode" };
      if (!PERMISSION_MODES.includes(rest as PermissionMode)) {
        return { kind: "pick-mode" };
      }
      return { kind: "set-mode", mode: rest as PermissionMode };
    }
    case "agent": {
      if (rest === "") return { kind: "pick-agent" };
      if (!AGENT_MODES.includes(rest as AgentMode)) {
        return { kind: "pick-agent" };
      }
      return { kind: "set-agent-mode", mode: rest as AgentMode };
    }
    case "plan":
      return { kind: "show-plan" };
    case "compact":
      return { kind: "compact" };
    case "retry":
      return { kind: "retry" };
    case "resume": {
      if (rest === "") return { kind: "pick-session" };
      return { kind: "resume", sessionId: rest };
    }
    case "sessions":
      return { kind: "pick-session" };
    case "goal": {
      if (rest === "") return { kind: "pick-goal" };
      return { kind: "goal", objective: rest };
    }
    case "mcp":
      return { kind: "show-mcp" };
    case "hooks":
      return { kind: "show-hooks" };
    case "agents":
      return { kind: "show-agents" };
    case "skills":
      return { kind: "show-skills" };
    case "context":
      return { kind: "show-context" };
    case "plugins":
      return { kind: "show-plugins" };
    case "clear":
      return { kind: "clear" };
    case "exit":
    case "quit":
      return { kind: "exit" };
    default:
      return { kind: "unknown-command", name: cmd };
  }
}

export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "help",
  "?",
  "connect",
  "model",
  "provider",
  "mode",
  "agent",
  "plan",
  "compact",
  "resume",
  "sessions",
  "goal",
  "clear",
  "mcp",
  "hooks",
  "agents",
  "skills",
  "context",
  "plugins",
  "exit",
  "quit",
  "retry",
]);

export function runCommandWithCustom(
  raw: string,
  ctx: CommandContext,
  customCommands: readonly SlashCommand[],
): CommandResult {
  const builtin = runCommand(raw, ctx);
  if (builtin.kind !== "unknown-command") return builtin;
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
    return { kind: "submit-prompt", text: raw.trim() };
  }
  if (resolved.reason === "no-args") {
 // Custom commands that require args: still show usage — they aren't
 // enumerable pickers. Prefer running without args when possible.
    return { kind: "system", text: resolved.message };
  }
  return {
    kind: "system",
    text: `Unknown command: /${resolved.name}. Try /help.`,
  };
}

export function buildCommandList(
  customCommands: readonly SlashCommand[],
): readonly CommandInfo[] {
  const customInfos: CommandInfo[] = customCommands.map((c) => ({
    name: c.name,
    description: c.description || "(custom command)",
    args: c.argumentHint,
  }));
  return [...COMMANDS, ...customInfos];
}

export function isCommand(input: string): boolean {
  return input.trim().startsWith("/");
}
