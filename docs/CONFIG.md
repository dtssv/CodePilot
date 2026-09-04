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
