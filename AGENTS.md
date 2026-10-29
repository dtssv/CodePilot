# AGENTS.md — CodePilot project instructions

## Project context

CodePilot is a headless software-engineering agent core (`packages/core`) with thin
multi-surface clients (TUI, VSCode, IntelliJ, Web, Desktop) over a JSON-RPC
protocol (`packages/protocol`). The agent loop, tools, sandbox, compaction,
sub-agents and MCP integration all live in `packages/core/src`.

Layout:
- `packages/core` — agent loop, tools, sandbox, compaction, sessions, MCP.
- `packages/protocol` — JSON-RPC server/client, workspace RPCs.
- `packages/sdk` — programmatic SDK.
- `apps/{web,desktop,vscode,idea}` — client surfaces.

## Rules

These are hard rules for any agent working in this repo. They exist because the
observed failure modes here were: asserting "X isn't implemented" without
checking, ignoring a user-specified path, and declaring "done" without a true
end-to-end check.

- **Evidence before synthesis.** Every claim that this repo lacks or has some
  capability MUST be backed by a `grep`/`glob`/`read_file` you ran in THIS repo.
  "The other tool has X" never implies "we lack X" — search here first and cite
  `file:line`, or state it is an unverified hypothesis. Do not let "already
  checked" override a cheap local check.
- **Obey explicit user constraints.** If the user names a path/dir/branch/file,
  use exactly that. Never substitute a convenient alternative (e.g. cloning to
  `/tmp` when a path was given). If the sandbox blocks a user-named path, request
  that path's permission — do not silently route around it.
- **Verify before "done".** After any code change you MUST run, from the repo root:
  `corepack pnpm --filter @codepilot/core test` (and the affected package's
  tests), plus `corepack pnpm -r typecheck`. For a change touching a built
  surface, build it. Report the actual result, not an assumption.
- **Keep the workspace clean.** Clone external source and put scratch/output under
  `/Users/<you>/source` or the session scratch dir — never inside this repo.
  Do not leave third-party trees (e.g. `opencode/`, `codex/`) in the project root.
- **Say "unverified" when unsure.** A precise "I didn't check the Windows path"
  beats a confident wrong claim. Trust evidence over speculation; when a finding
  contradicts an earlier claim, surface the discrepancy and follow the evidence.
- **Large research goes to sub-agents.** Delegate open-ended source exploration to
  the `task` tool so the parent context stays small; the sub-agent returns a
  conclusion, not its raw exploration.

## Architecture decisions

- Persistence is append-only JSONL event sourcing (one file per session), not a
  database. This is intentional: single-writer-per-session sequential access
  makes append+replay optimal, and gives free crash recovery. Do not "upgrade"
  it to SQLite without a concrete cross-session query/concurrency need.
- Context management is client-side: layered fold + small-model compaction +
  turn-boundary pre-compaction. Providers with implicit prompt caching
  (OpenAI/Gemini) are handled by keeping a stable prefix; Anthropic gets explicit
  cache-control breakpoints.
- The OS sandbox is seatbelt (macOS) / bwrap (Linux) / wsl-bwrap (Windows).
  Sub-agent tools are a curated registry (explore = read + web research;
  worker = + write/execute).

## Discovered durable knowledge

- Build/test the core: `corepack pnpm --filter @codepilot/core build|test`.
- Full typecheck: `corepack pnpm -r typecheck`.
- Package + reinstall the desktop app (macOS):
  `PACKAGE_TARGETS=mac node scripts/package/desktop.mjs`, then copy
  `dist/release/desktop/mac-arm64/CodePilot Agent.app` to `/Applications` and
  `xattr -dr com.apple.quarantine`.
- `AGENTS.md` (this file) and `CODEPILOT.md` are both read as project memory by
  `packages/core/src/memory.ts`. Keep this file current when rules change.
