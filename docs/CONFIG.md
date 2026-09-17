# CodePilot Configuration & Logging

This document describes the v2 configuration and logging systems in
`@codepilot/core`. The config layer is modelled on three industry
references: **claude-code's settings hierarchy**, **codex's
`config.toml`**, and **opencode's typed JSON schema**.

## TL;DR

```jsonc
// ~/.codepilot/config.json
{
  "provider": "openai",
  "model": "fast",                // resolved via "models.aliases"
  "apiKey": "${OPENAI_API_KEY}",  // env interpolation
  "permissionMode": "auto-edit",
  "mcpServers": { "github": { "command": "gh-mcp" } },

  // v2 additions
  "models": { "aliases": { "fast": "gpt-5-mini", "smart": "gpt-5" } },
  "providers": {
    "work":  { "provider": "openai",    "baseURL": "https://api.work/v1", "apiKey": "${WORK_KEY}" },
    "home":  { "provider": "anthropic", "model": "claude-sonnet-4-5" }
  },
  "skills":  { "enabled": true, "dirs": ["./team-skills"] },
  "logging": { "level": "info", "file": "~/.codepilot/logs/cp.log", "console": true },
  "telemetry": { "enabled": false },
  "usage":    { "enabled": false }
}
```

## Configuration sources & priority

Every config value is sourced from the lowest-priority layer first, then
overridden by higher-priority layers:

| # | Layer | Where it comes from | Notes |
|---|-------|---------------------|-------|
| 1 | **Built-in defaults** | `DEFAULT_CONFIG` in `config.ts` | Always present. |
| 2 | **User-level file**   | `~/.codepilot/config.json` | Skipped silently if missing. |
| 3 | **Repo-level file**   | `<cwd>/.codepilot/config.json` | Per-project overrides. |
| 4 | **Environment**       | `CODEPILOT_PROVIDER`, `CODEPILOT_MODEL`, `CODEPILOT_API_KEY`, `CODEPILOT_BASE_URL`, `CODEPILOT_PERMISSION_MODE`, `CODEPILOT_LOG_LEVEL` | Per-process overrides. |
| 5 | **Caller-explicit**   | `loadConfigWithSources(cwd, explicit)` or `SessionOptions.config` | Highest priority. |

Arrays (`autoApprove`) are **concatenated** across layers. Object-valued
fields (`mcpServers`, `logging`, `models`, `providers`, …) are
**shallow-merged** key-by-key. Scalars are **replaced** by the
highest-priority layer that defines them.

The merge is `as` layer-aware: you can call
`loadConfigWithSources(cwd)` (debug command) to see exactly which layer
contributed which value:

```ts
const { config, sources } = await loadConfigWithSources(cwd, { model: "gpt-5" });
// sources[0] = { name: "defaults", value: {...} }
// sources[1] = { name: "user", source: "~/.codepilot/config.json", value: {...} }
// sources[2] = { name: "repo", source: "<cwd>/.codepilot/config.json", value: {...} }
// sources[3] = { name: "env",   source: "process.env", value: {...} }
// sources[4] = { name: "caller", source: "<inline>", value: {...} }
```

The `loadConfig(cwd)` legacy entry point is preserved for backwards
compatibility and returns the same `config` as
`loadConfigWithSources(cwd).config`.

## Environment interpolation

Any string value can reference environment variables with
`${ENV_VAR}` (required) or `${ENV_VAR:-fallback}` (default). This is
applied after merging and before validation, so a missing variable
without a default becomes an empty string and validation can then catch
it for fields like `baseURL` that must be a valid URL.

```jsonc
{
  "apiKey":   "${OPENAI_API_KEY}",
  "baseURL":  "${CUSTOM_BASE_URL:-https://api.openai.com/v1}",
  "autoApprove": ["^gh ", "${EXTRA_RULES:-^git status}"]
}
```

The walker is object/array aware but does not interpolate object keys
(shell-style). Cycles in the interpolation chain are detected and
broken.

## Schema validation

Every load runs through `CodepilotConfigSchema` (a zod schema). On
failure, a single `Error` is thrown whose message lists every issue
with a dotted field path so the source of the problem is obvious:

```
Invalid CodePilot config:
  - permissionMode: Invalid enum value. Expected 'ask' | 'auto-edit' | 'yolo', received 'lol'
  - mcpServers.bad.command: Required
  - baseURL: Invalid url
```

The schema is exported, so other tools (the protocol package's
`codepilot config` debug command) can reuse it:

```ts
import { CodepilotConfigSchema } from "@codepilot/core";
const parsed = CodepilotConfigSchema.parse(jsonText);
```

## Model aliases & provider presets

Aliases and presets are typed entries on the config that let users
refer to models and providers by short names:

```jsonc
{
  "models": { "aliases": { "fast": "gpt-5-mini", "smart": "gpt-5" } },
  "providers": {
    "work": { "provider": "openai", "baseURL": "https://x.test/v1", "apiKey": "...", "model": "gpt-5" },
    "home": { "provider": "anthropic", "model": "claude-sonnet-4-5" }
  }
}
```

Helpers in `config.ts`:

- `resolveModelAlias(cfg)` — turns `cfg.model = "fast"` into
  `"gpt-5-mini"`. Identity-mapping when no alias matches.
- `useProvider(cfg, "work")` — returns a shallow-cloned `CodepilotConfig`
  with `provider`, `baseURL`, `apiKey`, and `model` taken from the
  named preset. Throws if the preset doesn't exist.

## Environment variables

| Variable | Effect |
|----------|--------|
| `CODEPILOT_PROVIDER`         | Sets `provider` (`anthropic` / `openai` / `copilot`). |
| `CODEPILOT_MODEL`            | Sets `model`. |
| `CODEPILOT_API_KEY`          | Sets `apiKey`. |
| `CODEPILOT_BASE_URL`         | Sets `baseURL`. |
| `CODEPILOT_PERMISSION_MODE`  | Sets `permissionMode` (`ask` / `auto-edit` / `yolo`). |
| `CODEPILOT_LOG_LEVEL`        | Logger level (`debug` / `info` / `warn` / `error`). Overridden by `config.logging.level`. |

## Programmatic API

```ts
import {
  loadConfig, loadConfigWithSources, mergeConfig, validateConfig,
  interpolateEnv, useProvider, resolveModelAlias,
  DEFAULT_CONFIG, CodepilotConfigSchema,
  type ResolvedCodepilotConfig, type LoadConfigResult, type ConfigLayer,
} from "@codepilot/core";

// Backwards-compatible loader
const cfg = await loadConfig(cwd);

// Layered loader (new)
const { config, sources } = await loadConfigWithSources(cwd, { model: "smart" });

// Provider switching
const next = useProvider(config, "work");
const model = resolveModelAlias(next);

// Standalone merge / validation (useful in tests / CLI)
const merged = mergeConfig(fileLayer, envLayer);
const valid  = validateConfig(merged);
```

The `CodepilotConfig` type from `types.ts` is unchanged for backwards
compatibility. New fields are surfaced via `ResolvedCodepilotConfig`,
which extends it with `models` / `providers` / `skills` / `logging` /
`telemetry` / `usage`. The `loadConfig*` return type is
`ResolvedCodepilotConfig`; the legacy `mergeConfig` still returns
`CodepilotConfig`.

---

# Logging

`@codepilot/core` ships a small, dependency-free structured logger in
`logger.ts`. Every record is a single line of NDJSON with this shape:

```ts
interface LogRecord {
  ts: string;            // ISO-8601 UTC timestamp
  level: number;         // 10/20/30/40 for debug/info/warn/error
  levelName: "debug" | "info" | "warn" | "error";
  ns: string;            // namespace, e.g. "agent", "session", "mcp", "tool"
  msg: string;           // free-form message
  [extra: string]: unknown;  // any structured kv pairs
}
```

## Quick start

```ts
import { createLogger, initLoggerFromConfig } from "@codepilot/core";

// Initialise from a config block (or call with no args for defaults).
initLoggerFromConfig({ level: "info", file: "~/.codepilot/logs/cp.log" });

const log = createLogger("agent");
log.info("session started", { sessionId: "abc", model: "gpt-5" });
log.warn("retrying", { attempt: 2, max: 5 });
log.error("provider failed", { provider: "openai", code: 429 });

const sub = createLogger("agent").child!("mcp");
sub.debug("tool registered", { name: "github__search" });
```

## Sinks

There are two sink kinds wired by `initLoggerFromConfig`:

1. **stderr sink** (TUI-friendly) — writes one JSON object per line to
   `process.stderr`. Default-active for the configured level. Disabled
   by `console: false`. The default level of `warn` keeps the TUI
   quiet by default.
2. **file sink** — append-mode NDJSON to the path in
   `config.logging.file` (defaults to
   `~/.codepilot/logs/codepilot-YYYY-MM-DD.log`). The file always
   captures records at or above the configured level.

Both sinks respect the active level. A failing sink is logged to
`stderr` but never propagated, so a misconfigured log file can't crash
the host program.

## Levels

`debug` < `info` < `warn` < `error`. The level can be set from three
places, in priority order:

1. `config.logging.level` (highest)
2. `CODEPILOT_LOG_LEVEL` environment variable
3. Default: `info`

The numeric values are exported as `LOG_LEVELS` and used internally for
filtering.

## File rotation

The file sink rotates when the active file exceeds
`config.logging.rotateBytes` (default **10 MB**):

```
active.log       →   active.log.1     (oldest content)
active.log.1     →   active.log.2
active.log.2     →   active.log.3
active.log.3     →   (deleted; past keep limit)
```

Default generations to keep is **3**; the active file is recreated
lazily on the next write. Both `rotateBytes` and `rotateKeep` are
configurable in the `initLoggerFromConfig` call (not exposed on the
`CodepilotConfig` schema, since they only matter for direct
embedding).

## Namespaces

Namespaces are dot-separated and built up via `logger.child(suffix)`:

```ts
const log = createLogger("agent");
log.child!("mcp").info("connected", { transport: "stdio" });
// → ns: "agent.mcp"
```

Namespaces are not enforced to a set — pick anything that helps you
filter the file (`grep '"ns":"agent"'`).

## Backwards compatibility

The legacy `loadConfig(cwd)` and `mergeConfig(base, override)`
functions from the original `config.ts` are preserved with identical
signatures. Existing callers (`session.ts`, the protocol package, the
TUI) need no changes.

The `CodepilotConfig` interface in `types.ts` is also untouched. The
v2-only fields are exposed as `ResolvedCodepilotConfig` (a structural
superset) and validated by the zod schema; merging / loading functions
that produce a fully-resolved config return that type. Code paths that
still operate on plain `CodepilotConfig` (e.g. the existing
`Session` constructor) continue to work.

## v3 additions: permissions rules, sandbox, maxTurns

```jsonc
// .codepilot/config.json
{
  "maxTurns": 50,
  "permissions": {
    "allow": ["read_file", "bash(npm test *)", "bash(/^git (status|diff)/)", "mcp__github__*"],
    "ask":   ["bash(git push *)"],
    "deny":  ["bash(rm -rf *)", "edit_file(*.env)"]
  },
  "sandbox": {
    "mode": "workspace-write",       // off | workspace-write | read-only
    "network": true,
    "writablePaths": ["/data/scratch"],
    "fallback": "deny"               // deny | allow-unsandboxed
  }
}
```

### Permission rules

Rule syntax (claude-code compatible):

| Rule form | Matches |
|---|---|
| `"read_file"` | every call of the tool |
| `"mcp__github__*"` | wildcard over tool names |
| `"bash(npm test *)"` | glob/prefix on the tool's primary argument (bash→command, file tools→path, web_fetch→url, web_search→query); a trailing ` *` also matches the bare prefix |
| `"bash(/^git (status\|diff)/)"` | regex on the primary argument |
| `"/^git status/"` | legacy bare-regex form, applies to bash commands (back-compat with `autoApprove`) |

Evaluation order: **deny → ask → allow → mode default**. Deny rules apply
in every mode including `yolo`. The legacy `autoApprove` array is merged
into `permissions.allow`. Choosing "always" at a permission prompt now adds
a narrowed session rule (e.g. `bash(npm test *)`) instead of flipping the
whole session to `yolo`; hosts can persist it with `persistRule(cwd, rule)`.

Bash commands matching a dangerous-pattern scan (`rm -rf /`, force-push,
`git reset --hard`, fork bombs, `curl|sh`, DROP TABLE, …) always require
interactive confirmation unless an allow rule explicitly covers them.

### Sandbox

The sandbox is enforced at two layers:

1. **Process layer** — `bash` commands are wrapped by the strongest
   available OS primitive: `sandbox-exec` (macOS Seatbelt), `bwrap`
   (Linux), or WSL+bwrap (Windows, when a WSL distro with bubblewrap is
   installed). Writes are confined to the workspace, the system temp dir,
   `~/.codepilot`, and `sandbox.writablePaths`; `network: false` cuts
   outbound access (`deny network*` / `--unshare-net`). Sensitive reads
   (`~/.ssh`, credential files, `/etc/shadow`) are denied outright.
2. **Tool layer** — `read_file`/`write_file`/`edit_file`/`ls`/`glob`/`grep`
   validate every path before I/O, including a realpath check so symlinks
   cannot escape the writable roots. This layer is pure Node and behaves
   identically on macOS, Linux and Windows.

When no OS sandbox binary exists and mode ≠ `off`, `fallback` decides:
`deny` (default, fail closed — bash refuses to run) or
`allow-unsandboxed` (run with a loud warning in the output). On Windows
without WSL+bwrap the process layer is unavailable; the tool-layer guard
still applies and bash fails closed under the default fallback.

## v4 additions: hooks, provider fallback, interactive questions, background jobs

```jsonc
// .codepilot/config.json
{
  "fallbacks": [
    { "provider": "openai",    "model": "gpt-5",             "apiKey": "${OPENAI_API_KEY}" },
    { "provider": "anthropic", "model": "claude-sonnet-4-5" }
  ],
  "hooks": {
    "PreToolUse":   [{ "matcher": "^write_file", "command": "sh hooks/check-path.sh" }],
    "PostToolUse":  [{ "matcher": "*",           "command": "sh hooks/lint-after.sh" }],
    "Notification": [{ "matcher": "*",           "command": "sh hooks/notify.sh" }],
    "Stop":         [{ "matcher": "*",           "command": "sh hooks/on-stop.sh" }],
  },
  "mcpServers": {
    "remote":  { "type": "http", "url": "https://mcp.example.com/mcp",
                 "headers": { "Authorization": "Bearer ${MCP_TOKEN}" } }
  }
}
```

### Lifecycle hooks

Each hook entry is `{ matcher, command }`. `matcher` is a regex tested
against the tool name (`"*"` matches all). The hook's shell command receives
a JSON payload on **stdin** containing the tool name, input, result and cwd.

| Event | Payload | Semantics |
|---|---|---|
| `PreToolUse` | tool, input, cwd | **exit 2 = block the call**; stderr becomes the model-visible reason. Any other code = proceed. |
| `PostToolUse` | tool, input, result, isError | stdout is appended to the tool result the model sees (use this to inject lint/test feedback). |
| `Notification` | free-form | fire-and-forget side effects (toasts, file watchers). |
| `Stop` | free-form | runs when a prompt finishes. |

### Provider fallback

`fallbacks` is an ordered list of backup providers. The primary provider is
the top-level `provider`/`model`. If the primary's stream fails **before any
content was produced** with a transient error (429 / rate limit / quota /
overloaded / 401 / 403 / 5xx / connection reset / DNS failure), the request
is replayed against the next provider. Once a provider has streamed real
content we never switch — mid-stream failover would corrupt tool-call
framing. Non-transient errors (bad schema, invalid request) do not cascade.
Failover events are logged to stderr and to `session.getUsage()`.

### Interactive questions (`ask_user_question`) and `plan_done`

The model can ask the user structured questions — a multi-question prompt
with an id, optional `header`, and optional choices. Hosts wire the callback
via `SessionOptions.onAskUser(req: QuestionRequest) => Promise<QuestionAnswers>`.
Without a handler the tool returns an explicit error so the model degrades
gracefully instead of guessing.

`plan_done` is the ExitPlanMode equivalent: it asks the user to approve the
plan and, on approval, emits a `mode_request` event that the session turns
into a real mode switch to `agent`. The TUI mirrors both `mode` and
`mode_request` events.

### Background bash jobs

`bash` accepts `run_in_background: true` and returns a job id. `bash_output`
polls for the tail of a job's output; `bash_kill` sends SIGTERM. Jobs write
to `~/.codepilot/jobs/*.log` so they survive restarts of the TUI.

### MCP Streamable HTTP transport

`mcpServers` entries may declare `"type": "http"` (Streamable HTTP, MCP
2025-03-26) or `"type": "sse"` (the older SSE transport). Both are POST-per-
message; `http` tracks the `mcp-session-id` header and DELETEs the session on
shutdown. stdio remains the default when `type` is omitted.

### Secret redaction

Every tool result is passed through `redactSecrets()` before it is echoed to
the model or persisted. The pattern set covers PEM private keys, AWS access
keys, GitHub / OpenAI / Anthropic tokens, Slack tokens, bearer headers,
passwords inside connection strings, and `KEY=…` / `"key": "…"` env and JSON
shapes. Redaction is idempotent and false-positive-tolerant by design: a
redacted non-secret is a nuisance, a leaked real secret is an incident.

### Agent runtime

`runtime` names a registered `AgentRuntime` to drive the prompt loop instead
of the built-in one; `runtimeOptions` is a per-runtime options bag keyed by
runtime name. Unlike the rest of the schema, option values are not validated
here — a plugin runtime defines its own option shape and validates it itself,
and strict-mode would otherwise reject any option the core has never heard of.

```jsonc
{
  "runtime": "mcts",
  "runtimeOptions": {
    "mcts": { "candidates": 3, "exploreMode": "plan" }
  }
}
```

An unknown runtime name throws at prompt time rather than silently falling
back to the default loop. Plugins can register runtimes (and even claim the
default) — see [RUNTIME.md](./RUNTIME.md).

### Usage and cost

`session.getUsage()` returns aggregate `{ input, output, cacheRead,
cacheWrite, costUSD }`. Cost is estimated from `estimateCostUSD(model,
usage)` in `tokens.ts`, which ships a public-price table for the Claude,
GPT, DeepSeek and Qwen families and returns `undefined` for unknown models
(callers must treat that as "not priced", not zero).
