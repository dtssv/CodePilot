// Config loading and validation.
//
// The full set of configuration values for @codepilot/core is described by a
// single zod schema (`CodepilotConfigSchema`) and is loaded from several
// sources, merged from low to high priority:
//
// 1. Built-in defaults (`DEFAULT_CONFIG`)
// 2. User-level config (`~/.codepilot/config.json`)
// 3. Repo-level config (`<cwd>/.codepilot/config.json`)
// 4. Environment variables (`CODEPILOT_PROVIDER` / `CODEPILOT_MODEL` /
// `CODEPILOT_API_KEY` / `CODEPILOT_BASE_URL` /
// `CODEPILOT_PERMISSION_MODE` /
// `CODEPILOT_LOG_LEVEL`)
// 5. Caller-supplied explicit overrides (e.g. from SessionOptions)
//
// On top of merging, every string value is scanned for `${ENV_VAR}` and
// `${ENV_VAR:-default}` interpolations, so secrets can be referenced
// without committing them:
//
// { "apiKey": "${OPENAI_API_KEY}" }
// { "baseURL": "${CUSTOM_BASE_URL:-https://api.example.com/v1}" }
//
// The original `loadConfig(cwd)` / `mergeConfig(base, override)` API is
// preserved for backwards compatibility; new code should prefer
// `loadConfigWithSources` to also see the per-layer source information
// (useful for the `codepilot config` debug command in the protocol
// package).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { CodepilotConfig, McpServerConfig, ProviderName } from "./types.js";
import { PROVIDER_NAMES } from "./types.js";

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** Names we allow as a model alias target — see `ModelsConfig`. */
const ModelAliasTargetSchema = z.string().min(1);

/** Aliases resolve short names to a fully-qualified model id. */
export const ModelsConfigSchema = z
  .object({
    aliases: z.record(z.string().min(1), ModelAliasTargetSchema).optional(),
  })
  .strict();

/** Input modalities a model advertises (from `/models` or user edit). */
export const ModelModalitySchema = z.enum(["text", "image", "audio", "video"]);

/** Default user context budget when `/models` does not report a window. */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000;

/** Default max output tokens when `/models` does not report one. */
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Per-model context / modality settings stored on a provider preset.
 * `contextWindowMax` is the provider-reported ceiling when known (may be
 * omitted — gateways often leave it blank). `contextWindow` is the
 * user-effective budget; when max is present it must be ≤ max.
 */
export const ModelCapabilitiesSchema = z
  .object({
    contextWindowMax: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive(),
    modalities: z.array(ModelModalitySchema).min(1),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (
      val.contextWindowMax !== undefined &&
      val.contextWindow > val.contextWindowMax
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `contextWindow (${val.contextWindow}) cannot exceed contextWindowMax (${val.contextWindowMax})`,
        path: ["contextWindow"],
      });
    }
  });

/** A named provider preset — switching to it is just `useProvider("work")`. */
const ProviderPresetSchema = z
  .object({
    provider: z.enum(PROVIDER_NAMES),
 /** Human label shown in pickers (falls back to the map key). */
    displayName: z.string().min(1).optional(),
    baseURL: z.string().min(1).optional(),
    apiKey: z.string().optional(),
    model: z.string().min(1).optional(),
    smallModel: z.string().min(1).optional(),
 /** Azure OpenAI api-version (only used when provider is "azure"). */
    azureApiVersion: z.string().min(1).optional(),
 /** OpenAI API dialect (only used when provider is "openai"). */
    apiStyle: z.enum(["chat", "responses"]).optional(),
 /** Models offered in the picker for this preset. */
    models: z.array(z.string().min(1)).optional(),
 /** Per-model context ceiling + modalities (from `/models` fetch, user-editable). */
    modelCapabilities: z.record(z.string().min(1), ModelCapabilitiesSchema).optional(),
  })
  .strict();

export const ProvidersConfigSchema = z
  .record(z.string().min(1), ProviderPresetSchema)
  .optional();

/** Skill discovery configuration. */
export const SkillsConfigSchema = z
  .object({
    /** Master switch: `false` disables skill discovery entirely (no skills
     * advertised or loadable). Default on. */
    enabled: z.boolean().optional(),
    /** Extra skill root directories to scan, in addition to the default
     * project / user / built-in / ecosystem-compat roots. Relative paths
     * resolve against the session cwd. */
    dirs: z.array(z.string().min(1)).optional(),
    /** Skill names that stay on disk but are not advertised / loadable. */
    disabled: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .optional();

/** Loop-detection thresholds and exclusions. Every field is optional and
 * defaults to the built-in constant, so an empty object changes nothing. The
 * hard-refuse gate (`refuseAt`) is deliberately conservative: when thresholds
 * are tight a tool is better WARNED than refused, since a refusal has side
 * effects on a legitimate retry or idempotent poll. `exclude` lists tool names
 * or `tool::glob` patterns that are never counted toward the exact-repetition
 * or sequence layers (their results are still deduped on replay). */
export const DoomLoopConfigSchema = z
  .object({
    /** Exact-repetition count at which a tool call is WARNED (default 3). */
    warnAt: z.number().int().min(1).max(1000).optional(),
    /** Exact-repetition count at which a tool call is REFUSED (default 4).
     * Set high (or 0) to effectively never hard-refuse. */
    refuseAt: z.number().int().min(0).max(1000).optional(),
    /** Sliding window size for rotating-batch detection (default 6). */
    seqWindow: z.number().int().min(2).max(1000).optional(),
    /** Overlap count within the window that trips a rotating loop (default 4). */
    seqRepeat: z.number().int().min(1).max(1000).optional(),
    /** Overlapping re-read count for `read_file` that WARNS (default 3). */
    pathWarnAt: z.number().int().min(1).max(1000).optional(),
    /** Window-overlap fraction counting as a re-read spiral (default 0.6). */
    pathOverlap: z.number().min(0).max(1).optional(),
    /** Tool names or `tool::glob` patterns excluded from layer 1/2 counting. */
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .optional();

/** File + console logger configuration consumed by `logger.ts`. */
export const LoggingConfigSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
    file: z.string().min(1).optional(),
    console: z.boolean().optional(),
  })
  .strict()
  .optional();

/** Reserved for future opt-in telemetry — currently a passthrough. */
export const TelemetryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpoint: z.string().url().optional(),
  })
  .strict()
  .optional();

/** Reserved for future usage reporting — currently a passthrough. */
export const UsageConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpoint: z.string().url().optional(),
  })
  .strict()
  .optional();

/** Session-lifecycle tuning for a long-lived daemon. */
export const SessionsConfigSchema = z
  .object({
    // When the daemon starts, sweep the sessions directory for any session
    // whose last recorded status is in-flight (a run interrupted by a crash or
    // kill) and seal each to a clean idle before anyone reopens it. Default
    // true; set false to defer sealing until the session is next opened.
    reconcileOnBoot: z.boolean().optional(),
    // After the boot sweep seals an interrupted session, re-enter the agent
    // loop to continue its last turn. Default false — seal-and-idle only, since
    // a prior run's side-effecting tools may already have executed and a blind
    // resume risks double execution.
    autoResumeAfterCrash: z.boolean().optional(),
    // Delete non-pinned sessions older than this many days by mtime. 0 (default)
    // never deletes; pinned sessions are always exempt. Swept at daemon startup.
    retentionDays: z.number().int().nonnegative().optional(),
    // Compress sessions untouched for `coldCompressAfterDays` days to `.jsonl.br`
    // (brotli), decompressed transparently on next open. Default false.
    coldCompress: z.boolean().optional(),
    // Inactivity threshold (days) for cold compression. Default 30.
    coldCompressAfterDays: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

// Status line: a declarative preset (no scripting) or a custom command. A
// discriminated union on `type`. Historically absent from this strict schema,
// so writing `statusLine` to config.json was rejected even though the public
// type allowed it — the same latent class fixed for reasoning/runtime earlier.
export const StatusLineConfigSchema = z
  .union([
    z
      .object({
        type: z.literal("preset"),
        // Named built-in preset; ignored when `items` is given. Default "default".
        preset: z.enum(["minimal", "default", "verbose"]).optional(),
        // Explicit item list (overrides the named preset).
        items: z
          .array(z.enum(["model", "mode", "context", "branch", "cwd", "session", "rate"]))
          .optional(),
        padding: z.number().int().nonnegative().optional(),
        updateIntervalMs: z.number().int().positive().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("command"),
        // Executable or inline command; `~` is expanded. Payload piped on stdin.
        command: z.string().min(1),
        padding: z.number().int().nonnegative().optional(),
        updateIntervalMs: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
  ])
  .optional();

export const McpServerConfigSchema = z.union([
 // stdio transport (default; `type` may be omitted for back-compat)
  z
    .object({
      type: z.enum(["stdio", ""]).optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      disabled: z.boolean().optional(),
    })
    .strict(),
 // Streamable HTTP (2025-03-26) and SSE transports
  z
    .object({
      type: z.enum(["http", "sse"]),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
      // OAuth 2.1 (Authorization Code + PKCE) client fields. Optional: omitting
      // them leaves the transport on static headers / dynamic registration.
      oauthClientId: z.string().min(1).optional(),
      oauthClientSecret: z.string().min(1).optional(),
      oauthScopes: z.array(z.string().min(1)).optional(),
      disabled: z.boolean().optional(),
    })
    .strict(),
]);

/** allow/ask/deny permission rule lists. */
export const PermissionRulesSchema = z
  .object({
    allow: z.array(z.string().min(1)).optional(),
    ask: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
    /**
     * Policy for reads/writes that land OUTSIDE the working set (cwd + extra
     * working directories + sandbox writable roots + delivery roots):
     * - `ask` (default): prompt, and the user may grant the folder — current
     *   behaviour.
     * - `deny-write`: hard-deny out-of-boundary writes (no prompt), with a
     *   reason; reads are unaffected.
     * - `deny-read-write`: hard-deny out-of-boundary reads AND writes.
     */
    workspaceBoundary: z.enum(["ask", "deny-write", "deny-read-write"]).optional(),
    /**
     * Extra directories treated as part of the working set in addition to cwd.
     * A path under any of these is in-boundary (not asked/denied). "Allow this
     * directory" UI grants persist here.
     */
    additionalWorkingDirectories: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** Lifecycle hook entry (see hooks.ts). At least one handler type required. */
export const HookEntrySchema = z
  .object({
    matcher: z.string().min(1),
    command: z.string().min(1).optional(),
    http: z.string().min(1).optional(),
    httpHeaders: z.record(z.string(), z.string()).optional(),
    timeout: z.number().int().positive().optional(),
    mcpTool: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (h) => !!(h.command || h.http || h.mcpTool || h.prompt || h.agent),
    { message: "hook entry needs command, http, mcpTool, prompt, or agent" },
  );

export const HooksConfigSchema = z
  .object({
    SessionStart: z.array(HookEntrySchema).optional(),
    UserPromptSubmit: z.array(HookEntrySchema).optional(),
    PreToolUse: z.array(HookEntrySchema).optional(),
    PostToolUse: z.array(HookEntrySchema).optional(),
    PreCompact: z.array(HookEntrySchema).optional(),
    PostCompact: z.array(HookEntrySchema).optional(),
    SubagentStop: z.array(HookEntrySchema).optional(),
    Notification: z.array(HookEntrySchema).optional(),
    Stop: z.array(HookEntrySchema).optional(),
  })
  .strict();

/** OS-level sandbox policy (see sandbox.ts). */
export const SandboxConfigSchema = z
  .object({
    mode: z.enum(["off", "workspace-write", "read-only"]).optional(),
    network: z
      .union([
        z.boolean(),
        z
          .object({
            mode: z.enum(["off", "full", "proxy"]),
            allow: z.array(z.string().min(1)).optional(),
            allowPorts: z.array(z.number().int().positive()).optional(),
            denyLog: z.boolean().optional(),
          })
          .strict(),
      ])
      .optional(),
    writablePaths: z.array(z.string().min(1)).optional(),
    fallback: z.enum(["deny", "allow-unsandboxed"]).optional(),
    // Carve resolved `.git` out of the writable roots as OS-level read-only.
    // Default true. See types.ts SandboxConfig.protectGit.
    protectGit: z.boolean().optional(),
  })
  .strict();

/** web_fetch per-domain allowlist + cache TTL (see types.ts WebFetchConfig). */
export const WebFetchConfigSchema = z
  .object({
    allowedDomains: z.array(z.string().min(1)).optional(),
    blockedDomains: z.array(z.string().min(1)).optional(),
    cacheTtlMinutes: z.number().int().min(0).optional(),
  })
  .strict();

export const CustomSearchTemplateSchema = z
  .object({
    method: z.enum(["GET", "POST"]).optional(),
    url: z.string().min(1),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
    resultsPath: z.string().optional(),
    fields: z
      .object({
        title: z.string().optional(),
        url: z.string().optional(),
        snippet: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const WebSearchConfigSchema = z
  .object({
    provider: z.enum(["duckduckgo", "brave", "serper", "google", "custom"]).optional(),
    apiKey: z.string().optional(),
    cx: z.string().optional(),
    endpoint: z.string().url().optional(),
    language: z.string().optional(),
    region: z.string().optional(),
    freshness: z.enum(["day", "week", "month", "year"]).optional(),
    custom: CustomSearchTemplateSchema.optional(),
  })
  .strict();

export const ImageGenConfigSchema = z
  .object({
    baseURL: z.string().optional(),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/**
 * Top-level config schema. Every field is optional because configs layer
 * from defaults up; strict-mode means unknown keys produce a readable
 * validation error instead of being silently dropped.
 *
 * `profiles` / `activeProfile` implement the named-profile composition
 * system: `profiles` is a map of named partial configs, and when
 * `activeProfile` names one of them it is merged on top of the base
 * config (see {@link resolveProfile}).
 */
export const CodepilotConfigSchema: z.ZodType<unknown> = z
  .object({
    provider: z.enum(PROVIDER_NAMES).optional(),
    model: z.string().min(1).optional(),
    smallModel: z.string().min(1).optional(),
    apiKey: z.string().optional(),
    baseURL: z.string().url().optional(),
    azureApiVersion: z.string().min(1).optional(),
    apiStyle: z.enum(["chat", "responses"]).optional(),
    permissionMode: z.enum(["ask", "auto-edit", "yolo", "auto", "dont-ask"]).optional(),
    agentMode: z.enum(["chat", "plan", "agent"]).optional(),
    maxTokens: z.number().int().positive().optional(),
    // Reasoning / thinking controls. These were part of the public config
    // type but missing from the (strict) schema, so writing them to
    // config.json was rejected — same latent class as `runtime` earlier.
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    modelVerbosity: z.enum(["low", "medium", "high"]).optional(),
    // Anthropic extended-thinking budget in tokens. 0 / undefined = off.
    // Overrides the budget derived from reasoningEffort.
    thinkingBudget: z.number().int().nonnegative().max(200_000).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxContextTokens: z.number().int().positive().optional(),
    // Rolling tool-output window: fold tool_results older than the keep
    // window down to this many, early
    // and independent of the token budget, so numerous small results can't
    // quietly accumulate. Default 24; set 0 to fold all old results, omit/large
    // to effectively disable the early trim (budget-based fold still applies).
    maxToolResultsInContext: z.number().int().min(0).max(1000).optional(),
    compactionThreshold: z.number().positive().min(0.1).max(1).optional(),
    autoCompact: z.boolean().optional(),
    // Consecutive failed/ineffective auto-compactions before the circuit
    // breaker disables auto-compaction for the session (default 3). A failure
    // is a throw, a no-change result, or a success that left the transcript
    // still over the hard trigger. A manual /compact can still run and, if it
    // gets back under budget, re-enables auto-compaction.
    autoCompactMaxConsecutiveFailures: z.number().int().min(1).max(100).optional(),
    // Tuning for the `auto` permission mode's background classifier. Consecutive
    // / total classifier denials past these caps fall back to an interactive
    // prompt so a misfiring classifier can hand control back to the human.
    permissionAuto: z
      .object({
        maxConsecutiveDenials: z.number().int().min(1).max(100).optional(),
        maxTotalDenials: z.number().int().min(0).max(10_000).optional(),
      })
      .strict()
      .optional(),
    // `dont-ask` mode: attach a short standard feedback note to a denied soft
    // ask (default true) instead of a bare "permission denied".
    dontAskFeedback: z.boolean().optional(),
    // Models to treat as high-risk: when the active model id matches one of
    // these (substring, case-insensitive), persisted allow rules are ignored
    // during permission matching (deny/ask + floors still apply).
    highRiskModels: z.array(z.string().min(1)).optional(),
    highRiskDropSessionAllows: z.boolean().optional(),
    // Inline (Tab) code completion for the editor plugins. Off by default; runs
    // on the user's provider/apiKey but gated to a lightweight model (see
    // docs/design/G-inline-completion.md). Ignored by non-editor clients.
    completion: z
      .object({
        enabled: z.boolean().optional(),
        model: z.string().min(1).optional(),
        debounceMs: z.number().int().min(0).max(5000).optional(),
        maxTokens: z.number().int().positive().max(2000).optional(),
        fim: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Prompt-cache warming (opt-in): when true, the session keeps an Anthropic
    // ephemeral cache alive across idle gaps by replaying the last request with
    // a 1-token output cap at ~90% of the cache TTL — but only when the
    // expected savings beat the warm's own cost (see cacheWarmer). Default off.
    cacheWarming: z.boolean().optional(),
    // Prompt-cache breakpoint lifetime (Anthropic). "5m" (default) uses the
    // standard ephemeral TTL; "1h" asks for the extended one-hour TTL, which
    // reduces misses after long idle gaps at a higher cache-write price.
    // Endpoints that do not support the extended TTL silently fall back to 5m.
    promptCache: z
      .object({ ttl: z.enum(["5m", "1h"]).optional() })
      .strict()
      .optional(),
    // When true, createSession attempts to load the optional pure-JS
    // `gpt-tokenizer` package for provider-accurate token counts; falls back
    // to the built-in heuristic when the package is not installed.
    preciseTokens: z.boolean().optional(),
    // Structured audit log: when true (or an object), every tool call,
    // result, error and compaction is appended to ~/.codepilot/audit/.
    audit: z
      .union([z.boolean(), z.object({ dir: z.string().min(1).optional() }).strict()])
      .optional(),
    mcpServers: z.record(z.string().min(1), McpServerConfigSchema).optional(),
    // Language-server configs for the `lsp_navigate` tool (go-to-definition /
    // find-references / hover). Each entry maps language ids to a spawn command.
    // Built-in TypeScript/JavaScript default applies when omitted.
    lsp: z
      .object({
        servers: z
          .array(
            z.object({
              command: z.string().min(1),
              args: z.array(z.string()).optional(),
              languages: z.array(z.string().min(1)).min(1),
              initializationOptions: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .optional(),
      })
      .strict()
      .optional(),
    mcpToolDiscovery: z.enum(["auto", "lazy", "eager"]).optional(),
    mcpLazyThreshold: z.number().int().min(1).max(1000).optional(),
    // Allowlist of MCP server names that may start. Empty/omitted = no
    // restriction (every configured, non-disabled server starts). When
    // non-empty, a server whose name is NOT listed is refused start (and a
    // note is logged). Intended for a managed/enterprise layer to pin the set
    // of MCP servers that can run regardless of per-project config.
    mcpAllowedServers: z.array(z.string().min(1)).optional(),
    // Opt-in inbound channels: allow allowlisted MCP server notifications to be
    // delivered into the session as a synthesized user message. Default OFF —
    // with no config here, server notifications the client does not act on
    // internally are ignored. When `enabled`, only notifications whose
    // `server:method` (or bare `method`, or bare `server`) matches `allow` are
    // relayed; everything else stays ignored. This is a narrow, auditable relay,
    // NOT a general permission bridge.
    inboundChannels: z
      .object({
        enabled: z.boolean().optional(),
        // Allowlist entries match a notification by `server:method`, bare
        // `method`, or bare `server`. Empty/omitted with `enabled: true` relays
        // nothing (fail-safe: an explicit allowlist is required to deliver).
        allow: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    // Progressive disclosure for plugin-contributed tools, mirroring the MCP
    // controls above. Defaults to "eager" (every plugin tool schema is sent),
    // so the default behaviour is unchanged. Set "lazy" (or "auto" with a
    // threshold) when a plugin registers so many tools that their schemas crowd
    // the per-turn tool list: the individual schemas are then hidden and reached
    // on demand through the `tool_catalog` meta-tool (list/describe/call/batch).
    pluginToolDiscovery: z.enum(["auto", "lazy", "eager"]).optional(),
    pluginLazyThreshold: z.number().int().min(1).max(1000).optional(),
    // Context gauge precision. "off" (default) uses the local heuristic/usage
    // estimate for `/context`. "on-demand" lets `/context --precise` (or a UI
    // action) call the provider's token-count API once for an exact count;
    // precise counting never runs automatically (statusline refreshes, gauge
    // polls) and never feeds the compaction threshold.
    context: z
      .object({ preciseCount: z.enum(["off", "on-demand"]).optional() })
      .strict()
      .optional(),
    // Live streaming-degeneration guard: aborts a turn when the model's output
    // collapses into a short repeating unit (a looping clause that would
    // otherwise exhaust the output budget). Defaults match the built-in
    // constants. `enabled: false` turns the guard off entirely for deployments
    // that produce legitimately repetitive output (large tables, repeated
    // structure) and prefer never to risk a false positive. Orthogonal to the
    // tool-level doom-loop guard.
    degeneration: z
      .object({
        enabled: z.boolean().optional(),
        windowChars: z.number().int().min(100).max(100_000).optional(),
        maxPeriod: z.number().int().min(2).max(10_000).optional(),
        minRepeats: z.number().int().min(2).max(10_000).optional(),
        threshold: z.number().min(0.5).max(1).optional(),
        checkEveryChars: z.number().int().min(100).max(1_000_000).optional(),
      })
      .strict()
      .optional(),
    // Hard upper bound on how many bytes `read_file` will pull into memory for a
    // single read. A file larger than this is refused (with a hint to narrow the
    // read with bash/grep or raise the limit) BEFORE its contents are buffered,
    // so a giant log/data file can't OOM the process or block for a long time.
    // The default is deliberately wide (64 MiB) so ordinary source files are
    // never affected. Line-window parameters do not bypass it — a window still
    // requires reading the whole file, so the gate is on total size.
    maxReadBytes: z.number().int().min(4096).optional(),
    // `grep` search backend. "walker" (default) uses the dependency-free
    // built-in file walker. "rg" always shells out to ripgrep on PATH (falling
    // back to the walker if it is absent or fails). "auto" uses the walker but
    // tries ripgrep first when it is on PATH, since on a large tree the native
    // scan is much faster. No native dependency is bundled; the rg path is used
    // only when the binary is already installed.
    grep: z
      .object({ backend: z.enum(["walker", "rg", "auto"]).optional() })
      .strict()
      .optional(),
    // Instruction-file discovery. By default the hierarchical walk for
    // CODEPILOT.md / AGENTS(.override).md / CLAUDE(.local).md stops at the git
    // toplevel (or the cwd when not in a repo). `walkToHome: true` walks up to
    // the user's home directory instead.
    memory: z
      .object({
        walkToHome: z.boolean().optional(),
        // Query-time progressive recall: before a turn, pick the few memory
        // topic files most relevant to the query and attach their (truncated)
        // bodies to the volatile per-turn context so a relevant note is not
        // missed. Default on; disabled when auto-memory is off.
        autoRecall: z.boolean().optional(),
        // Max topic files recalled per turn. Default 5.
        recallMax: z.number().int().positive().max(20).optional(),
      })
      .strict()
      .optional(),
    autoApprove: z.array(z.string().min(1)).optional(),
    permissions: PermissionRulesSchema.optional(),
    sandbox: SandboxConfigSchema.optional(),
    // Extra secret-redaction patterns applied to tool output, ON TOP of the
    // built-in floor (AWS/OpenAI/Anthropic/GitHub keys, PEM blocks, bearer
    // tokens, connection-string/env/JSON secrets). Use this for deployment- or
    // org-specific secret shapes. A malformed regex is skipped; the built-in
    // floor always runs and cannot be disabled here.
    redact: z
      .object({
        patterns: z
          .array(
            z.object({
              name: z.string().min(1),
              regex: z.string().min(1),
              flags: z.string().optional(),
              replace: z.string().optional(),
            }),
          )
          .optional(),
      })
      .strict()
      .optional(),
    // 0 = unlimited. Positive caps the agent↔tool loop for CI / unattended
    // runs.
    maxTurns: z.number().int().min(0).max(10_000).optional(),
    // Soft convergence ceiling that applies even when maxTurns is unlimited:
    // after this many turns the loop winds down and disables tool calls for the
    // final turn, forcing the model to answer from what it already has instead
    // of spinning (e.g. a weak model re-verifying forever). 0 = disabled.
    convergenceCap: z.number().int().min(0).max(10_000).optional(),
    // Fine-grained convergence / no-progress thresholds. Every field defaults
    // to the built-in constant, so an absent block changes nothing. `cap` is an
    // alias for the soft convergence ceiling (0 disables it, matching
    // convergenceCap); the no-progress gradient and wind-down offsets below let
    // a long task raise or relax the backstops. Orthogonal to doomLoop.
    convergence: z
      .object({
        // Soft convergence ceiling (same meaning as convergenceCap; 0 = off).
        cap: z.number().int().min(0).max(10_000).optional(),
        // Turns of slack between where wind-down starts and the hard break.
        hardSlack: z.number().int().min(0).max(1000).optional(),
        // No-durable-progress turn count that triggers the soft nudge.
        noProgressSoft: z.number().int().min(1).max(10_000).optional(),
        // …the stronger nudge.
        noProgressStrong: z.number().int().min(1).max(10_000).optional(),
        // …the tool lock + synthesis urge (a soft land, not a failure).
        noProgressLock: z.number().int().min(1).max(10_000).optional(),
        // How many turns before the ceiling to emit the "turns left" nudge.
        remainingNudgeAt: z.number().int().min(1).max(1000).optional(),
      })
      .strict()
      .optional(),
    // Loop-detection thresholds + per-tool exclusions. Unset = built-in
    // constants; see DoomLoopConfigSchema.
    doomLoop: DoomLoopConfigSchema,
    // code_mode execution runtime. "vm" (default) runs the model's JavaScript
    // in an in-process Node vm context; "subprocess" runs it in a separate
    // Node child wrapped by the same OS sandbox as `bash`, so a stronger
    // isolation boundary is available opt-in. The delegated tool calls are
    // proxied back to the parent either way, so both runtimes expose the same
    // API and the same path guard. Unset/absent keeps the in-process default.
    codeMode: z
      .object({
        runtime: z.enum(["vm", "subprocess"]).optional(),
      })
      .strict()
      .optional(),
    // Per-model tool-exposure downgrade. Some models serialize structured
    // tool calls poorly on the more complex tools (e.g. `code_mode`,
    // `apply_patch`), tripping over the schema instead of using a simpler
    // tool. Each rule hides the listed tools from models whose id matches any
    // of `models` (glob over the model id, `*`/`?`). Applied AFTER mode
    // filtering, so it only ever removes tools, never adds them. Empty/unset =
    // no downgrade (every model sees the full mode-filtered set).
    toolExposure: z
      .array(
        z.object({
          models: z.array(z.string().min(1)).min(1),
          drop: z.array(z.string().min(1)).min(1),
        }),
      )
      .optional(),
    turnRetries: z.number().int().min(0).max(10).optional(),
    // When true, command hooks run under the same OS sandbox as `bash`
    // (Seatbelt / bwrap) instead of unsandboxed. Opt-in; default off.
    hookSandbox: z.boolean().optional(),
    // Max consecutive Stop-hook continues before forcing end (default 8).
    stopHookBlockCap: z.number().int().min(0).max(100).optional(),
    // Sub-agent (`task` tool) scale knobs. Conservative defaults live in
    // tools/task.ts; these let power users widen fan-out for very large tasks.
    // subagentTimeoutMs: per-sub-agent wall-clock budget (ms); unset = none.
    subagentTimeoutMs: z.number().int().positive().max(86_400_000).optional(),
    // subagentMaxDepth: nesting depth (default 3). 1 disables grandchildren.
    subagentMaxDepth: z.number().int().min(1).max(10).optional(),
    // subagentMaxThreads: concurrent sub-agents (default 6) — the main brake.
    subagentMaxThreads: z.number().int().min(1).max(64).optional(),
    // subagentMaxTotal: cumulative spawn cap for the whole run (default 200).
    subagentMaxTotal: z.number().int().min(1).max(100_000).optional(),
    // subagentPermissions: whether a built-in sub-agent (explore/worker, no
    // custom permissionMode) shares the parent's live PermissionEngine or runs
    // under a fresh, independent one.
    //   "inherit" (default) — share the parent engine: session-approved allow
    //     rules carry into the sub-agent, matching today's behavior.
    //   "independent" — give each sub-agent its own engine (mode "auto-edit",
    //     config autoApprove only), so a permission the user granted the parent
    //     mid-session does NOT silently widen the sub-agent's reach.
    // Custom agents with their own permissionMode are always independent.
    subagentPermissions: z.enum(["inherit", "independent"]).optional(),
    // subagentCache: durable reuse of a completed sub-agent's conclusion for an
    // identical spec within the TTL (makes an interrupted fan-out resumable).
    // enabled defaults true; ttlHours defaults 24. See types.ts.
    subagentCache: z
      .object({
        enabled: z.boolean().optional(),
        ttlHours: z.number().positive().max(24 * 365).optional(),
      })
      .optional(),
    // Built-in Stop validity gate (default off). See types.ts. The object form
    // adds `forceContinue`: by default the judge/tests result is advisory (a
    // non-blocking notice), and the turn still ends; `forceContinue: true` opts
    // into the older block->re-run behaviour (bounded by stopHookBlockCap, or a
    // lower default when unset).
    stopVerify: z
      .union([
        z.boolean(),
        z.enum(["off", "prompt", "tests"]),
        z
          .object({
            mode: z.enum(["off", "prompt", "tests"]),
            forceContinue: z.boolean().optional(),
          })
          .strict(),
      ])
      .optional(),
    // Opt-in: expose the `harness_bridge` tool (invoke claude/codex/custom
    // external agent CLIs as sandboxed subprocesses). Default off.
    enableHarnessBridge: z.boolean().optional(),
    // harness_bridge backend tuning. By default the bridge drives an external
    // harness through its one-shot CLI and scrapes stdout. Opt in here to allow
    // the official-protocol backend for a harness that ships one (currently
    // `codex` via its app-server JSON-RPC-over-stdio protocol), which gives a
    // structured final answer instead of scraped text. The CLI path stays the
    // default and the fallback; the protocol path is only taken when
    // `allowProtocol` is set AND the tool call asks for `backend: "protocol"`.
    harnessBridge: z
      .object({
        // Permit the protocol backend to be selected. Default false → only the
        // CLI path is ever used, regardless of a tool call's `backend`.
        allowProtocol: z.boolean().optional(),
        // Override the codex app-server launch command (argv). Default
        // `["codex", "app-server"]`. For testing or a pinned binary path.
        codexAppServerCommand: z.array(z.string().min(1)).optional(),
        // Child-process credential scrubbing. By default the spawned harness
        // does NOT inherit env vars whose names look like secrets (API keys,
        // tokens, passwords, cloud creds). `envKeep` adds exact key names back
        // (e.g. a key the harness legitimately needs); `envScrub` force-removes
        // additional exact key names. Set `scrubSecrets: false` to inherit the
        // full parent env (not recommended).
        scrubSecrets: z.boolean().optional(),
        envKeep: z.array(z.string().min(1)).optional(),
        envScrub: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    // When true, suggest_mode switches apply without re-asking the user
    // (the model proposes, the switch happens). Default off → user confirms.
    autoAcceptModeSuggestions: z.boolean().optional(),
    // Execution-reliability guards (anti-hallucination). See types.ts.
    // consistencyCheck: "off" | "warn" (default) | "throw" — verify that the
    // messages sent to the provider match the persisted event log.
    consistencyCheck: z.enum(["off", "warn", "throw"]).optional(),
    hooks: HooksConfigSchema.optional(),
    fallbacks: z.array(ProviderPresetSchema).optional(),
    // Failover routing policy for the `fallbacks` chain. Only transient
    // pressure (rate-limit / overload / 5xx / transport) cascades to the next
    // provider by default; auth and invalid-request errors never cascade. An
    // exhausted quota is usually account-wide, so `onQuota` defaults to "fail"
    // (surface the error) rather than "next" (try a same-account backup).
    fallbackPolicy: z
      .object({ onQuota: z.enum(["next", "fail"]).optional() })
      .strict()
      .optional(),
 // Provider HTTP retry tuning (429/5xx backoff). Defaults are generous
 // (8 retries, 2s base, 60s cap) so rate-limited gateways don't abort
 // long runs. Override per-config when you know the provider's quota
 // window (e.g. GLM's per-minute TPM resets after ~60s).
    maxRetries: z.number().int().positive().max(20).optional(),
    baseRetryDelayMs: z.number().int().positive().max(120_000).optional(),
    maxRetryDelayMs: z.number().int().positive().max(600_000).optional(),
 // Fail fast under sustained rate-limiting: once the next retry backoff
 // would exceed this many ms, abort and surface a recoverable error
 // instead of blocking the agent for a long backoff. Default 30000.
    retryAbortOnDelayMs: z.number().int().nonnegative().max(600_000).optional(),
 // v2 additions -----------------------------------------------------
    models: ModelsConfigSchema.optional(),
    providers: ProvidersConfigSchema,
    skills: SkillsConfigSchema,
    logging: LoggingConfigSchema,
    telemetry: TelemetryConfigSchema,
    usage: UsageConfigSchema,
    sessions: SessionsConfigSchema,
    statusLine: StatusLineConfigSchema,
    webFetch: WebFetchConfigSchema.optional(),
    webSearch: WebSearchConfigSchema.optional(),
    imageGen: ImageGenConfigSchema.optional(),
 // Agent runtime --------------------------------
 // Name of a registered AgentRuntime driving the prompt loop, plus a
 // free-form options bag keyed by runtime name. The values are opaque
 // here on purpose: a plugin runtime defines its own option shape and
 // validates it itself, and strict-mode would otherwise reject any
 // option the core has never heard of.
    runtime: z.string().min(1).optional(),
    runtimeOptions: z.record(z.string().min(1), z.unknown()).optional(),
 // First-run onboarding marker. Set (to an ISO timestamp) once the user has
 // been shown the first-launch setup guide — whether they completed it or
 // skipped it — so the TUI never auto-opens the guide again. User-scope only.
    onboardedAt: z.string().optional(),
 // Profile composition ----------------------------------------------
 // Named partial configs. Activated via `activeProfile` (config key,
 // CODEPILOT_PROFILE env var, or the `--profile <name>` CLI flag).
    profiles: z
      .record(
        z.string().min(1),
        z.lazy((): z.ZodType<unknown> => CodepilotConfigSchema)
      )
      .optional(),
    activeProfile: z.string().min(1).optional(),
  })
  .strict();

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type ModelModality = z.infer<typeof ModelModalitySchema>;
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
export type ProviderPreset = z.infer<typeof ProviderPresetSchema>;
export type ProvidersConfig = Record<string, ProviderPreset>;
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
export type UsageConfig = z.infer<typeof UsageConfigSchema>;

/** A fully-validated config produced by `loadConfigWithSources`. */
export type ResolvedCodepilotConfig = CodepilotConfig & {
  models?: ModelsConfig;
  providers?: ProvidersConfig;
  skills?: SkillsConfig;
  logging?: LoggingConfig;
  telemetry?: TelemetryConfig;
  usage?: UsageConfig;
 /** Named partial configs, activated via `activeProfile`. */
  profiles?: Record<string, ResolvedCodepilotConfig>;
 /** The profile to merge on top of the base config. */
  activeProfile?: string;
};

/** One layer of the merge, kept around for `loadConfigWithSources`. */
export interface ConfigLayer {
 /** Stable id of the layer for debugging. */
  name:
    | "defaults"
    | "managed"
    | "user"
    | "user-mcp"
    | "repo"
    | "mcp-json"
    | "env"
    | "caller"
    | "profile"
    | "patch";
 /** Path / env key, when the layer was sourced from a file or env var. */
  source?: string;
 /** The raw value (after interpolation, before merge with the next layer). */
  value: ResolvedCodepilotConfig;
}

export interface LoadConfigResult {
 /** The fully-merged, validated, interpolated config. */
  config: ResolvedCodepilotConfig;
 /** Per-layer information, in merge order (lowest priority first). */
  sources: ConfigLayer[];
}

// ---------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: ResolvedCodepilotConfig = {
  provider: undefined,
  model: undefined,
  smallModel: undefined,
  apiKey: undefined,
  baseURL: undefined,
  permissionMode: "ask",
  agentMode: "agent",
  sandbox: { mode: "workspace-write", network: true, fallback: "deny" },
  maxTokens: undefined,
  contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
  mcpServers: undefined,
  autoApprove: undefined,
  models: undefined,
  providers: undefined,
  skills: undefined,
  logging: { level: "info", console: true },
  telemetry: { enabled: false },
  usage: { enabled: false },
};

// ---------------------------------------------------------------------------
// Layered source file paths
// ---------------------------------------------------------------------------

export function getUserConfigPath(): string {
  return join(homedir(), ".codepilot", "config.json");
}

export const REPO_CONFIG_PATH = ".codepilot/config.json";

export function getRepoConfigPath(cwd: string): string {
  return join(cwd, REPO_CONFIG_PATH);
}

/**
 * Enterprise/MDM managed config path.
 *
 * On macOS: /Library/Application Support/CodePilot/managed.json
 * On Linux: /etc/codepilot/managed.json
 * On Windows: C:\ProgramData\CodePilot\managed.json
 *
 * The managed layer sits between `defaults` and `user`. For most keys it acts
 * as an administrator-set DEFAULT that later layers (user / repo / env / caller
 * / profile / patch) may override. For a small set of policy-critical
 * LOCK-KEYS (see {@link MANAGED_LOCK_KEYS}), a value present in the managed
 * layer is ENFORCED: no later layer can override it. This makes
 * "users cannot override" literally true for the keys enterprises most need to
 * pin (sandbox, permission mode, provider, MCP allowlist), while leaving every
 * other key as a soft managed default.
 *
 * Override the path with the `CODEPILOT_MANAGED_CONFIG` env var for testing.
 */
export function getManagedConfigPath(): string {
  const override = process.env.CODEPILOT_MANAGED_CONFIG;
  if (override) return override;
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/CodePilot/managed.json";
    case "win32":
      return join(process.env.PROGRAMDATA ?? "C:\\ProgramData", "CodePilot", "managed.json");
    default:
      return "/etc/codepilot/managed.json";
  }
}

/**
 * Policy-critical config keys that the managed (enterprise/MDM) layer ENFORCES:
 * when the managed config sets one of these, no later layer (user / repo / env
 * / caller / profile / patch) may override it. Every other key stays a soft
 * managed default. Keep this list narrow — it is the hard-lockdown surface.
 *
 * - `sandbox` — the OS sandbox policy (mode / network / fallback). Locked as a
 *   whole so a user cannot weaken any field (e.g. flip network back on).
 * - `permissionMode` — the ask/auto/yolo gate for tool side effects.
 * - `provider` — the model provider, for data-governance / egress control.
 * - `mcpAllowedServers` — the MCP server allowlist (see mcpAllowedServers).
 */
export const MANAGED_LOCK_KEYS = [
  "sandbox",
  "permissionMode",
  "provider",
  "mcpAllowedServers",
] as const;

// ---------------------------------------------------------------------------
// Environment variable interpolation
// ---------------------------------------------------------------------------

const ENV_INTERPOLATION = /\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g;

/**
 * Walk a value and replace every `${ENV}` / `${ENV:-default}` reference
 * with its process.env counterpart (or the literal default). Numbers,
 * booleans, and null are left alone. Object keys are not interpolated
 * (matching shell-style expansion).
 */
export function interpolateEnv(input: unknown): unknown {
  return walk(input, new Set<string>());
}

function walk(value: unknown, seen: Set<string>): unknown {
  if (typeof value === "string") return expandString(value, seen);
  if (Array.isArray(value)) return value.map((v) => walk(v, seen));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, seen);
    }
    return out;
  }
  return value;
}

function expandString(input: string, seen: Set<string>): string {
  return input.replace(ENV_INTERPOLATION, (match, name: string, def?: string) => {
    const envVal = process.env[name];
    if (envVal !== undefined && envVal !== "") return envVal;
    if (def !== undefined) return def;
 // No value and no default — leave the placeholder visible so the user
 // can see what's missing rather than getting a silent empty string.
    if (seen.has(name)) return match; // break cycles
    return "";
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a config candidate and return the cleaned object, or throw an
 * `Error` whose message contains a dotted field path for every issue.
 */
export function validateConfig(raw: unknown): ResolvedCodepilotConfig {
  const result = CodepilotConfigSchema.safeParse(raw);
  if (result.success) {
 // zod returns plain objects; ensure the runtime shape matches.
    return result.data as ResolvedCodepilotConfig;
  }
 // Flatten union errors to their most specific cause so the user sees a
 // field path (e.g. mcpServers.bad.command: Required) rather than a bare
 // "Invalid input".
  type IssueShape = { path?: (string | number)[]; message: string };
  const flattenIssues = (
    issues: Array<{ code: string; path?: (string | number)[]; message: string; unionErrors?: Array<{ issues?: IssueShape[] }> }>
  ): IssueShape[] => {
    const out: IssueShape[] = [];
    for (const issue of issues) {
      const firstBranch = issue.unionErrors ? issue.unionErrors[0] : undefined;
      const firstIssue = firstBranch && firstBranch.issues && firstBranch.issues.length > 0 ? firstBranch.issues[0] : undefined;
      out.push(firstIssue ?? { path: issue.path, message: issue.message });
    }
    return out;
  };
  const lines = flattenIssues(result.error.issues).map((i) => {
    const path = i.path && i.path.length > 0 ? i.path.join(".") : "<root>";
    let message = i.message;
    if (i.message === "Invalid input") {
      message =
        'expected a stdio transport (command) or a remote transport (type "http"|"sse" + url)';
    }
    return `  - ${path}: ${message}`;
  });
  throw new Error(`Invalid CodePilot config:\n${lines.join("\n")}`);
}

// ---------------------------------------------------------------------------
// Layered merge
// ---------------------------------------------------------------------------

/**
 * Layered, type-aware merge. Scalars from the override win; arrays are
 * concatenated; mcpServers are deep-merged (per-key); nested objects
 * (models / providers / skills / logging / telemetry / usage) are
 * shallow-merged key-by-key so that e.g. `logging.level` from one layer
 * can be overridden without clobbering `logging.file` from another.
 */
export function mergeConfig(
  base: Partial<CodepilotConfig> | undefined,
  override: Partial<CodepilotConfig> | undefined
): CodepilotConfig {
  const layers = [base, override];
  let out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    out = mergeOne(out, layer as Record<string, unknown>);
  }
  return out as CodepilotConfig;
}

function mergeOne(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, overrideVal] of Object.entries(override)) {
    const baseVal = out[key];
    if (
      baseVal && overrideVal &&
      typeof baseVal === "object" && !Array.isArray(baseVal) &&
      typeof overrideVal === "object" && !Array.isArray(overrideVal)
    ) {
      out[key] = mergeOne(baseVal as Record<string, unknown>, overrideVal as Record<string, unknown>);
    } else if (key === "autoApprove" && Array.isArray(baseVal) && Array.isArray(overrideVal)) {
      out[key] = [...baseVal, ...overrideVal];
    } else if (key === "mcpServers" && baseVal && overrideVal &&
               typeof baseVal === "object" && typeof overrideVal === "object") {
      out[key] = { ...(baseVal as Record<string, unknown>), ...(overrideVal as Record<string, unknown>) };
    } else if (key === "permissions" && baseVal && overrideVal &&
               typeof baseVal === "object" && typeof overrideVal === "object") {
 // Permission rules layer additively across user/project/local:
 // deny unions (absolute), allow/ask also union so a project can
 // extend the user's allow-list without redeclaring it.
      const bp = baseVal as Record<string, unknown>;
      const op = overrideVal as Record<string, unknown>;
      const merged: Record<string, unknown> = {};
      for (const eff of ["allow", "ask", "deny"]) {
        const a = Array.isArray(bp[eff]) ? (bp[eff] as string[]) : [];
        const b = Array.isArray(op[eff]) ? (op[eff] as string[]) : [];
        merged[eff] = [...a, ...b];
      }
      out[key] = merged;
    } else {
      out[key] = overrideVal;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Profile composition + JSON merge-patch
// ---------------------------------------------------------------------------

/**
 * Resolve the active profile on top of the base config.
 *
 * Looks up `config.profiles[name]` (where `name` defaults to
 * `config.activeProfile`) and merges it over the base with the same
 * type-aware merge semantics as {@link mergeConfig}. The profile's own
 * `profiles` / `activeProfile` keys are intentionally dropped — profiles
 * are flat (a profile cannot activate another profile), which keeps the
 * composition order easy to reason about:
 *
 * defaults < managed < user < repo < env < caller < profile < patch
 *
 * Returns the input unchanged when no profile is active. Throws a
 * descriptive error listing the known profile names when the requested
 * profile doesn't exist.
 */
export function resolveProfile(
  config: ResolvedCodepilotConfig,
  name?: string
): ResolvedCodepilotConfig {
  const profileName = name ?? config.activeProfile;
  if (!profileName) return config;
  const profiles = config.profiles;
  const profile = profiles?.[profileName];
  if (!profile) {
    const known = profiles ? Object.keys(profiles) : [];
    throw new Error(
      `Unknown config profile "${profileName}". ` +
        (known.length > 0
          ? `Known profiles: ${known.join(", ")}.`
          : `No "profiles" are defined in the config.`)
    );
  }
 // Strip meta keys from both sides before merging: the profile name has
 // been resolved, and profiles must not recursively activate profiles.
  const { profiles: _baseProfiles, ...baseRest } = config;
  const { profiles: _p, activeProfile: _a, ...profileRest } =
    profile as ResolvedCodepilotConfig;
  const merged = mergeOne(
    baseRest as Record<string, unknown>,
    profileRest as Record<string, unknown>
  );
  return {
    ...(merged as ResolvedCodepilotConfig),
    profiles,
    activeProfile: profileName,
  };
}

/**
 * Apply a JSON merge-patch (RFC 7386-ish) on top of a config.
 *
 * Semantics:
 * - objects merge recursively, key by key;
 * - scalars and arrays replace wholesale (patch arrays do NOT concatenate
 * with the base — a patch is an exact override, unlike layered config
 * files);
 * - `null` deletes the key from the base.
 *
 * Both inputs are treated as immutable; a fresh object is returned.
 */
export function applyConfigPatch(
  config: ResolvedCodepilotConfig,
  patch: Record<string, unknown>
): ResolvedCodepilotConfig {
  return patchObject(
    config as Record<string, unknown>,
    patch
  ) as ResolvedCodepilotConfig;
}

function patchObject(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, patchVal] of Object.entries(patch)) {
    if (patchVal === null) {
      delete out[key];
      continue;
    }
    const baseVal = out[key];
    if (isPlainObject(baseVal) && isPlainObject(patchVal)) {
      out[key] = patchObject(baseVal, patchVal);
    } else {
      out[key] = patchVal;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Environment variable layer
// ---------------------------------------------------------------------------

/** Read env vars that should be applied on top of file-based layers. */
export function readEnvOverrides(): Partial<CodepilotConfig> {
  const out: Partial<CodepilotConfig> = {};
  const provider = process.env.CODEPILOT_PROVIDER;
  if (
    provider &&
    (provider === "anthropic" ||
      provider === "openai" ||
      provider === "copilot" ||
      provider === "gemini" ||
      provider === "azure")
  ) {
    out.provider = provider as ProviderName;
  }
  const model = process.env.CODEPILOT_MODEL;
  if (model && model.length > 0) out.model = model;
  const apiKey = process.env.CODEPILOT_API_KEY;
  if (apiKey && apiKey.length > 0) out.apiKey = apiKey;
  const baseURL = process.env.CODEPILOT_BASE_URL;
  if (baseURL && baseURL.length > 0) out.baseURL = baseURL;
  const azureApiVersion = process.env.CODEPILOT_AZURE_API_VERSION;
  if (azureApiVersion && azureApiVersion.length > 0) out.azureApiVersion = azureApiVersion;
  const perm = process.env.CODEPILOT_PERMISSION_MODE;
  if (
    perm &&
    (perm === "ask" ||
      perm === "auto-edit" ||
      perm === "yolo" ||
      perm === "auto" ||
      perm === "dont-ask")
  ) {
    out.permissionMode = perm;
  }
  const profile = process.env.CODEPILOT_PROFILE;
  if (profile && profile.length > 0) {
    (out as ResolvedCodepilotConfig).activeProfile = profile;
  }
 // CODEPILOT_LOG_LEVEL is read by the logger, not stored on CodepilotConfig.
  return out;
}

// ---------------------------------------------------------------------------
// Public API: layered load
// ---------------------------------------------------------------------------

/**
 * Read `~/.codepilot/config.json` and `<cwd>/.codepilot/config.json`,
 * merge them (repo wins), apply env overrides, and validate. Missing
 * files are silently skipped.
 *
 * Kept stable for backwards compatibility — same signature as before.
 */
export async function loadConfig(cwd: string): Promise<CodepilotConfig> {
  const result = await loadConfigWithSources(cwd);
  return result.config;
}

/**
 * Full layered loader. Returns the merged config plus each layer's
 * contribution (for the `codepilot config` debug command).
 *
 * @param cwd current working directory
 * @param explicit optional caller-supplied overrides (highest priority
 * among the file/env layers; the profile and patch
 * composition steps still run on top of it)
 * @param options.readFiles when false, skip disk reads — useful in tests
 * and in environments where filesystem access is
 * unavailable.
 * @param options.profile profile name to activate (equivalent to the
 * `--profile <name>` CLI flag). Wins over
 * `activeProfile` from any layer.
 * @param options.patch JSON merge-patch applied on top of the fully
 * merged + profile-resolved config (equivalent to
 * the `--config-patch '<json>'` CLI flag).
 * @param options.homeDir override the home directory used to locate the
 * user-level config (defaults to os.homedir).
 * Primarily for tests and bundle export/import.
 */
export async function loadConfigWithSources(
  cwd: string,
  explicit?: Partial<CodepilotConfig>,
  options: {
    readFiles?: boolean;
    profile?: string;
    patch?: Record<string, unknown>;
    homeDir?: string;
  } = {}
): Promise<LoadConfigResult> {
  const readFiles = options.readFiles !== false;
  const userConfigPath = options.homeDir
    ? join(options.homeDir, ".codepilot", "config.json")
    : getUserConfigPath();

  const userPath = userConfigPath;
  const repoPath = getRepoConfigPath(cwd);

  const sources: ConfigLayer[] = [];

 // 1) defaults — always present, lowest priority.
  sources.push({ name: "defaults", value: { ...DEFAULT_CONFIG } });

 // 1b) enterprise/MDM managed config — sits between defaults and user.
 // IT administrators use this to enforce policies users cannot override.
  const managedPath = getManagedConfigPath();
  let managedLayer: Record<string, unknown> | undefined;
  if (readFiles && existsSync(managedPath)) {
    const parsed = await readAndParse(managedPath);
    if (parsed !== undefined) {
      managedLayer = parsed as Record<string, unknown>;
      sources.push({ name: "managed", source: managedPath, value: parsed });
    }
  }

 // 2) user-level file
  if (readFiles && existsSync(userPath)) {
    const parsed = await readAndParse(userPath);
    if (parsed !== undefined) {
      sources.push({ name: "user", source: userPath, value: parsed });
    }
  }

 // 2b) user-level MCP installs from Settings → 连接器 / MCP 市场
 // (`~/.codepilot/mcp.json`). Same shape as project `.mcp.json`.
  const userMcpPath = join(homedir(), ".codepilot", "mcp.json");
  if (readFiles && existsSync(userMcpPath)) {
    const parsed = await readAndParse(userMcpPath);
    if (parsed !== undefined && parsed.mcpServers && typeof parsed.mcpServers === "object") {
      sources.push({ name: "user-mcp", source: userMcpPath, value: parsed });
    }
  }

 // 3) repo-level file
  if (readFiles && existsSync(repoPath)) {
    const parsed = await readAndParse(repoPath);
    if (parsed !== undefined) {
      sources.push({ name: "repo", source: repoPath, value: parsed });
    }
  }

 // 3b) project-level .mcp.json. This file lives
 // at the repo root (NOT under .codepilot/) and contains ONLY an
 // `mcpServers` map. It lets projects ship MCP server definitions
 // alongside the code without polluting the user config. Merged at
 // the same priority as the repo-level config (project-scoped).
  const mcpJsonPath = join(cwd, ".mcp.json");
  if (readFiles && existsSync(mcpJsonPath)) {
    const parsed = await readAndParse(mcpJsonPath);
    if (parsed !== undefined && parsed.mcpServers && typeof parsed.mcpServers === "object") {
      sources.push({ name: "mcp-json", source: mcpJsonPath, value: parsed });
    }
  }

 // 4) env overrides
  const envLayer = readEnvOverrides();
  if (Object.keys(envLayer).length > 0) {
    sources.push({ name: "env", source: "process.env", value: envLayer as ResolvedCodepilotConfig });
  }

 // 5) explicit caller overrides
  if (explicit && Object.keys(explicit).length > 0) {
    sources.push({ name: "caller", source: "<inline>", value: explicit as ResolvedCodepilotConfig });
  }

 // Fold layers.
  let merged: Record<string, unknown> = {};
  for (const layer of sources) {
    merged = mergeOne(merged, layer.value as Record<string, unknown>);
  }

 // 6) profile composition — an explicit `options.profile` (the --profile
 // CLI flag) wins over `activeProfile` coming from any layer.
  let resolved = merged as ResolvedCodepilotConfig;
  if (options.profile) {
    resolved.activeProfile = options.profile;
  }
  if (resolved.activeProfile) {
    resolved = resolveProfile(resolved);
    sources.push({
      name: "profile",
      source: `profile:${resolved.activeProfile}`,
      value: resolved,
    });
  }

 // 7) JSON merge-patch (the --config-patch CLI flag) — the absolute last
 // word, applied after profile composition.
  if (options.patch && Object.keys(options.patch).length > 0) {
    resolved = applyConfigPatch(resolved, options.patch);
    sources.push({ name: "patch", source: "<inline>", value: resolved });
  }

 // 8) Managed lock-keys: re-assert the managed layer's value for any
 // policy-critical key it set, so no later layer (user / repo / env / caller /
 // profile / patch) could have overridden it. This is what makes "users cannot
 // override" literally true for the lockdown surface.
  if (managedLayer) {
    for (const key of MANAGED_LOCK_KEYS) {
      if (Object.prototype.hasOwnProperty.call(managedLayer, key)) {
        (resolved as Record<string, unknown>)[key] = managedLayer[key];
      }
    }
  }

 // Interpolate env references inside the merged value.
  const interpolated = interpolateEnv(resolved);

 // Validate (this is the "schema validation" boundary).
  const validated = validateConfig(interpolated);

  return { config: validated, sources };
}

// ---------------------------------------------------------------------------
// Provider / model resolution
// ---------------------------------------------------------------------------

/**
 * Switch active provider by looking it up in `config.providers`. Mutates
 * a copy of the config and returns it. Throws if the named preset
 * doesn't exist.
 */
export function useProvider(
  config: CodepilotConfig,
  name: string
): CodepilotConfig {
 // `providers` is a v2-only field; reach for it through a narrow
 // view of the config so the legacy `CodepilotConfig` type from
 // types.ts stays untouched.
  const extended = config as ResolvedCodepilotConfig;
  if (!extended.providers || !(name in extended.providers)) {
    throw new Error(
      `Unknown provider preset "${name}". Define it under "providers" in your config.`
    );
  }
  const preset = extended.providers[name];
  const out: CodepilotConfig = { ...config };
  if (preset.provider !== undefined) out.provider = preset.provider;
  if (preset.baseURL !== undefined) out.baseURL = preset.baseURL;
  if (preset.apiKey !== undefined) out.apiKey = preset.apiKey;
  if (preset.model !== undefined) out.model = preset.model;
  // azureApiVersion is a runtime provider field (consumed by OpenAIProvider for
  // Azure deployments). Carry it over too — otherwise switching to an Azure
  // preset silently drops its api-version and falls back to the built-in
  // default, hitting the wrong endpoint. The other preset fields (displayName /
  // models / modelCapabilities) are picker-only metadata that the flat runtime
  // config does not consume, so they intentionally do not flatten here.
  if (preset.azureApiVersion !== undefined) out.azureApiVersion = preset.azureApiVersion;
  // apiStyle is likewise a runtime provider field (OpenAI chat vs responses
  // dialect); flatten it so switching to a responses-style preset takes effect.
  if (preset.apiStyle !== undefined) out.apiStyle = preset.apiStyle;
  if (preset.smallModel !== undefined) {
    out.smallModel = preset.smallModel;
  } else if (config.smallModel) {
 // A smallModel inherited from another endpoint is usually not served by
 // this one (gateway 403 "model is not available"); keep it only when the
 // endpoint is unchanged or the preset lists it.
    const sameEndpoint = out.baseURL === config.baseURL && out.provider === config.provider;
    if (!sameEndpoint && !preset.models?.includes(config.smallModel)) delete out.smallModel;
  }
  return out;
}

/**
 * Resolve `config.model` through the alias table, if any. Aliases that
 * fail to map are returned as-is (so a plain "claude-sonnet-4-5" still
 * works).
 */
export function resolveModelAlias(config: CodepilotConfig): string | undefined {
  if (!config.model) return undefined;
  const extended = config as ResolvedCodepilotConfig;
  const alias = extended.models?.aliases?.[config.model];
  return alias ?? config.model;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readAndParse(
  path: string
): Promise<ResolvedCodepilotConfig | undefined> {
  try {
    const text = await readFile(path, "utf-8");
    const json = JSON.parse(text);
    return json as ResolvedCodepilotConfig;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new Error(
      `Failed to parse config ${path}: ${(err as Error).message}`
    );
  }
}

// Re-export for index.ts convenience.
export type { CodepilotConfig, McpServerConfig } from "./types.js";
