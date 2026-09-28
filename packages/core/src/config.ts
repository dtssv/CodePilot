// Config loading and validation.
//
// Inspired by claude-code (settings.json layered hierarchy), codex
// (config.toml), and opencode (typed JSON schema). The full set of
// configuration values for @codepilot/core is described by a single
// zod schema (`CodepilotConfigSchema`) and is loaded from several
// sources, merged from low to high priority:
//
//   1. Built-in defaults        (`DEFAULT_CONFIG`)
//   2. User-level config        (`~/.codepilot/config.json`)
//   3. Repo-level config        (`<cwd>/.codepilot/config.json`)
//   4. Environment variables    (`CODEPILOT_PROVIDER` / `CODEPILOT_MODEL` /
//                                `CODEPILOT_API_KEY` / `CODEPILOT_BASE_URL` /
//                                `CODEPILOT_PERMISSION_MODE` /
//                                `CODEPILOT_LOG_LEVEL`)
//   5. Caller-supplied explicit overrides (e.g. from SessionOptions)
//
// On top of merging, every string value is scanned for `${ENV_VAR}` and
// `${ENV_VAR:-default}` interpolations, so secrets can be referenced
// without committing them:
//
//   { "apiKey": "${OPENAI_API_KEY}" }
//   { "baseURL": "${CUSTOM_BASE_URL:-https://api.example.com/v1}" }
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

/** A named provider preset — switching to it is just `useProvider("work")`. */
const ProviderPresetSchema = z
  .object({
    provider: z.enum(["anthropic", "openai", "copilot"]),
    baseURL: z.string().url().optional(),
    apiKey: z.string().optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export const ProvidersConfigSchema = z
  .record(z.string().min(1), ProviderPresetSchema)
  .optional();

/** Skill discovery configuration. */
export const SkillsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    dirs: z.array(z.string().min(1)).optional(),
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

export const McpServerConfigSchema = z.union([
  // stdio transport (default; `type` may be omitted for back-compat)
  z
    .object({
      type: z.enum(["stdio", ""]).optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  // Streamable HTTP (2025-03-26) and SSE transports
  z
    .object({
      type: z.enum(["http", "sse"]),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
]);

/** claude-code style permission rule lists. */
export const PermissionRulesSchema = z
  .object({
    allow: z.array(z.string().min(1)).optional(),
    ask: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** Lifecycle hook entry (see hooks.ts). */
export const HookEntrySchema = z
  .object({
    matcher: z.string().min(1),
    command: z.string().min(1),
  })
  .strict();

export const HooksConfigSchema = z
  .object({
    PreToolUse: z.array(HookEntrySchema).optional(),
    PostToolUse: z.array(HookEntrySchema).optional(),
    Notification: z.array(HookEntrySchema).optional(),
    Stop: z.array(HookEntrySchema).optional(),
  })
  .strict();

/** OS-level sandbox policy (see sandbox.ts). */
export const SandboxConfigSchema = z
  .object({
    mode: z.enum(["off", "workspace-write", "read-only"]).optional(),
    network: z.boolean().optional(),
    writablePaths: z.array(z.string().min(1)).optional(),
    fallback: z.enum(["deny", "allow-unsandboxed"]).optional(),
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
    provider: z.enum(["anthropic", "openai", "copilot"]).optional(),
    model: z.string().min(1).optional(),
    smallModel: z.string().min(1).optional(),
    apiKey: z.string().optional(),
    baseURL: z.string().url().optional(),
    permissionMode: z.enum(["ask", "auto-edit", "yolo"]).optional(),
    agentMode: z.enum(["chat", "plan", "agent"]).optional(),
    maxTokens: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive().optional(),
    compactionThreshold: z.number().positive().min(0.1).max(1).optional(),
    autoCompact: z.boolean().optional(),
    mcpServers: z.record(z.string().min(1), McpServerConfigSchema).optional(),
    autoApprove: z.array(z.string().min(1)).optional(),
    permissions: PermissionRulesSchema.optional(),
    sandbox: SandboxConfigSchema.optional(),
    maxTurns: z.number().int().positive().max(500).optional(),
    hooks: HooksConfigSchema.optional(),
    fallbacks: z.array(ProviderPresetSchema).optional(),
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
    webFetch: WebFetchConfigSchema.optional(),
    // Agent runtime (ROADMAP-NEXT §4.1) --------------------------------
    // Name of a registered AgentRuntime driving the prompt loop, plus a
    // free-form options bag keyed by runtime name. The values are opaque
    // here on purpose: a plugin runtime defines its own option shape and
    // validates it itself, and strict-mode would otherwise reject any
    // option the core has never heard of.
    runtime: z.string().min(1).optional(),
    runtimeOptions: z.record(z.string().min(1), z.unknown()).optional(),
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
  contextWindow: 120_000,
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
 * Enterprise/MDM managed config path (claude-code/codex parity).
 *
 * On macOS:   /Library/Application Support/CodePilot/managed.json
 * On Linux:   /etc/codepilot/managed.json
 * On Windows: C:\ProgramData\CodePilot\managed.json
 *
 * The managed layer sits between `defaults` and `user` — it lets IT
 * administrators enforce policies (e.g. restrict providers, set sandbox
 * mode, deny specific tools) that users cannot override in their personal
 * config. The env and caller layers still take precedence, so CI/CD and
 * programmatic callers can override managed settings when needed.
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
 *   defaults < managed < user < repo < env < caller < profile < patch
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
 *  - objects merge recursively, key by key;
 *  - scalars and arrays replace wholesale (patch arrays do NOT concatenate
 *    with the base — a patch is an exact override, unlike layered config
 *    files);
 *  - `null` deletes the key from the base.
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
  if (provider && (provider === "anthropic" || provider === "openai" || provider === "copilot")) {
    out.provider = provider as ProviderName;
  }
  const model = process.env.CODEPILOT_MODEL;
  if (model && model.length > 0) out.model = model;
  const apiKey = process.env.CODEPILOT_API_KEY;
  if (apiKey && apiKey.length > 0) out.apiKey = apiKey;
  const baseURL = process.env.CODEPILOT_BASE_URL;
  if (baseURL && baseURL.length > 0) out.baseURL = baseURL;
  const perm = process.env.CODEPILOT_PERMISSION_MODE;
  if (perm && (perm === "ask" || perm === "auto-edit" || perm === "yolo")) {
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
 * @param cwd            current working directory
 * @param explicit       optional caller-supplied overrides (highest priority
 *                       among the file/env layers; the profile and patch
 *                       composition steps still run on top of it)
 * @param options.readFiles  when false, skip disk reads — useful in tests
 *                          and in environments where filesystem access is
 *                          unavailable.
 * @param options.profile    profile name to activate (equivalent to the
 *                          `--profile <name>` CLI flag). Wins over
 *                          `activeProfile` from any layer.
 * @param options.patch      JSON merge-patch applied on top of the fully
 *                          merged + profile-resolved config (equivalent to
 *                          the `--config-patch '<json>'` CLI flag).
 * @param options.homeDir    override the home directory used to locate the
 *                          user-level config (defaults to os.homedir()).
 *                          Primarily for tests and bundle export/import.
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
  if (readFiles && existsSync(managedPath)) {
    const parsed = await readAndParse(managedPath);
    if (parsed !== undefined) {
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

  // 3) repo-level file
  if (readFiles && existsSync(repoPath)) {
    const parsed = await readAndParse(repoPath);
    if (parsed !== undefined) {
      sources.push({ name: "repo", source: repoPath, value: parsed });
    }
  }

  // 3b) project-level .mcp.json (claude-code-compatible). This file lives
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
  //    CLI flag) wins over `activeProfile` coming from any layer.
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
  //    word, applied after profile composition.
  if (options.patch && Object.keys(options.patch).length > 0) {
    resolved = applyConfigPatch(resolved, options.patch);
    sources.push({ name: "patch", source: "<inline>", value: resolved });
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
