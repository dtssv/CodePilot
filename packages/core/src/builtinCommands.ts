// Shared catalog of built-in slash commands.
//
// This is the single cross-surface source of truth for the built-in `/` menu:
// the TUI derives its command list from it, and every GUI client (web, vscode,
// idea) lists the same commands via the `commands/list` RPC. Without it each
// surface hard-coded its own drifting set.
//
// Two orthogonal axes describe a command:
//
//   `scope` — WHERE it is meaningful:
//     - "shared":   works on any surface (model/mode/compact/clear/plan/…).
//       Advertised to all clients by the RPC.
//     - "tui-only": only the terminal UI can carry it out (exit, QR remote, the
//       interactive provider-connect wizard, the first-run setup guide, the
//       colour-theme picker, launching the web UI). The RPC omits these.
//
//   `kind` — WHAT running it does:
//     - "local":  a client-side action (switch mode, open a picker, compact,
//       clear, show a panel). It never becomes a model turn. Every built-in is
//       local — execution lives in each client; this catalog only standardises
//       discovery + metadata.
//     - "prompt": the command expands into text sent to the model as a turn.
//       Built-ins are never "prompt"; custom markdown commands are (they carry a
//       body template). The field is published so GUI clients can branch on it
//       without re-deriving the distinction from a hard-coded name list.

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
