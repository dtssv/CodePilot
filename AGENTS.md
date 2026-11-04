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
  the source of truth to SQLite. A *derived, fail-soft* SQLite index is allowed
  and exists (`sessionIndex.ts`, `docs/design/B-sqlite-session-index.md`): the
  hot `session/list`/`searchSessions` RPCs would otherwise re-scan and JSON-parse
  every session's JSONL on each UI event in the shared daemon. Invariants: JSONL
  stays the source of truth, the index is rebuildable and may be deleted at any
  time, and `openSessionIndex` returns null on any failure so callers fall back
  to the full-scan path. Native deps (`better-sqlite3`) must track the repo's
  Node floor (`engines.node` `>=20`) — a native addon above that floor aborts the
  process on older runtimes, which the fail-soft try/catch cannot recover from.
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
- Self-contained CLI/TUI binaries (what `scripts/install.{sh,ps1}` download — no
  Node at runtime). Two different pipelines, for hard reasons:
  - **CLI** (`scripts/package/cli.mjs`): esbuild→single CJS→`@yao-pkg/pkg`. Works
    because the CLI is fully bundleable (better-sqlite3 is fail-soft/optional).
    `@yao-pkg/pkg` can only build for its **host** platform — its remote base-Node
    cache 404s for non-host targets ("Not able to build for 'win' here, only for
    'macos'"), so there is **no cross-compile**; CI builds per-OS/arch.
  - **TUI** (`scripts/package/tui.mjs` + `bundle-bun.mjs`): **Bun `--compile`**,
    NOT pkg. The TUI is ESM and Ink/yoga use top-level await, so esbuild can't emit
    CJS, and pkg can't reliably run an ESM entry from its snapshot FS
    (ERR_MODULE_NOT_FOUND / broken `import.meta`). Bun handles ESM+TLA+native addons.
    `bundle-bun.mjs` stubs Ink's dev-only `react-devtools-core` and inlines core's
    `require("../package.json")` version probe (same fixup `bundle-node.mjs` does for
    the CLI). Bun CAN cross-compile all 6 targets from one host, but embeds host-arch
    native addons, so CI builds each on its native runner for a correct
    `better_sqlite3.node`.
  - `scripts/install.sh` / `.ps1` download `codepilot-<target>`, `codepilot-tui-<target>`,
    and `codepilot-web-<target>.tar.gz` into `~/.codepilot/bin`; `install.cmd` is a
    thin PowerShell shim. `CODEPILOT_DIST_DIR=dist/release` installs from a local
    build for testing. Verify a binary is truly self-contained with a node-free PATH:
    `env -i HOME=$HOME PATH=.../bin:/usr/bin:/bin codepilot --help`.
- `AGENTS.md` (this file) and `CODEPILOT.md` are both read as project memory by
  `packages/core/src/memory.ts`. Keep this file current when rules change.
