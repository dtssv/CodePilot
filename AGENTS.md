# AGENTS.md — CodePilot

Instructions for agents working in this repository. Prefer facts found in this
tree over assumptions. Keep this file short and current when rules change.

## Overview

CodePilot is a software-engineering agent: a headless engine plus thin clients
over JSON-RPC.

| Path | Role |
|------|------|
| `packages/core` | Agent loop, tools, sandbox, sessions, compaction, MCP |
| `packages/protocol` | JSON-RPC server/client, CLI serve/daemon, workspace RPCs |
| `packages/sdk` | Programmatic SDK |
| `apps/tui` | Terminal UI (also the unified `codepilot` binary entry) |
| `apps/web` | Web UI (embedded in CLI binary; also staged into Desktop) |
| `apps/desktop` | Electron desktop app |
| `apps/vscode`, `apps/idea` | IDE extensions |

`packages/core/src` is split by capability folders (not separate packages):
`agent`, `session`, `sandbox`, `permissions`, `compaction`, `mcp`, `subagent`,
`skills`, `memory`, `hooks`, `plugins`, `workspace`, `config`, `telemetry`,
plus existing `providers`, `tools`, `systemPrompt`, `runtimes`. Public API stays
`index.ts` / `types.ts` at the package root of `src`. Session composes
capability binders (`mcp/sessionBind`, `plugins/sessionBind`,
`sandbox/sessionBind`, `permissions/sessionBind`, `compaction/sessionBind`,
`providers/sessionProviders`); those folders own their session-facing bind
modules — do not dump new capability wiring into more `session/session-*.ts`
files.

Node `>=20`. Package manager: `corepack pnpm` (see root `packageManager`).

## Hard rules

1. **Evidence before claims.** Before saying this repo has or lacks a capability,
   search or read here and cite `path:line`, or mark the claim **unverified**.
   Do not infer from other products.
2. **Honor explicit paths.** If the user names a path, branch, or file, use that
   exact location. Do not silently redirect. If the sandbox blocks it, ask for
   permission instead of working around it.
3. **Verify before “done”.** After code changes, from the repo root run:
   - `corepack pnpm --filter @codepilot/core test`
   - tests for every other package you touched
   - `corepack pnpm -r typecheck`
   - build any packaged surface you changed  
   Report real command output, not assumptions.
4. **Keep the tree clean.** Put clones, dumps, and scratch under a personal
   scratch directory — never under this repo root. Do not leave third-party
   checkouts in the project.
5. **Say unverified when unsure.** A precise gap beats a confident wrong claim.
   If new evidence contradicts an earlier statement, say so and follow evidence.
6. **Large exploration → `task`.** Broad multi-hop research belongs in a
   sub-agent; return a conclusion, not a raw dump, into the parent thread.

## Invariants (do not casually reverse)

- **Session source of truth is append-only JSONL** (one file per session), not a
  database. A derived, fail-soft SQLite index for list/search is allowed and
  must remain rebuildable / deletable; JSONL stays authoritative.
- **Native addons** (e.g. `better-sqlite3`) must stay compatible with
  `engines.node` (`>=20`). A higher native ABI can crash the process before
  fail-soft paths run.
- **OS sandbox:** seatbelt (macOS), bwrap (Linux), wsl-bwrap (Windows).
- **Sub-agent tool sets are a curated registry** (explore = read + research;
  worker = that plus write/execute) — not an open plugin free-for-all.
- **Prompt cache:** keep a stable prefix for providers with implicit caching;
  Anthropic uses explicit cache-control breakpoints.

## Commands

```bash
# Build / check
corepack pnpm --filter @codepilot/core build
corepack pnpm --filter @codepilot/core test
corepack pnpm -r typecheck

# Dev
corepack pnpm --filter @codepilot/tui dev
corepack pnpm --filter @codepilot/desktop start

# Package CLI (unified binary → dist/release/cli/)
PACKAGE_TARGETS=mac corepack pnpm package:cli
CODEPILOT_DIST_DIR=dist/release scripts/install.sh   # → ~/.codepilot/bin

# Package Desktop (embeds apps/web/dist; separate from CLI install)
PACKAGE_TARGETS=mac node scripts/package/desktop.mjs
# Install: copy dist/release/desktop/mac-arm64/CodePilot\ Agent.app → /Applications
# then: xattr -dr com.apple.quarantine "/Applications/CodePilot Agent.app"
```

`package:cli` updates the CLI/daemon binary only. **Desktop App embeds its own
web UI** — UI fixes for the App require `package:desktop` (and reinstalling the
`.app`), not only `package:cli`.

Local install from a build: `CODEPILOT_DIST_DIR=dist/release`. Smoke a
node-free binary with a minimal `PATH` that still includes `~/.codepilot/bin`.

## Packaging pitfalls (unified binary)

- Prefer **static** imports for modules that must bind `node:http` or embed
  `with { type: "file" }` assets inside a Bun `--compile` binary; nested dynamic
  `import()` can drop those in the compiled artifact.
- In a compiled binary, modules share one `import.meta.url` / entry identity —
  do not assume a nested module can detect “am I the process entry?” the same
  way as under `bun run`.
- Native addons are host-arch; cross-compile of JS does not fix
  `better_sqlite3.node` — build each target on a matching runner when shipping.

## Style

- Match local patterns: TypeScript ESM, existing lint/format (`biome`), existing
  test layout (vitest under each package).
- Prefer small, focused diffs. Do not refactor unrelated code or add docs the
  user did not ask for.
- Do not commit unless the user asks.

## Project memory

This file and `CODEPILOT.md` (when present) are loaded as project instructions
by the agent (`packages/core` memory). Update rules here when durable process
or architecture constraints change; put ephemeral notes elsewhere.
