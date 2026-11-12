/**
 * Slash command dispatch. Selection-style commands (`/model`, `/provider`,
 * `/mode`, `/agent`, `/resume`, `/sessions`, `/goal`) open a picker when invoked
 * without args; an explicit argument is a shortcut.
 */
import type { AgentMode, PermissionMode, PermissionPresetName, SlashCommand } from "@codepilot/core";
import { resolveSlashCommand, BUILTIN_COMMANDS } from "@codepilot/core";
import type { SessionController } from "./controller.js";
import { THEME_NAMES, type ThemeName } from "./themes.js";

export type CommandResult =
  | { kind: "noop" }
  | { kind: "system"; text: string }
  | { kind: "submit-prompt"; text: string }
  | { kind: "set-model"; model: string; providerId?: string }
  | { kind: "set-provider"; providerId: string }
  | { kind: "list-models" }
  | { kind: "pick-provider" }
  | { kind: "pick-mode" }
  | { kind: "pick-preset" }
  | { kind: "set-preset"; name: PermissionPresetName }
  | { kind: "pick-agent" }
  | { kind: "pick-theme" }
  | { kind: "set-theme"; name: string }
  | { kind: "pick-session" }
  | { kind: "pick-goal" }
  | { kind: "connect" }
  | { kind: "setup" }
  | { kind: "set-mode"; mode: PermissionMode }
  | { kind: "set-agent-mode"; mode: AgentMode }
  | { kind: "list-sessions" }
  | { kind: "resume"; sessionId: string }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "show-plan" }
  | { kind: "compact"; focus?: string }
  | { kind: "retry" }
  | { kind: "goal"; objective: string }
  | { kind: "show-mcp" }
  | { kind: "show-hooks" }
  | { kind: "show-agents" }
  | { kind: "show-skills" }
  | { kind: "show-context"; precise?: boolean }
  | { kind: "show-plugins" }
  | { kind: "export"; format: "markdown" | "jsonl"; outPath?: string }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "init"; force: boolean }
  | { kind: "remote-qr" }
  | { kind: "open-web" }
  | { kind: "schedule-list" }
  | { kind: "gc-artifacts" }
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

// Picker-friendly descriptions shown in the terminal palette. The command SET,
// ordering, scope and kind come from the shared catalog (@codepilot/core); this
// map only overrides the display text for commands whose terminal affordance
// (an interactive ↑↓ picker) is worth spelling out in the menu. Any command not
// listed here falls back to the shared catalog's description.
const TUI_DESCRIPTIONS: Readonly<Record<string, string>> = {
  model: "Pick a model (↑↓ + Enter)",
  provider: "Pick a provider preset (↑↓ + Enter)",
  mode: "Pick permission mode (↑↓ + Enter)",
  agent: "Pick collaboration mode (↑↓ + Enter)",
  theme: "Pick a colour palette (↑↓ + Enter)",
  compact: "Trigger compaction",
  resume: "Pick a session to resume (↑↓ + Enter)",
  sessions: "Pick a session to resume (↑↓ + Enter)",
  goal: "Start a long-running goal (prompts for objective)",
  clear: "Start a fresh task: archive prior context (kept on disk) and clear the log",
  export: "Export session transcript (markdown or jsonl)",
};

// The terminal command list, derived from the shared catalog so the set never
// drifts from what the `commands/list` RPC advertises. Terminal-only commands
// (exit, setup, theme, …) are included here even though the RPC omits them for
// GUI surfaces — the TUI is their only home.
export const COMMANDS: readonly CommandInfo[] = BUILTIN_COMMANDS.map((c) => ({
  name: c.name,
  description: TUI_DESCRIPTIONS[c.name] ?? c.description,
  ...(c.argumentHint ? { args: c.argumentHint } : {}),
}));

const AGENT_MODES: readonly AgentMode[] = ["chat", "plan", "agent"];
const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto-edit", "yolo", "auto", "dont-ask"];
const PRESET_NAMES: readonly PermissionPresetName[] = ["safe", "standard", "full-access", "supervised-auto"];

export const HELP_TEXT = `Available commands:
  /help                              Show this help
  /setup                             First-run guide: provider · search · images
  /connect                           Add a provider (interactive wizard)
  /model                             Pick a model (↑↓ + Enter)
  /provider                          Pick a provider (↑↓ + Enter)
  /mode                              Pick permission mode (↑↓ + Enter)
  /agent                             Pick collaboration mode (↑↓ + Enter)
       chat   read-only Q&A; no edits, no shell
       plan   read-only + plan_update; model produces a plan
       agent  full autonomy (default)

  /theme                             Pick a colour palette (↑↓ + Enter)

  /plan                              Show the current plan
  /compact                           Trigger compaction
  /resume · /sessions                Pick a session to resume (↑↓ + Enter)
  /goal                              Prompt for a long-running objective
  /clear                             Clear the visible event log

  -- runtime introspection --
  /mcp  /hooks  /agents  /skills  /context  /plugins
  /export [md|jsonl] [path]          Export this session transcript
  /undo · /redo                      Undo/redo last agent file edits
  /init [--force]                    Scaffold AGENTS.md (commit-ready)
  /web                               Open the web UI in your browser (same session)
  /remote                            One-time QR for phone remote control
  /schedule                          List idle/scheduled tasks

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
    case "setup":
      return { kind: "setup" };
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
    case "preset": {
      if (rest === "") return { kind: "pick-preset" };
      if (!PRESET_NAMES.includes(rest as PermissionPresetName)) {
        return { kind: "pick-preset" };
      }
      return { kind: "set-preset", name: rest as PermissionPresetName };
    }
    case "agent": {
      if (rest === "") return { kind: "pick-agent" };
      if (!AGENT_MODES.includes(rest as AgentMode)) {
        return { kind: "pick-agent" };
      }
      return { kind: "set-agent-mode", mode: rest as AgentMode };
    }
    case "theme": {
      if (rest === "") return { kind: "pick-theme" };
      if (!(THEME_NAMES as readonly string[]).includes(rest)) {
        return { kind: "pick-theme" };
      }
      return { kind: "set-theme", name: rest as ThemeName };
    }
    case "plan":
      return { kind: "show-plan" };
    case "compact":
      return { kind: "compact", focus: rest || undefined };
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
    case "context": {
      const precise = /(^|\s)(--precise|precise)(\s|$)/.test(rest);
      return { kind: "show-context", precise };
    }
    case "plugins":
      return { kind: "show-plugins" };
    case "export": {
      const parts = rest.split(/\s+/).filter(Boolean);
      let format: "markdown" | "jsonl" = "markdown";
      let outPath: string | undefined;
      for (const p of parts) {
        const low = p.toLowerCase();
        if (low === "md" || low === "markdown") format = "markdown";
        else if (low === "jsonl" || low === "json") format = "jsonl";
        else outPath = p;
      }
      return { kind: "export", format, outPath };
    }
    case "undo":
      return { kind: "undo" };
    case "redo":
      return { kind: "redo" };
    case "init":
      return { kind: "init", force: /\b--force\b/.test(rest) };
    case "web":
      return { kind: "open-web" };
    case "remote":
      return { kind: "remote-qr" };
    case "schedule":
      return { kind: "schedule-list" };
    case "gc-artifacts":
      return { kind: "gc-artifacts" };
    case "clear":
      return { kind: "clear" };
    case "exit":
    case "quit":
      return { kind: "exit" };
    default:
      return { kind: "unknown-command", name: cmd };
  }
}

// Names a custom `.md` command may not shadow: every built-in from the shared
// catalog plus the terminal-only aliases (`?` for help, `quit` for exit) that
// the dispatcher accepts but the catalog does not enumerate.
export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  ...BUILTIN_COMMANDS.map((c) => c.name),
  "?",
  "quit",
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
