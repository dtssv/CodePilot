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

export const McpServerConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** claude-code style permission rule lists. */
export const PermissionRulesSchema = z
  .object({
    allow: z.array(z.string().min(1)).optional(),
    ask: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
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

/**
 * Top-level config schema. Every field is optional because configs layer
 * from defaults up; strict-mode means unknown keys produce a readable
 * validation error instead of being silently dropped.
 */
export const CodepilotConfigSchema = z
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
    mcpServers: z.record(z.string().min(1), McpServerConfigSchema).optional(),
    autoApprove: z.array(z.string().min(1)).optional(),
    permissions: PermissionRulesSchema.optional(),
    sandbox: SandboxConfigSchema.optional(),
    maxTurns: z.number().int().positive().max(500).optional(),
    // v2 additions -----------------------------------------------------
    models: ModelsConfigSchema.optional(),
    providers: ProvidersConfigSchema,
    skills: SkillsConfigSchema,
    logging: LoggingConfigSchema,
    telemetry: TelemetryConfigSchema,
    usage: UsageConfigSchema,
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
};

/** One layer of the merge, kept around for `loadConfigWithSources`. */
export interface ConfigLayer {
  /** Stable id of the layer for debugging. */
  name: "defaults" | "user" | "repo" | "env" | "caller";
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
  const lines = result.error.issues.map((i) => {
    const path = i.path.length === 0 ? "<root>" : i.path.join(".");
    return `  - ${path}: ${i.message}`;
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
    } else {
      out[key] = overrideVal;
    }
  }
  return out;
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
 * @param explicit       optional caller-supplied overrides (highest priority)
 * @param options.readFiles  when false, skip disk reads — useful in tests
 *                          and in environments where filesystem access is
 *                          unavailable.
 */
export async function loadConfigWithSources(
  cwd: string,
  explicit?: Partial<CodepilotConfig>,
  options: { readFiles?: boolean } = {}
): Promise<LoadConfigResult> {
  const readFiles = options.readFiles !== false;

  const userPath = getUserConfigPath();
  const repoPath = getRepoConfigPath(cwd);

  const sources: ConfigLayer[] = [];

  // 1) defaults — always present, lowest priority.
  sources.push({ name: "defaults", value: { ...DEFAULT_CONFIG } });

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

  // Interpolate env references inside the merged value.
  const interpolated = interpolateEnv(merged);

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
