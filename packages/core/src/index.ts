// @codepilot/core public API. Mirrors docs/API.md exactly.

// ---- Types ----
export type {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
  PlanStep,
  UsageInfo,
  Event,
  MessageDelta,
  TextDelta,
  ToolInputJsonDelta,
  AgentMode,
  PermissionMode,
  PermissionRules,
  SandboxConfig,
  HooksConfig,
  HookEntryConfig,
  ProviderFallbackConfig,
  WebFetchConfig,
  QuestionSpec,
  QuestionRequest,
  QuestionAnswers,
  PermissionRequest,
  PermissionDecision,
  CodepilotConfig,
  McpServerConfig,
  SessionOptions,
  SessionSummary,
  ImageAttachment,
  GoalRunOptions,
  GoalRunResult,
  ProviderName,
} from "./types.js";

// ---- Config ----
export { loadConfig, mergeConfig } from "./config.js";

// ---- Providers ----
export {
  AnthropicProvider,
  OpenAIProvider,
  CopilotProvider,
  parseSse,
  renderContent,
  userMessage,
} from "./providers/index.js";
export type {
  AnthropicProviderOptions,
  OpenAIProviderOptions,
  CopilotProviderOptions,
  ChatProvider,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolDef,
  StreamChatOptions,
  StreamEvent,
  AssistantAccumulator,
} from "./providers/index.js";

// ---- Tools ----
export {
  ToolRegistry,
  zodToJsonSchema,
  bashTool,
  bashOutputTool,
  bashKillTool,
  webFetchTool,
  webSearchTool,
  askUserQuestionTool,
  planDoneTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  applyEdit,
  globTool,
  grepTool,
  lsTool,
  planUpdateTool,
  memoryWriteTool,
  readArtifactTool,
  taskTool,
  ArtifactStore,
  filterToolsByMode,
  filterToolsByModeFromRegistry,
  filterToolNames,
} from "./tools/index.js";
export type {
  ToolDef,
  ToolContext,
  ToolResult,
  PermissionLevel,
  EditOutcome,
  MemorySink,
  SubagentRunner,
} from "./tools/index.js";

// ---- Permissions ----
export { PermissionEngine, matchRule, persistRule } from "./permissions.js";
export type { PermissionCheckResult } from "./permissions.js";

// ---- Sandbox ----
export {
  resolveSandbox,
  wrapCommand,
  buildSeatbeltProfile,
  detectSandboxBackend,
  assertPathAllowed,
  assertPathAllowedAsync,
  checkDangerousCommand,
  winPathToWsl,
  SENSITIVE_READ_PATHS,
} from "./sandbox.js";
export type {
  ResolvedSandbox,
  WrappedCommand,
  SandboxBackend,
  PathCheckResult,
} from "./sandbox.js";

// ---- Hooks ----
export { HookEngine, hashCommand } from "./hooks.js";
export type { HookEvent, HookEntry, PreHookResult, PostHookResult } from "./hooks.js";

// ---- Redaction ----
export { redactSecrets, containsSecretShape } from "./redact.js";

// ---- Provider fallback ----
export { FallbackProvider, isFailoverError } from "./providers/fallback.js";

// ---- Memory ----
export {
  readMemory,
  readLayeredProjectMemory,
  FileMemorySink,
  summariseMemory,
  memoryFileExists,
  PROJECT_MEMORY_NAME,
  AGENTS_MEMORY_NAME,
  USER_MEMORY_PATH,
} from "./memory.js";
export type { MemoryContents } from "./memory.js";

// ---- System prompt ----
export { buildSystemPrompt } from "./systemPrompt.js";
export type { SystemPromptContext, SystemPromptResult } from "./systemPrompt.js";

// ---- Compaction ----
export {
  compact,
  shouldCompact,
  foldToolResults,
  estimateEventTokens,
  eventsToMessages,
  extractPlan,
} from "./compaction.js";
export type {
  CompactionOptions,
  CompactionResult,
  CompactionDecision,
} from "./compaction.js";

// ---- MCP ----
export { McpStdioClient, McpManager, mcpToolName, parseMcpToolName } from "./mcp.js";
export type { McpToolDescriptor, McpInvokeRequest, McpInvokeResult } from "./mcp.js";

// ---- Agent ----
export { runAgent } from "./agent.js";
export type { AgentDeps, AgentRunInput, AgentRunResult } from "./agent.js";

// ---- Session ----
export { Session, createSession, listSessions, SESSIONS_DIR } from "./session.js";

// ---- Goal ----
export { runGoal } from "./goal.js";

// ---- Config (v2 layered loader) ----
// NOTE: `loadConfig` and `mergeConfig` are already exported above in the
// legacy "Config" block; re-exporting them here would be a duplicate.
export {
  loadConfigWithSources,
  validateConfig,
  interpolateEnv,
  useProvider,
  resolveModelAlias,
  getUserConfigPath,
  getManagedConfigPath,
  getRepoConfigPath,
  REPO_CONFIG_PATH,
  DEFAULT_CONFIG,
  CodepilotConfigSchema,
  ModelsConfigSchema,
  ProvidersConfigSchema,
  SkillsConfigSchema,
  LoggingConfigSchema,
  TelemetryConfigSchema,
  UsageConfigSchema,
  McpServerConfigSchema,
} from "./config.js";
export type {
  ModelsConfig,
  ProvidersConfig,
  ProviderPreset,
  SkillsConfig,
  LoggingConfig,
  TelemetryConfig,
  UsageConfig,
  ResolvedCodepilotConfig,
  ConfigLayer,
  LoadConfigResult,
} from "./config.js";

// ---- Logger ----
export {
  createLogger,
  initLoggerFromConfig,
  getLoggerState,
  setLoggerState,
  rotateIfNeeded,
  defaultLogFilePath,
  clearLogsDir,
  __resetLoggerForTests,
  LOG_LEVELS,
} from "./logger.js";
export type {
  Logger,
  LoggerConfig,
  LoggerState,
  LogLevel,
  LogRecord,
  LogSink,
} from "./logger.js";

// ---- Skills ----
export {
  parseSkillMd,
  discoverSkills,
  matchSkill,
  findSkill,
  skillsPromptSection,
  defaultBuiltinSkillsDir,
  BUILTIN_SKILLS,
} from "./skills.js";
export type { Skill, SkillSource, DiscoverOptions } from "./skills.js";

export { skillTool, createSkillTool, StaticSkillStore, setDefaultSkillStore } from "./tools/skill.js";
export type { SkillStore, SkillToolHandle } from "./tools/skill.js";

// ---- Slash commands (custom /name commands from .codepilot/commands/*.md) ----
export {
  parseSlashCommandMd,
  discoverSlashCommands,
  findSlashCommand,
  commandHelpLine,
  renderCommandPrompt,
  interpolateTemplate,
  isValidCommandName,
  resolveSlashCommand,
  resolveCommandsDir,
  commandsDirFor,
  userCommandsDir,
  commandFilePath,
  commandDir,
} from "./slashCommands.js";
export type {
  SlashCommand,
  SlashCommandSource,
  SlashCommandFrontmatter,
  DiscoverSlashCommandsOptions,
  DiscoverSlashCommandsResult,
  ResolveResult,
} from "./slashCommands.js";

// ---- MCP (extended — adds SSE, resources, prompts, fail-soft) ----
// Note: McpStdioClient, McpManager, mcpToolName, parseMcpToolName,
// McpToolDescriptor, McpInvokeRequest, McpInvokeResult are already
// exported above in the legacy "MCP" block.
export { McpSseClient, isMcpSseConfig, mcpResourceToolName, MCP_REF_REGEX, parseMcpReference, resolveMcpReferences } from "./mcp.js";
export type {
  McpResourceDescriptor,
  McpResourceReadResult,
  McpPromptDescriptor,
  McpStdioServerConfig,
  McpSseServerConfig,
  McpServerConfigEntry,
  McpClient,
  McpStartError,
  McpServerRequestHandler,
  McpElicitationResult,
  McpSamplingResult,
} from "./mcp.js";

// ---- Tokens (estimator + per-model context windows) ----
export {
  estimateTokens,
  estimateMessagesTokens,
  estimateObjectTokens,
  estimateEventsTokens,
  lookupContextWindow,
  resolveCompactionThreshold,
  estimateCostUSD,
} from "./tokens.js";
export type { TokenEstimator, ModelContextWindow, ModelCost } from "./tokens.js";

// ---- Checkpoints (cross-session memory files) ----
export {
  CHECKPOINT_SECTIONS,
  shouldCheckpoint as shouldCheckpointNow,
  buildCheckpointSnapshot,
  renderCheckpointMarkdown,
  parseCheckpointMarkdown,
  writeCheckpoint,
  appendCheckpointRound,
  readCheckpoint,
  checkpointExists,
  checkpointPath,
  summariseCheckpointForPrompt,
  makeCheckpointHook,
} from "./checkpoints.js";
export type {
  CheckpointSection,
  CheckpointOptions,
  CheckpointTrigger,
  CheckpointSnapshot,
  CheckpointHook,
  WriteCheckpointResult,
} from "./checkpoints.js";

// ---- Snapshots (checkpoint rewind) ----
export {
  createSnapshot,
  rewindToSnapshot,
  listSnapshots,
  deleteSnapshot,
} from "./snapshots.js";

// ---- Memory (structured sections) ----
export {
  MEMORY_SECTIONS,
  parseMemory,
  renderMemory,
  classifySection,
  summariseMemoryText,
} from "./memory.js";
export type { MemorySection as MemorySectionName, ParsedMemory } from "./memory.js";

// ---- Session (auto-title, search, export, rich summary) ----
export {
  getSessionsDir,
  searchSessions,
  exportSession,
  deleteSession,
} from "./session.js";
export type {
  RichSessionSummary,
  SessionExportFormat,
} from "./session.js";

// ---- Goal (checkpoint callback + structured blocked reason) ----
export { goalPromptBody, COMPLETION_MARKERS } from "./goal.js";
export type { GoalRunOptionsEx, GoalCheckpointInfo } from "./goal.js";

// ---- Worktree isolation for sub-agents (claude-code 2026-05 style) ----
export {
  createWorktree,
  removeWorktree,
  resolveRepoRoot,
  worktreeDiffStat,
  isGitAvailable,
} from "./worktree.js";
export type {
  WorktreeHandle,
  WorktreeCreateOptions,
  WorktreeCreateResult,
  WorktreeRemoveResult,
} from "./worktree.js";

// ---- Subagent isolation modes (re-exported from the task tool) ----
export { ISOLATION_MODES } from "./tools/task.js";
export type { Isolation } from "./tools/task.js";
export { parseCsv } from "./tools/task.js";

// ---- Runtime management & introspection (/mcp /hooks /agents /skills /context) ----
export {
  describeMcp,
  formatMcp,
  describeHooks,
  formatHooks,
  describeAgents,
  formatAgents,
  describeSkills,
  formatSkills,
  formatContext,
} from "./management.js";
export type {
  McpSummary,
  HooksSummary,
  AgentsSummary,
  SkillsSummary,
  ContextSummary,
} from "./management.js";

// ---- MCP tool-name normalization (64-char limit + hash collision prevention) ----
export { normalizeMcpToolName, buildMcpToolNameMap, MCP_TOOL_NAME_MAX_LENGTH } from "./mcp.js";

// ---- Consistency assertion (model-visible equals logged, debug/test only) ----
export { consistencyAssertEnabled, assertConsistency, ConsistencyError } from "./consistency.js";

// ---- Keyless transcript replay (test mode, no API key needed) ----
export { ReplayProvider, extractReplayTurns } from "./replayProvider.js";

// ---- Custom status-line script (claude-code-style) ----
export { runStatusLine, buildPayload } from "./statusLine.js";
export type { StatusLinePayload, StatusLineConfig, StatusLineResult } from "./statusLine.js";

// ---- OpenTelemetry-compatible telemetry (OTLP/HTTP-JSON export) ----
export { Tracer, loadTelemetryConfig, getTracer, setTracer } from "./telemetry.js";
export type { Span, TelemetryConfig as OtelTelemetryConfig } from "./telemetry.js";

// ---- Plugins (bundled, distributable extensions + marketplace) ----
export {
  discoverPlugins,
  pluginResourcePaths,
  mergePluginConfig,
  installPlugin,
  uninstallPlugin,
  fetchMarketplaceIndex,
  searchMarketplace,
} from "./plugins.js";
export type {
  PluginManifest,
  Plugin,
  MarketplaceEntry,
  DiscoverPluginsOptions,
  InstallOptions,
} from "./plugins.js";

