# CodePilot — VSCode Extension

A VSCode client for [CodePilot](../..), the token-efficient, long-horizon
coding agent. The extension is a thin protocol adapter: it spawns
`codepilot serve` as a child process and speaks the headless JSON-RPC protocol
documented in [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md).

The extension has no runtime dependency on `@codepilot/core`; it just needs a
running core process to talk to.

## Install / Develop

```bash
# from repo root (with pnpm)
pnpm install
pnpm --filter codepilot-vscode build

# launch a dev VSCode instance with the extension loaded
code --extensionDevelopmentPath apps/vscode apps/vscode
```

Build a `.vsix`:

```bash
pnpm --filter codepilot-vscode package
# → apps/vscode/codepilot-vscode-2.0.0.vsix
```

## Configuration

All settings live under the `codepilot.*` namespace (see `contributes.configuration` in `package.json`):

| Key | Default | Notes |
|---|---|---|
| `codepilot.serverPath` | `"codepilot"` | Path or $PATH name of the CLI. The extension runs `<serverPath> serve`. |
| `codepilot.cliPath` | `""` | If set, the extension runs `node <nodePath> <cliPath> serve` instead. Useful for local dev where the CLI isn't on `$PATH`. |
| `codepilot.nodePath` | `"node"` | node binary used when `cliPath` is set. |
| `codepilot.permissionMode` | `"ask"` | One of `ask`, `auto-edit`, `yolo`. Passed in the `initialize` handshake. |
| `codepilot.model` | `""` | Default model id for new sessions. |
| `codepilot.provider` | `""` | Optional default provider (`anthropic` / `openai` / `copilot`). |
| `codepilot.systemPromptExtra` | `""` | Extra system prompt text appended to new sessions. |
| `codepilot.autoApprove` | `[]` | Tool names or bash regexes that auto-approve (forwarded to core via env/config). |
| `codepilot.showDiff` | `true` | When true, `edit_file` / `write_file` tool calls open a `vscode.diff` tab. |
| `codepilot.protocolVersion` | `1` | Headless protocol version. |

## Commands

| Command | Keybinding | What it does |
|---|---|---|
| `codPilot.openSidebar` (registered as `codepilot.openSidebar`) | `Ctrl/Cmd + Shift + C` | Focus the chat sidebar. |
| `codepilot.newSession` | — | Start a fresh session. |
| `codepilot.cancel` | `Escape` (when `codepilot.busy` context is set) | Cancel the in-flight prompt. |
| `codepilot.askSelection` | `Ctrl/Cmd + Shift + L` (when there's a selection) | Ask about the current selection; selection + file path are attached as context. |
| `codepilot.explainFile` | — | Ask CodePilot to explain the active file; attaches the file (truncated) + diagnostics. |
| `codepilot.fixFile` | — | Ask CodePilot to fix the active file; attaches the file + diagnostics. |
| `codepilot.showOutput` | — | Open the `CodePilot` output channel. |

## Sidebar chat

The sidebar is a webview. It renders a stream of messages:

- `user` messages show the prompt + any attached context chips
  (selection, file, diagnostics).
- `assistant` messages render a small markdown subset (paragraphs, fenced
  code, inline code, bold/italic, links, lists, blockquotes) with VSCode
  theme CSS variables.
- `tool_call` events render as collapsible cards with the tool name, badge
  (running / done / error), input, and result.
- `plan` events render as a checklist (✓ ◐ ✗ ·).
- `error` / `compaction` events render as system rows.

The webview receives the entire `ViewState` on every change via
`postMessage({ type: "state", state })` and re-renders by ID — this keeps the
extension side stateless with respect to messages.

## Permission prompts

The `permission/request` JSON-RPC request from the core is routed to a
`vscode.window.showWarningMessage` dialog with three buttons:

- **Allow** → `permission/respond { decision: "allow" }`
- **Always** → `permission/respond { decision: "always" }`
- **Deny** → `permission/respond { decision: "deny" }`

The dialog shows the tool name and a small summary (e.g. `$ command` for
`bash`, `path: <relpath>` for file tools, otherwise a JSON snippet).

## Status bar

A status bar entry on the left shows the connection state plus cumulative
input + output tokens (and cost, when known). Clicking it focuses the
sidebar.

## Protocol implementation notes

See the `report` block in the most recent change for any deviations from
`docs/PROTOCOL.md`. In short:

- The client subscribes to `event`, `session/usage`, and `permission/request`;
  any other server-initiated request/notification is forwarded to a generic
  raw handler (logged, not acted on).
- Streaming is implemented by accumulating `message_delta` text deltas in the
  in-memory model and replacing the partial on the canonical `message` event.
- The client never speaks pings/keepalives — the underlying child process
  is owned by VSCode and torn down on extension deactivation.