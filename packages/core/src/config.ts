// Config loading and validation. Single zod schema (`CodepilotConfigSchema`),
// merged low→high: defaults, ~/.codepilot/config.json, <cwd>/.codepilot/config.json,
// env vars, caller overrides. String values support ${ENV_VAR} / ${ENV_VAR:-default}
// interpolation. Prefer `loadConfigWithSources` for per-layer source info.

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

/** Per-model context / modality settings stored on a provider preset.
 * `contextWindowMax` is the provider-reported ceiling (often omitted);
 * `contextWindow` is the user-effective budget (≤ max when set). */
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

/** Loop-detection thresholds and exclusions. All fields optional, defaulting
 * to built-in constants. `refuseAt` is conservative: a refused call has side
 * effects on legitimate retries, so prefer warning over refusing. `exclude`
 * lists tool names / `tool::glob` patterns never counted toward layers 1/2. */
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
    /** Whether a tripped rotating-batch loop (layer 2) REFUSES the call
     * (default true) or only WARNS. Set false for a warn-only layer 2 that
     * steers without a side-effecting hard refusal — the counterpart of
     * `refuseAt: 0` for the exact-repetition layer. */
    seqRefuse: z.boolean().optional(),
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
    // On daemon boot, seal any session left in-flight (crash/kill) to idle.
    // Default true; false defers sealing until next open. Seal-and-idle only —
    // never re-enters the agent loop, to avoid double execution of side effects.
    reconcileOnBoot: z.boolean().optional(),
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

// Status line: declarative preset (no scripting) or custom command; union on
// `type`.
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
    /** Policy for reads/writes OUTSIDE the working set (cwd + extra dirs +
     * sandbox roots + delivery roots). `ask` (default) prompts; `deny-write`
     * hard-denies writes only; `deny-read-write` denies reads AND writes. */
    workspaceBoundary: z.enum(["ask", "deny-write", "deny-read-write"]).optional(),
    /** Extra directories treated as in-boundary in addition to cwd; UI
     * "Allow this directory" grants persist here. */
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
    // Unset leaves `.git` writable; set true to carve it. See types.ts
    // SandboxConfig.protectGit.
    protectGit: z.boolean().optional(),
    // How `.git` is treated at the OS sandbox layer; wins over `protectGit`.
    //   "protect"       — carve `.git` read-only (= protectGit:true)
    //   "allow-git-cli" — leave `.git` writable so git CLI works (default)
    //   "ask"           — same as allow-git-cli; file-tool `.git` write asks
    gitWrite: z.enum(["protect", "allow-git-cli", "ask"]).optional(),
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
 * Top-level config schema. All fields optional (configs layer from defaults
 * up); strict-mode rejects unknown keys. `profiles`/`activeProfile` compose.
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
    // Reasoning / thinking controls.
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    modelVerbosity: z.enum(["low", "medium", "high"]).optional(),
    // Anthropic extended-thinking budget in tokens. 0 / undefined = off.
    // Overrides the budget derived from reasoningEffort.
    thinkingBudget: z.number().int().nonnegative().max(200_000).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxContextTokens: z.number().int().positive().optional(),
    // Rolling tool-output window: fold tool_results older than the keep window
    // down to this many, independent of the token budget, so numerous small
    // results can't quietly accumulate. Default 24; 0 folds all old results;
    // omit/large disables the early trim (budget-based fold still applies).
    maxToolResultsInContext: z.number().int().min(0).max(1000).optional(),
    compactionThreshold: z.number().positive().min(0.1).max(1).optional(),
    autoCompact: z.boolean().optional(),
    // Consecutive failed/ineffective auto-compactions before the circuit
    // breaker disables auto-compaction for the session (default 3). A manual
    // /compact that gets back under budget re-enables it.
    autoCompactMaxConsecutiveFailures: z.number().int().min(1).max(100).optional(),
    // `auto` permission mode classifier tuning: denial caps past which it
    // falls back to an interactive prompt.
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
    // Inline (Tab) code completion for editor plugins. Off by default;
    // ignored by non-editor clients.
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
    // Prompt-cache warming (opt-in): keep an Anthropic ephemeral cache alive
    // across idle gaps by replaying the last request at ~90% of the cache TTL
    // when the expected savings beat the warm's own cost. Default off.
    cacheWarming: z.boolean().optional(),
    // Prompt-cache breakpoint lifetime (Anthropic). "5m" (default) or "1h"
    // (extended; falls back to 5m where unsupported).
    promptCache: z
      .object({ ttl: z.enum(["5m", "1h"]).optional() })
      .strict()
      .optional(),
    // When true, load the optional `gpt-tokenizer` package for provider-accurate
    // token counts; falls back to the built-in heuristic if not installed.
    preciseTokens: z.boolean().optional(),
    // Structured audit log: append every tool call/result/error/compaction to
    // ~/.codepilot/audit/.
    audit: z
      .union([z.boolean(), z.object({ dir: z.string().min(1).optional() }).strict()])
      .optional(),
    mcpServers: z.record(z.string().min(1), McpServerConfigSchema).optional(),
    // Language-server configs for the `lsp_navigate` tool. Maps language ids to
    // a spawn command; built-in TypeScript/JavaScript default applies when omitted.
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
    // restriction; non-empty refuses unlisted servers. Enterprise lock-down.
    mcpAllowedServers: z.array(z.string().min(1)).optional(),
    // Opt-in inbound channels: relay allowlisted MCP server notifications into
    // the session as a synthesized user message. Default OFF. When enabled, only
    // notifications matching `allow` (`server:method`, bare `method`, or bare
    // `server`) are relayed — a narrow auditable relay, not a general bridge.
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
    // controls. Default "eager" (all schemas sent). "lazy"/"auto" hide schemas
    // and reach them on demand via the `tool_catalog` meta-tool when a plugin
    // registers too many tools.
    pluginToolDiscovery: z.enum(["auto", "lazy", "eager"]).optional(),
    pluginLazyThreshold: z.number().int().min(1).max(1000).optional(),
    // Context gauge precision. "off" (default) uses the local estimate;
    // "on-demand" calls the provider token-count API once for an exact count via
    // `/context --precise`, never automatically and never feeding the compaction
    // threshold.
    context: z
      .object({ preciseCount: z.enum(["off", "on-demand"]).optional() })
      .strict()
      .optional(),
    // Live streaming-degeneration guard: aborts a turn when output collapses
    // into a short repeating unit. `enabled: false` disables it entirely
    // (for legitimately repetitive output). Orthogonal to the tool-level
    // doom-loop guard.
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
    // Hard byte limit a single `read_file` buffers; larger files are refused
    // before reading. Default 64 MiB. Line windows don't bypass it — a window
    // still reads the whole file, so the gate is on total size.
    maxReadBytes: z.number().int().min(4096).optional(),
    // `grep` search backend. "walker" (default, dependency-free), "rg" (always
    // shell out to ripgrep, fall back to walker), or "auto" (walker, but try
    // ripgrep first on PATH). No native dependency is bundled.
    grep: z
      .object({ backend: z.enum(["walker", "rg", "auto"]).optional() })
      .strict()
      .optional(),
    // Instruction-file discovery. The hierarchical walk for CODEPILOT.md /
    // AGENTS(.override).md / CLAUDE(.local).md stops at the git toplevel (or
    // cwd when not in a repo); `walkToHome: true` walks up to home instead.
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
    // Extra secret-redaction patterns on top of the built-in floor (AWS/OpenAI/
    // Anthropic/GitHub keys, PEM blocks, bearer tokens, connection strings). A
    // malformed regex is skipped; the built-in floor always runs.
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
    // final turn. 0 = disabled.
    convergenceCap: z.number().int().min(0).max(10_000).optional(),
    // Fine-grained convergence / no-progress thresholds (all default to
    // built-in constants). `cap` aliases the soft convergence ceiling (0 = off);
    // the no-progress gradient and wind-down offsets raise or relax backstops.
    // Orthogonal to doomLoop.
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
    // code_mode execution runtime. "vm" (default) runs JavaScript in-process;
    // "subprocess" runs it in a separate Node child under the same OS sandbox as
    // `bash` for stronger isolation. Both expose the same tool API and path
    // guard. Unset keeps the in-process default.
    codeMode: z
      .object({
        runtime: z.enum(["vm", "subprocess"]).optional(),
      })
      .strict()
      .optional(),
    // Per-model tool-exposure downgrade: hide `drop` tools from models matching
    // `models` (glob over the model id). Applied AFTER mode filtering (only
    // removes, never adds). Empty/unset = no downgrade.
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
    // Sub-agent (`task` tool) scale knobs. Defaults live in tools/task.ts.
    // subagentTimeoutMs: per-sub-agent wall-clock budget (ms); unset = none.
    subagentTimeoutMs: z.number().int().positive().max(86_400_000).optional(),
    // subagentMaxDepth: nesting depth (default 3). 1 disables grandchildren.
    subagentMaxDepth: z.number().int().min(1).max(10).optional(),
    // subagentMaxThreads: concurrent sub-agents (default 6) — the main brake.
    subagentMaxThreads: z.number().int().min(1).max(64).optional(),
    // subagentMaxTotal: cumulative spawn cap for the whole run (default 200).
    subagentMaxTotal: z.number().int().min(1).max(100_000).optional(),
    // subagentPermissions: whether a built-in sub-agent shares the parent's
    // live PermissionEngine ("inherit", default) or gets a fresh independent
    // one ("independent") so a mid-session parent grant doesn't widen it.
    // Custom agents with their own permissionMode are always independent.
    subagentPermissions: z.enum(["inherit", "independent"]).optional(),
    // subagentCache: durable reuse of a completed sub-agent's conclusion for an
    // identical spec within the TTL. enabled defaults true; ttlHours defaults 24.
    subagentCache: z
      .object({
        enabled: z.boolean().optional(),
        ttlHours: z.number().positive().max(24 * 365).optional(),
      })
      .optional(),
    // Built-in Stop validity gate (default off). By default the result is
    // advisory (non-blocking); `forceContinue: true` opts into block→re-run
    // behaviour (bounded by stopHookBlockCap).
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
    // Opt-in: expose the `harness_bridge` tool (invoke external agent CLIs as
    // sandboxed subprocesses). Default off.
    enableHarnessBridge: z.boolean().optional(),
    // harness_bridge backend tuning. Default drives the harness through its
    // one-shot CLI and scrapes stdout. `allowProtocol` opts into the
    // official-protocol backend (codex app-server JSON-RPC-over-stdio) for a
    // structured answer, taken only when set AND the call asks for it.
    harnessBridge: z
      .object({
        // Permit the protocol backend to be selected. Default false → only the
        // CLI path is ever used, regardless of a tool call's `backend`.
        allowProtocol: z.boolean().optional(),
        // Override the codex app-server launch command (argv). Default
        // `["codex", "app-server"]`. For testing or a pinned binary path.
        codexAppServerCommand: z.array(z.string().min(1)).optional(),
        // Child-process credential scrubbing. By default the spawned harness
        // does NOT inherit secret-like env vars. `envKeep` adds keys back,
        // `envScrub` force-removes keys, `scrubSecrets: false` inherits the full
        // parent env (not recommended).
        scrubSecrets: z.boolean().optional(),
        envKeep: z.array(z.string().min(1)).optional(),
        envScrub: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    // When true, suggest_mode switches apply without re-asking the user
    // (the model proposes, the switch happens). Default off → user confirms.
    autoAcceptModeSuggestions: z.boolean().optional(),
    // Execution-reliability guards (anti-hallucination).
    // consistencyCheck: verify messages sent to the provider match the persisted
    // event log — "off" | "warn" (default) | "throw".
    consistencyCheck: z.enum(["off", "warn", "throw"]).optional(),
    hooks: HooksConfigSchema.optional(),
    fallbacks: z.array(ProviderPresetSchema).optional(),
    // Failover routing policy for `fallbacks`. Only transient pressure
    // (rate-limit / overload / 5xx / transport) cascades by default; auth and
    // invalid-request errors never do. `onQuota` defaults to "fail" (quota is
    // usually account-wide) rather than "next".
    fallbackPolicy: z
      .object({ onQuota: z.enum(["next", "fail"]).optional() })
      .strict()
      .optional(),
 // Provider HTTP retry tuning (429/5xx backoff). Defaults are generous
 // (8 retries, 2s base, 60s cap) so rate-limited gateways don't abort
 // long runs.
    maxRetries: z.number().int().positive().max(20).optional(),
    baseRetryDelayMs: z.number().int().positive().max(120_000).optional(),
    maxRetryDelayMs: z.number().int().positive().max(600_000).optional(),
 // Fail fast under sustained rate-limiting: once the next backoff would
 // exceed this many ms, abort with a recoverable error. Default 30000.
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
 // Agent runtime: name of a registered AgentRuntime driving the prompt loop,
 // plus an opaque options bag (a plugin runtime defines and validates its own
 // option shape, so strict-mode can't enumerate them here).
    runtime: z.string().min(1).optional(),
    runtimeOptions: z.record(z.string().min(1), z.unknown()).optional(),
 // First-run onboarding marker: set (ISO timestamp) once the first-launch
 // setup guide has been shown, so the TUI never auto-opens it again. User-scope.
    onboardedAt: z.string().optional(),
 // Profile composition: named partial configs, activated via `activeProfile`
 // (config key, CODEPILOT_PROFILE env var, or `--profile <name>` CLI flag).
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
 * Enterprise/MDM managed config path (macOS /Library/Application Support/CodePilot,
 * Linux /etc/codepilot, Windows %ProgramData%\CodePilot). Soft admin default for
 * most keys; ENFORCED for policy LOCK-KEYS ({@link MANAGED_LOCK_KEYS}).
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
 * Policy-critical config keys the managed (enterprise/MDM) layer ENFORCES:
 * no later layer (user/repo/env/caller/profile/patch) may override them.
 * - `sandbox`, `permissionMode`, `provider`, `mcpAllowedServers`.
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

/** Replace every `${ENV}` / `${ENV:-default}` reference with its process.env
 * value (or the default). Numbers/booleans/null are left alone; object keys are
 * not interpolated (shell-style). */
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
 * Layered, type-aware merge. Scalars: override wins. Arrays: concatenated.
 * mcpServers: deep-merged per-key. Nested objects: shallow-merged key-by-key.
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
 * Resolve the active profile over the base via {@link mergeConfig}.
 * Composition: defaults < managed < user < repo < env < caller < profile < patch.
 * Profiles are flat. Returns input unchanged when none active; throws if unknown.
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
 * Apply a JSON merge-patch (RFC 7386-ish). Objects merge recursively;
 * scalars/arrays replace wholesale (patch arrays do NOT concatenate);
 * `null` deletes the key. Both inputs immutable; a fresh object returned.
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

/** Read `~/.codepilot/config.json` and `<cwd>/.codepilot/config.json`, merge
 * them (repo wins), apply env overrides, and validate. Missing files skipped. */
export async function loadConfig(cwd: string): Promise<CodepilotConfig> {
  const result = await loadConfigWithSources(cwd);
  return result.config;
}

/**
 * Full layered loader: returns merged config plus each layer's contribution.
 * @param cwd working directory
 * @param explicit caller overrides; profile and patch compose on top
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
  // azureApiVersion is a runtime provider field; carry it over so switching to
  // an Azure preset doesn't silently drop its api-version. Picker-only metadata
  // (displayName/models/modelCapabilities) intentionally does not flatten.
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
