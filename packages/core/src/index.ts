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
export { PermissionEngine, matchRule } from "./permissions.js";
export type { PermissionCheckResult } from "./permissions.js";

// ---- Memory ----
export {
  readMemory,
  FileMemorySink,
  summariseMemory,
  memoryFileExists,
  PROJECT_MEMORY_NAME,
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

// ---- MCP (extended — adds SSE, resources, prompts, fail-soft) ----
// Note: McpStdioClient, McpManager, mcpToolName, parseMcpToolName,
// McpToolDescriptor, McpInvokeRequest, McpInvokeResult are already
// exported above in the legacy "MCP" block.
export { McpSseClient, isMcpSseConfig, mcpResourceToolName } from "./mcp.js";
export type {
  McpResourceDescriptor,
  McpResourceReadResult,
  McpPromptDescriptor,
  McpStdioServerConfig,
  McpSseServerConfig,
  McpServerConfigEntry,
  McpClient,
  McpStartError,
} from "./mcp.js";

// ---- Tokens (estimator + per-model context windows) ----
export {
  estimateTokens,
  estimateMessagesTokens,
  estimateObjectTokens,
  estimateEventsTokens,
  lookupContextWindow,
  resolveCompactionThreshold,
} from "./tokens.js";
export type { TokenEstimator, ModelContextWindow } from "./tokens.js";

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
