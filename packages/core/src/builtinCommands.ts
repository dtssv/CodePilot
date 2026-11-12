// Shared catalog of built-in slash commands.
//
// The single cross-surface source of truth for the built-in `/` menu (TUI +
// `commands/list` RPC for every GUI client). Two axes: `scope` ("shared" — any
// surface, RPC-advertised; "tui-only" — terminal-only, RPC-omitted) and `kind`
// ("local" — client-side action; "prompt" — expands to a model turn; built-ins
// are always "local", custom markdown commands are "prompt").

export type BuiltinCommandScope = "shared" | "tui-only";

/** Whether running a command performs a local client action ("local") or
 * expands into a model prompt turn ("prompt"). Every built-in is "local";
 * custom markdown commands are "prompt". */
export type CommandKind = "local" | "prompt";

export interface BuiltinCommand {
  name: string;
  description: string;
  /** Short argument hint shown in the menu, e.g. "[provider/model]". */
  argumentHint?: string;
  scope: BuiltinCommandScope;
  /** Built-ins are always a local client action. */
  kind: CommandKind;
}

export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  { name: "help", description: "Show available commands", scope: "shared", kind: "local" },
  { name: "model", description: "Pick a model", argumentHint: "[provider/model]", scope: "shared", kind: "local" },
  { name: "provider", description: "Pick a provider preset", argumentHint: "[id]", scope: "shared", kind: "local" },
  { name: "mode", description: "Pick permission mode", argumentHint: "[ask|auto-edit|yolo|auto|dont-ask]", scope: "shared", kind: "local" },
  { name: "preset", description: "Pick a permission preset (mode + sandbox)", argumentHint: "[safe|standard|full-access|supervised-auto]", scope: "shared", kind: "local" },
  { name: "agent", description: "Pick collaboration mode", argumentHint: "[chat|plan|agent]", scope: "shared", kind: "local" },
  { name: "plan", description: "Show the current plan", scope: "shared", kind: "local" },
  { name: "compact", description: "Compact the conversation to free context", scope: "shared", kind: "local" },
  { name: "retry", description: "Send the last prompt again", scope: "shared", kind: "local" },
  { name: "resume", description: "Pick a session to resume", argumentHint: "[session-id]", scope: "shared", kind: "local" },
  { name: "sessions", description: "List sessions to resume", scope: "shared", kind: "local" },
  { name: "goal", description: "Start a long-running goal", argumentHint: "[objective]", scope: "shared", kind: "local" },
  { name: "clear", description: "Start a fresh task: archive prior context and clear the log", scope: "shared", kind: "local" },
  { name: "mcp", description: "Show MCP server status & tools", scope: "shared", kind: "local" },
  { name: "hooks", description: "Show configured hooks", scope: "shared", kind: "local" },
  { name: "agents", description: "Show custom sub-agents", scope: "shared", kind: "local" },
  { name: "skills", description: "Show available skills", scope: "shared", kind: "local" },
  { name: "context", description: "Show context window usage", scope: "shared", kind: "local" },
  { name: "plugins", description: "Show installed plugins", scope: "shared", kind: "local" },
  { name: "export", description: "Export session transcript", argumentHint: "[md|jsonl] [path]", scope: "shared", kind: "local" },
  { name: "undo", description: "Undo last agent file edits", scope: "shared", kind: "local" },
  { name: "redo", description: "Redo last undone file edits", scope: "shared", kind: "local" },
  { name: "init", description: "Scaffold AGENTS.md for this project", argumentHint: "[--force]", scope: "shared", kind: "local" },
  { name: "schedule", description: "List scheduled / idle tasks", scope: "shared", kind: "local" },
  { name: "gc-artifacts", description: "Reclaim unreferenced spilled artifacts for this project", scope: "shared", kind: "local" },
  // Terminal-only affordances — not advertised to GUI clients.
  { name: "setup", description: "Run the first-run setup guide (provider · search · images)", scope: "tui-only", kind: "local" },
  { name: "connect", description: "Interactively add a model provider (API key)", scope: "tui-only", kind: "local" },
  { name: "theme", description: "Pick a colour palette", argumentHint: "[default|nord|solarized|high-contrast]", scope: "tui-only", kind: "local" },
  { name: "web", description: "Open the web UI in your browser (shares this session)", scope: "tui-only", kind: "local" },
  { name: "remote", description: "Mint a one-time QR for phone remote control", scope: "tui-only", kind: "local" },
  { name: "exit", description: "Exit CodePilot", scope: "tui-only", kind: "local" },
];

/** Built-in commands meaningful on every surface (RPC advertises these). */
export function sharedBuiltinCommands(): BuiltinCommand[] {
  return BUILTIN_COMMANDS.filter((c) => c.scope === "shared");
}
