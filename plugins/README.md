# CodePilot reference plugins

This directory holds the plugins that ship with the repo. They are real,
installable examples — browse them to see how a plugin is structured, or copy
one as a starting point for your own.

See [`docs/PLUGINS.md`](../docs/PLUGINS.md) for the full reference (manifest
fields, discovery, resource merging, `permissions`, install/uninstall, and the
marketplace).

## Where to start

**New to plugins? Copy [`hello-world/`](./hello-world/).** It is the smallest
useful plugin and is heavily commented as a template:

```
hello-world/
├── plugin.json                 # manifest: metadata + a SessionStart hook + permissions
├── commands/hello.md           # a /hello slash command
└── skills/hello/SKILL.md       # a skill that explains plugin anatomy
```

It demonstrates the three things most plugins need — a command, a skill, and a
lifecycle `hook` guarded by a `permissions` allow-list — in under 40 lines.

## Try it locally

A plugin is discovered from either the project dir (`<cwd>/.codepilot/plugins/`)
or the user dir (`~/.codepilot/plugins/`). To run `hello-world` without
publishing it anywhere, install it from this local path:

```ts
import { installPlugin } from "@codepilot/core";
await installPlugin("./plugins/hello-world");   // copies into ~/.codepilot/plugins/
```

Or simply copy the directory into a discovery location:

```sh
cp -r plugins/hello-world ~/.codepilot/plugins/hello-world
```

Plugins are discovered at session start, so start a **new** session, then:

- run `/hello` (or `/hello Ada`) — the command appears in completion;
- ask "how do CodePilot plugins work?" — the `hello` skill can be loaded on demand;
- watch stderr at session start — the `SessionStart` hook prints a line.

## The feature-grade examples

The other directories are fuller, production-shaped plugins. Each bundles a
skill + agent + command around one workflow:

| Plugin | Workflow |
|---|---|
| `code-review` | Automated code review with severity tagging |
| `doc-gen` | API docs, README sections, JSDoc/TSDoc |
| `perf-profile` | Performance profiling and bottleneck analysis |
| `refactor` | Safe automated refactoring / codemods |
| `security-audit` | Dependency scanning, secret detection, auth review |
| `test-gen` | Unit / integration test generation |
| `runtime-example` | A custom **agent runtime** (replaces the agent loop) — see [`docs/RUNTIME.md`](../docs/RUNTIME.md) |
| `tools-example` | Registers a model-callable **tool** via the RuntimeToolkit ABI — see [`docs/RUNTIME.md`](../docs/RUNTIME.md) |
| `sink-example` | An additive **storage mirror sink** (copies the JSONL event stream) — see [`docs/RUNTIME.md`](../docs/RUNTIME.md) |
| `provider-template-example` | Contributes a **provider template** (baseURL + model list) to the picker — pure data, no code |

## Writing your own

1. Copy `hello-world/` to a new directory and rename it.
2. Edit `plugin.json` — set a unique `name` (lowercase, hyphens), a
   `description`, and a `version`. Add `hooks` / `mcpServers` / `runtime` only
   if you need them, and list each in `permissions` so they are honored.
3. Add/remove `commands/`, `skills/`, and `agents/` as needed. Their formats
   match the global discovery dirs — see [`docs/COMMANDS.md`](../docs/COMMANDS.md),
   [`docs/SKILLS.md`](../docs/SKILLS.md).
4. Install from the local path (above), start a new session, and test.

> **Hook paths:** a hook `command` runs via `/bin/sh -c` in the **session's
> working directory**, with the event payload on stdin as JSON. There is no
> plugin-root variable, so keep hook commands self-contained (as `hello-world`
> does) or reference scripts by a path that resolves from the session cwd.
