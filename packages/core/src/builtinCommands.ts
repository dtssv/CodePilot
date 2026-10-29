// Shared catalog of built-in slash commands.
//
// Historically the TUI hard-coded its own command list (apps/tui/.../commands.ts)
// and no other surface (web / vscode / idea) had slash commands at all. This
// module is the single cross-surface source of truth so every client can list
// the same commands via the `commands/list` RPC and render a `/` menu.
//
// A command's `scope` says where it is meaningful:
//   - "shared":   works on any surface (model/mode/compact/clear/plan/…). These
//     are the ones the RPC advertises to all clients.
//   - "tui-only": only the terminal UI can carry it out (exit, QR remote, the
//     interactive provider-connect wizard). The RPC omits these.
// Execution still lives in each client (a slash command is a UI affordance, not
// a model turn); this catalog only standardises discovery + metadata.

export type BuiltinCommandScope = "shared" | "tui-only";

export interface BuiltinCommand {
  name: string;
  description: string;
  /** Short argument hint shown in the menu, e.g. "[provider/model]". */
  argumentHint?: string;
  scope: BuiltinCommandScope;
}

export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  { name: "help", description: "Show available commands", scope: "shared" },
  { name: "model", description: "Pick a model", argumentHint: "[provider/model]", scope: "shared" },
  { name: "provider", description: "Pick a provider preset", argumentHint: "[id]", scope: "shared" },
  { name: "mode", description: "Pick permission mode", argumentHint: "[ask|auto-edit|yolo]", scope: "shared" },
  { name: "agent", description: "Pick collaboration mode", argumentHint: "[chat|plan|agent]", scope: "shared" },
  { name: "plan", description: "Show the current plan", scope: "shared" },
  { name: "compact", description: "Compact the conversation to free context", scope: "shared" },
  { name: "retry", description: "Send the last prompt again", scope: "shared" },
  { name: "resume", description: "Pick a session to resume", argumentHint: "[session-id]", scope: "shared" },
  { name: "sessions", description: "List sessions to resume", scope: "shared" },
  { name: "goal", description: "Start a long-running goal", argumentHint: "[objective]", scope: "shared" },
  { name: "clear", description: "Start a fresh task: archive prior context and clear the log", scope: "shared" },
  { name: "mcp", description: "Show MCP server status & tools", scope: "shared" },
  { name: "hooks", description: "Show configured hooks", scope: "shared" },
  { name: "agents", description: "Show custom sub-agents", scope: "shared" },
  { name: "skills", description: "Show available skills", scope: "shared" },
  { name: "context", description: "Show context window usage", scope: "shared" },
  { name: "plugins", description: "Show installed plugins", scope: "shared" },
  { name: "export", description: "Export session transcript", argumentHint: "[md|jsonl] [path]", scope: "shared" },
  { name: "undo", description: "Undo last agent file edits", scope: "shared" },
  { name: "redo", description: "Redo last undone file edits", scope: "shared" },
  { name: "init", description: "Scaffold AGENTS.md for this project", argumentHint: "[--force]", scope: "shared" },
  { name: "schedule", description: "List scheduled / idle tasks", scope: "shared" },
  // Terminal-only affordances — not advertised to GUI clients.
  { name: "connect", description: "Interactively add a model provider (API key)", scope: "tui-only" },
  { name: "remote", description: "Mint a one-time QR for phone remote control", scope: "tui-only" },
  { name: "exit", description: "Exit CodePilot", scope: "tui-only" },
];

/** Built-in commands meaningful on every surface (RPC advertises these). */
export function sharedBuiltinCommands(): BuiltinCommand[] {
  return BUILTIN_COMMANDS.filter((c) => c.scope === "shared");
}
