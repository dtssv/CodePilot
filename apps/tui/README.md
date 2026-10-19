# @codepilot/tui

Interactive terminal UI for CodePilot, built on [Ink](https://github.com/vadimdemedes/ink) (React for the CLI).
Consumes `@codepilot/core` over its headless in-process API.

## Quick start

```bash
# from the monorepo root
pnpm install
pnpm --filter @codepilot/tui dev # tsx src/cli.tsx
pnpm --filter @codepilot/tui build # tsc -b → dist/cli.js
pnpm --filter @codepilot/tui typecheck # tsc --noEmit

# Run the built binary
node apps/tui/dist/cli.js --help
# or, once linked:
codepilot-tui --help
```

## CLI flags

| Flag | Description |
|---|---|
| `--cwd <dir>` | Project directory (default: `$PWD`) |
| `--model <name>` | Override model |
| `--provider <p>` | `anthropic` \| `openai` \| `copilot` |
| `--yolo` | Start in `yolo` permission mode |
| `--resume <id>` | Resume an existing session |
| `--mock` | Use the in-memory mock session (UI development without core) |
| `-h, --help` | Show help |
| `<positional args>` | Joined and submitted as the first prompt |

## Slash commands (inside the TUI)

| Command | Behavior |
|---|---|
| `/help` | Show help |
| `/model <name>` | Switch model |
| `/mode <ask\|auto-edit\|yolo>` | Switch permission mode |
| `/plan` | Show the current plan |
| `/compact` | Trigger manual compaction (a `status:compacting` event is shown if core supports it) |
| `/resume <id>` | Mark a session for resume (restart with `--resume` for full history) |
| `/sessions` | List saved sessions |
| `/goal <objective>` | Long-running goal mode (calls `core.runGoal`) |
| `/clear` | Clear the visible event log |
| `/exit` | Exit |

## Keybindings

| Key | Action |
|---|---|
| Enter | Send message (accepts the highlighted menu entry when a menu is open) |
| Shift+Enter | Newline |
| `\` + Enter | Newline (terminals that don't pass Shift) |
| `/` at line start | Open the **command palette** with fuzzy search (matches name *and* description) |
| Ctrl+K | Toggle the command palette from anywhere |
| Ctrl+R | Reverse-search prompt history (again cycles older matches) |
| ↑/↓ | Recall history (persisted across sessions in `~/.codepilot/tui-history.jsonl`) |
| Tab | Accept the highlighted palette/completion entry |
| Esc | Close menu and restore the previous input |
| PgUp / PgDn | Scroll the event log by 10 rows (the TUI's own viewport — the terminal scrollback only holds stale frames under Ink's full-screen repaints) |
| Shift+↑ / Shift+↓ | Fine-grained scroll, 1 row |
| Ctrl+C | Cancel current prompt (or exit if idle) |
| 1/y, 2/a, 3/n (+ ↑↓/Enter) | Permission prompt: allow once / always / deny — with command & diff preview |

> Scrolled up? A banner shows "scrolled up — N rows above the live edge"; new output does **not** move your window until you PgDn back to 0 (follow mode).

## Architecture

```
src/
├── cli.tsx # argv parser, core load, render(<App/>)
├── dev/
│ └── mockSession.ts # UI dev fallback (no core required)
├── ui/
│ ├── App.tsx # Root component, dispatches state
│ ├── controller.ts # SessionController + PermissionBridge façades
│ ├── state.ts # TuiState + reducer (the brain)
│ ├── commands.ts # Slash command parser
│ ├── palette.ts # Fuzzy matcher for the command palette
│ ├── history.ts # Persistent prompt history (~/.codepilot/tui-history.jsonl)
│ ├── CommandPalette.tsx # Fuzzy command picker UI
│ ├── HistorySearch.tsx # Ctrl+R reverse-search popup
│ ├── EventView.tsx # Per-row renderer
│ ├── InputBox.tsx # Multi-line input, owns all key routing & menus
│ ├── PermissionPrompt.tsx # Approval dialog with command/diff preview
│ ├── StatusBar.tsx # Bottom bar (model/mode/session/tokens)
│ ├── Spinner.tsx # Braille spinner
│ └── Markdown.tsx # Minimal markdown renderer
└── scripts/ # Smoke tests (tsx)
```

The TUI holds a single `TuiState` managed by a reducer. Every `Event` from the
core `Session.subscribe` listener is dispatched into the reducer; streaming
`message_delta` events fold into the in-progress assistant row.

The `PermissionBridge` decouples the (async) `onPermissionRequest` callback that
core expects from the synchronous-feeling React UI: the CLI wires
`onPermissionRequest = (req) => bridge.waitDecision(req)`, and the UI calls
`bridge.resolve(requestId, decision)` when the user picks an option.

## API contract

The TUI depends **only** on the public symbols exported by `@codepilot/core`:
`Event`, `Session`, `createSession`, `loadConfig`, `runGoal`, `listSessions`,
`PermissionRequest`, `PermissionDecision`, `PermissionMode`, `CodepilotConfig`,
etc. Change core exports and TUI usage together.