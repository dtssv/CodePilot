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
  | { kind: "set-vim"; enabled?: boolean }
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
  | { kind: "help"; text: string }
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
  | { kind: "rewind"; count: number; files: boolean }
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
      /** Present when the command expands via MCP prompts/get. */
      mcpPrompt?: { server: string; name: string };
      args?: string;
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
  chat: "Switch to chat mode (read-only Q&A)",
  plan: "Show the current plan for this session",
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

// Help sections are the only hand-written part left: they decide grouping and
// ordering. The commands themselves, their argument hints and descriptions come
// from the same catalog the palette uses, so a command cannot be listed here and
// missing there. Anything the catalog gains without a section appears under
// "Other" rather than silently dropping out of the help.
const HELP_SECTIONS: readonly { title: string; names: readonly string[] }[] = [
  { title: "Model & mode", names: ["model", "provider", "agent", "chat", "plan", "mode", "preset", "theme", "vim"] },
  { title: "Conversation", names: ["compact", "retry", "rewind", "undo", "redo", "clear"] },
  { title: "Sessions & goals", names: ["sessions", "resume", "goal", "schedule"] },
  { title: "Project & context", names: ["init", "export", "gc-artifacts", "mcp", "hooks", "agents", "skills", "context", "plugins"] },
  { title: "Terminal", names: ["setup", "connect", "web", "remote", "help", "exit"] },
];

function commandLabel(c: CommandInfo): string {
  return c.args ? `/${c.name} ${c.args}` : `/${c.name}`;
}

export interface HelpSection {
  title: string;
  items: readonly CommandInfo[];
}

/**
 * The command catalog grouped for display. `renderHelpText` and the help panel
 * both read this, so a command can never be listed in one and missing in the
 * other.
 */
export function helpSections(commands: readonly CommandInfo[] = COMMANDS): HelpSection[] {
  const byName = new Map(commands.map((c) => [c.name, c]));
  const sections: HelpSection[] = [];
  const placed = new Set<string>();
  for (const section of HELP_SECTIONS) {
    const items = section.names
      .map((name) => byName.get(name))
      .filter((c): c is CommandInfo => c !== undefined);
    for (const c of items) placed.add(c.name);
    if (items.length > 0) sections.push({ title: section.title, items });
  }
  const rest = commands.filter((c) => !placed.has(c.name));
  if (rest.length > 0) sections.push({ title: "Other", items: rest });
  return sections;
}

export function renderHelpText(commands: readonly CommandInfo[] = COMMANDS): string {
  const sections = helpSections(commands);

  // One shared label column keeps every section aligned.
  let labelWidth = 0;
  for (const section of sections) {
    for (const c of section.items) labelWidth = Math.max(labelWidth, commandLabel(c).length);
  }

  const out: string[] = ["Available commands — optional arguments are shown in [ ].", ""];
  for (const section of sections) {
    out.push(section.title);
    for (const c of section.items) out.push(`  ${commandLabel(c).padEnd(labelWidth)}  ${c.description}`);
    out.push("");
  }
  out.push("Tips");
  out.push("  · Selection commands take an argument to skip the picker: /mode yolo, /agent plan, /theme nord");
  out.push("  · Markdown commands in .codepilot/commands/*.md run as /<name> and are not listed above");
  out.push("  · /? is an alias for /help, /quit for /exit");
  return out.join("\n");
}

export const HELP_TEXT = renderHelpText();

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
      return { kind: "help", text: HELP_TEXT };
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
    case "chat":
      return { kind: "set-agent-mode", mode: "chat" };
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
    case "vim":
      return rest === "on" || rest === "off" ? { kind: "set-vim", enabled: rest === "on" } : { kind: "set-vim" };
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
    case "rewind": {
      const parts = rest.split(/\s+/).filter(Boolean);
      const n = Number(parts.find((p) => /^\d+$/.test(p)) ?? 1);
      return { kind: "rewind", count: Math.max(1, n), files: !parts.includes("--keep-files") };
    }
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
      ...(resolved.command.mcpPrompt
        ? { mcpPrompt: resolved.command.mcpPrompt, args: resolved.args }
        : {}),
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
