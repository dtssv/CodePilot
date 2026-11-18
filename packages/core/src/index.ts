// @codepilot/core public API. Public API surface for @codepilot/core.

// ---- Types ----
export type {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ReasoningBlock,
  ContentBlock,
  EventMeta,
  PlanStep,
  UsageInfo,
  Event,
  InterruptedRunInfo,
  TeamMessageEvent,
  MessageDelta,
  TextDelta,
  ToolInputJsonDelta,
  AgentMode,
  PermissionMode,
  PermissionPresetName,
  PermissionRules,
  SandboxConfig,
  HooksConfig,
  HookEntryConfig,
  ProviderFallbackConfig,
  WebFetchConfig,
  WebSearchConfig,
  WebSearchProvider,
  CustomSearchTemplate,
  ImageGenConfig,
  QuestionSpec,
  QuestionRequest,
  QuestionAnswers,
  PermissionRequest,
  PermissionDecision,
  PermissionResolution,
  CodepilotConfig,
  ConvergenceConfig,
  DoomLoopConfig,
  McpServerConfig,
  SessionOptions,
  SessionLockOwnerInfo,
  SessionSummary,
  ImageAttachment,
  PromptFile,
  SavedUpload,
  FollowUpItem,
  GoalRunOptions,
  GoalRunResult,
  ProviderName,
} from "./types.js";
// Runtime value: the single source of truth for supported provider names.
export { PROVIDER_NAMES } from "./types.js";
export { PERMISSION_PRESETS } from "./types.js";

// ---- Config ----
export { loadConfig, mergeConfig } from "./config/config.js";

// ---- Providers ----
export {
  AnthropicProvider,
  OpenAIProvider,
  CopilotProvider,
  GeminiProvider,
  parseSse,
  renderContent,
  userMessage,
} from "./providers/index.js";
export type {
  AnthropicProviderOptions,
  OpenAIProviderOptions,
  CopilotProviderOptions,
  GeminiProviderOptions,
  ChatProvider,
  CountTokensOptions,
  CountTokensResult,
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
  killAllJobs,
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
  filterToolsByModel,
  chainDiagnostics,
} from "./tools/index.js";
export type {
  ToolDef,
  ToolContext,
  ToolResult,
  PermissionLevel,
  EditOutcome,
  MemorySink,
  SubagentRunner,
  Diagnostic,
  DiagnosticsProvider,
} from "./tools/index.js";

// ---- Permissions ----
export { PermissionEngine, matchRule, persistRule } from "./permissions/permissions.js";
export type { PermissionCheckResult } from "./permissions/permissions.js";

// ---- Sandbox ----
export {
  resolveSandbox,
  wrapCommand,
  buildSeatbeltProfile,
  detectSandboxBackend,
  landlockLauncherPath,
  slirp4netnsPath,
  sandboxUnavailableHint,
  buildSandboxUnavailable,
  formatSandboxPromptNote,
  SANDBOX_PROMPT_EXTRA_ROOTS_CAP,
  assertPathAllowed,
  assertPathAllowedAsync,
  addWritableRoot,
  isWriteOutsideSandbox,
  isInsideWorkingSet,
  writableRootForTarget,
  checkDangerousCommand,
  winPathToWsl,
  SENSITIVE_READ_PATHS,
} from "./sandbox/sandbox.js";
export type {
  ResolvedSandbox,
  WrappedCommand,
  SandboxBackend,
  SandboxUnavailable,
  PathCheckResult,
} from "./sandbox/sandbox.js";
export { startNetProxy, parseAuthority } from "./workspace/netProxy.js";
export type { NetProxyPolicy, RunningNetProxy } from "./workspace/netProxy.js";

// ---- Hooks ----
export { HookEngine, hashCommand } from "./hooks/hooks.js";
export type { HookEvent, HookEntry, PreHookResult, PostHookResult } from "./hooks/hooks.js";

// ---- Redaction ----
export { redactSecrets, containsSecretShape } from "./permissions/redact.js";

// ---- Provider fallback ----
export { FallbackProvider, isFailoverError } from "./providers/fallback.js";

// ---- Memory ----
export {
  readMemory,
  readLayeredProjectMemory,
  readProjectInstructions,
  PROJECT_INSTRUCTIONS_MAX_BYTES,
  FileMemorySink,
  summariseMemory,
  memoryFileExists,
  projectMemoryPath,
  PROJECT_MEMORY_NAME,
  PROJECT_STATE_MEMORY_NAME,
  AGENTS_MEMORY_NAME,
  MEMORY_CANDIDATE_NAMES,
  USER_MEMORY_PATH,
} from "./memory/memory.js";
export type { MemoryContents } from "./memory/memory.js";
export {
  MEMORY_TOPICS,
  autoMemoryDir,
  autoMemoryExists,
  classifyNote,
  clearAutoMemory,
  loadAutoMemoryIndex,
  loadAutoMemoryPromptStub,
  truncateIndexBullet,
  INDEX_BULLET_MAX_CHARS,
  resolveMemoryTopic,
  sanitizeTopic,
  clampToCanonicalTopic,
  writeAutoMemoryNote,
  writeAdHocMemoryNote,
  MEMORY_SUMMARY_NAME,
  NOTES_DIRNAME,
  MAX_AD_HOC_NOTES,
} from "./memory/autoMemory.js";
// projectHash is exported from projectState.js (same implementation).
export type {
  AutoMemoryCategory,
  AutoMemoryConfig,
  AutoMemoryNote,
  MemoryTopic,
} from "./memory/autoMemory.js";
export {
  extractSessionMemory,
  maybeConsolidateMemory,
} from "./memory/memoryConsolidation.js";
export {
  recallRelevantMemories,
  recallRelevantMemoriesDetailed,
  DEFAULT_RECALL_MAX,
  RECALL_SESSION_MAX_CHARS,
} from "./memory/memoryRecall.js";
export type { RecallOptions, RecallResult } from "./memory/memoryRecall.js";
export type {
  MemoryConsolidationConfig,
  MemoryPipelineDeps,
} from "./memory/memoryConsolidation.js";

// ---- System prompt ----
export { buildSystemPrompt } from "./systemPrompt/index.js";
export type { SystemPromptContext, SystemPromptResult } from "./systemPrompt/index.js";

// ---- Delivery roots (task deliverable targets; ≠ sandbox writable) ----
export {
  extractDeliveryRootsFromText,
  formatDeliveryRoots,
  isUnderDeliveryRoots,
  mergeDeliveryRoots,
  normalizeRoot,
  rootFromPathToken,
} from "./workspace/deliveryRoots.js";

// ---- Compaction ----
export {
  compact,
  shouldCompact,
  foldToolResults,
  trimEventsToBudget,
  buildLocalHandoffSummary,
  estimateEventTokens,
  extractPlan,
} from "./compaction/compaction.js";
export type {
  CompactionOptions,
  CompactionResult,
  CompactionDecision,
} from "./compaction/compaction.js";

// ---- MCP ----
export { McpStdioClient, McpManager, mcpToolName, parseMcpToolName } from "./mcp/mcp.js";
export type { McpToolDescriptor, McpInvokeRequest, McpInvokeResult } from "./mcp/mcp.js";

// ---- Agent ----
export { runAgent } from "./agent/agent.js";
export type { AgentDeps, AgentRunInput, AgentRunResult } from "./agent/agent.js";
export { stripThinking, splitThinking, hasVisibleAssistantContent, stripGoalStatus } from "./compaction/stripThinking.js";
export type { ThinkingSegment } from "./compaction/stripThinking.js";
export {
  reasoningEffortChoicesForModel,
  supportsReasoningEffort,
  reasoningEffortFromChoice,
  reasoningEffortToChoice,
} from "./config/reasoningEffort.js";
export type { ReasoningEffort, ReasoningEffortChoice } from "./config/reasoningEffort.js";
export {
  MODEL_CATALOG,
  lookupModelCatalog,
  catalogEffortChoices,
  catalogModalities,
  catalogSuggestedSmall,
} from "./config/modelCatalog.js";
export type { ModelCatalogEntry } from "./config/modelCatalog.js";
export { formatUploadNote, materializeUploads } from "./workspace/promptFiles.js";

// ---- Agent runtime (pluggable loop) ----
export {
  runtimeRegistry,
  RuntimeRegistry,
  DefaultRuntime,
  createRuntimeToolkit,
  DEFAULT_RUNTIME_NAME,
} from "./agent/runtime.js";
export type {
  AgentRuntime,
  AgentRuntimeState,
  RuntimeFactory,
  RuntimeFactoryDeps,
  RuntimeResolveOptions,
  RuntimeToolkit,
  RuntimeToolkitOptions,
  PluginToolDef,
  PluginContextMessage,
  PluginContextTransform,
  PluginEventSink,
} from "./agent/runtime.js";
// Example runtimes; importing registers "audit" + "mcts" (inert until used).
export {
  registerBuiltinRuntimes,
  AuditRuntime,
  auditRuntimeFactory,
  missingAuditSections,
  AUDIT_RUNTIME_NAME,
  MctsRuntime,
  mctsRuntimeFactory,
  parseScores,
  selectCandidate,
  MCTS_RUNTIME_NAME,
} from "./runtimes/index.js";
export type {
  AuditRuntimeOptions,
  MctsCandidate,
  MctsRuntimeOptions,
} from "./runtimes/index.js";

// ---- Agent teams (multi-agent collaboration) ----
export {
  runTeam,
  validateTeam,
  nameMembers,
  detectConflicts,
  writtenPath,
  concatSummary,
  parseAssignments,
  parseVote,
  renderTeamResult,
  TEAM_ROLES,
  MERGE_STRATEGIES,
} from "./subagent/teams.js";
export type {
  TeamRole,
  MergeStrategy,
  TeamSpec,
  TeamMemberSpec,
  TeamMemberResult,
  TeamConflict,
  TeamRunResult,
  TeamRunDeps,
  TeamVote,
} from "./subagent/teams.js";

// ---- Session ----
// The session module was split into session.ts (the Session class) +
// session-utils.ts (standalone helpers). Both are re-exported here so the
// public API is unchanged.
export { Session } from "./session/session.js";
export type { SandboxStatus } from "./session/session.js";
export {
  acquireSessionLock,
  readSessionLock,
  liveSessionLockOwner,
  sessionLockPath,
  SessionLockedError,
} from "./session/sessionLock.js";
export type { SessionLockOwner, SessionLease } from "./session/sessionLock.js";
export {
  gcProjectArtifacts,
  collectSessionArtifactRefs,
  sessionIdsInProject,
} from "./workspace/artifactGc.js";
export type { ArtifactGcResult } from "./workspace/artifactGc.js";
export { openSessionIndex } from "./session/sessionIndex.js";
export type { SessionIndex, SuspendedSession } from "./session/sessionIndex.js";
export {
  createSession,
  listSessions,
  recoverSuspendedSessions,
  resetSessionIndex,
  setSessionPinned,
  setSessionArchived,
  loadSessionState,
  SESSIONS_DIR,
  normalizeCwd,
  sameCwd,
  loadCwdFromDisk,
  persistSessionCwd,
  buildSingleProvider,
} from "./session/session-utils.js";
export type { RecoveredSession, ReconcileSummary } from "./session/session-utils.js";
export {
  sweepSessionRetention,
  compressColdSessions,
  freezeSession,
  thawSession,
  isSessionCold,
} from "./session/sessionCompression.js";
export type {
  RetentionSweepResult,
  ColdCompressResult,
} from "./session/sessionCompression.js";

// ---- Goal ----
export { runGoal, driveGoalRounds } from "./subagent/goal.js";

// ---- Inline (Tab) code completion ----
export {
  decideCompletionModel,
  buildCompletionPrompt,
  cleanCompletion,
  COMPLETION_SYSTEM_PROMPT,
  COMPLETION_MAX_TOKENS,
  COMPLETION_MAX_LINES,
} from "./agent/completion.js";
export type {
  InlineCompletionInput,
  CompletionModelDecision,
} from "./agent/completion.js";

// ---- Config (v2 layered loader) ----
// NOTE: `loadConfig` and `mergeConfig` are already exported above in the
// legacy "Config" block; re-exporting them here would be a duplicate.
export {
  loadConfigWithSources,
  validateConfig,
  interpolateEnv,
  useProvider,
  resolveModelAlias,
  resolveProfile,
  applyConfigPatch,
  getUserConfigPath,
  getManagedConfigPath,
  getRepoConfigPath,
  REPO_CONFIG_PATH,
  DEFAULT_CONFIG,
  CodepilotConfigSchema,
  ModelsConfigSchema,
  ProvidersConfigSchema,
  SkillsConfigSchema,
  DoomLoopConfigSchema,
  LoggingConfigSchema,
  TelemetryConfigSchema,
  UsageConfigSchema,
  McpServerConfigSchema,
} from "./config/config.js";
export type {
  ModelsConfig,
  ModelModality,
  ModelCapabilities,
  ProvidersConfig,
  ProviderPreset,
  SkillsConfig,
  LoggingConfig,
  TelemetryConfig,
  UsageConfig,
  ResolvedCodepilotConfig,
  ConfigLayer,
  LoadConfigResult,
} from "./config/config.js";
export {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  ModelModalitySchema,
  ModelCapabilitiesSchema,
} from "./config/config.js";
export {
  PROVIDER_TEMPLATES,
  listProviderTemplates,
  listSelectableModels,
  resolveDefaultModel,
  findProviderIdForFlat,
  redactApiKey,
  redactProviderPreset,
  applyProviderAndModel,
  readUserConfigFile,
  writeUserConfigFile,
  upsertUserProvider,
  deleteUserProvider,
  setUserActiveEndpoint,
  templateToPreset,
  resolveModelTarget,
  listRemoteModels,
  nextProviderId,
  clampContextWindow,
  normalizeProviderPreset,
  parseModalities,
  parseRemoteModelEntry,
  resolveModelCapabilities,
} from "./config/providerCatalog.js";
export {
  SECRET_PREFIX,
  isEncryptedSecret,
  encryptSecret,
  decryptSecret,
  encryptSecretFields,
  decryptSecretFields,
} from "./config/secretCrypto.js";
export type {
  SelectableModel,
  ProviderTemplate,
  RedactedProviderPreset,
  RemoteModelInfo,
} from "./config/providerCatalog.js";

// ---- Bundles (config + resources export/import) ----
export {
  BUNDLE_VERSION,
  exportBundle,
  exportBundleToFile,
  serializeBundle,
  parseBundle,
  validateBundle,
  importBundle,
  importBundleFromFile,
} from "./config/bundle.js";
export type {
  CodepilotBundle,
  ExportBundleOptions,
  ImportBundleOptions,
  ImportBundleResult,
} from "./config/bundle.js";

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
} from "./telemetry/logger.js";
export type {
  Logger,
  LoggerConfig,
  LoggerState,
  LogLevel,
  LogRecord,
  LogSink,
} from "./telemetry/logger.js";

// ---- Skills ----
export {
  parseSkillMd,
  discoverSkills,
  matchSkill,
  findSkill,
  skillsPromptSection,
  defaultBuiltinSkillsDir,
  BUILTIN_SKILLS,
} from "./skills/skills.js";
export type { Skill, SkillSource, DiscoverOptions } from "./skills/skills.js";

export {
  specsDir,
  listSpecFeatures,
  readSpecFeature,
  parseAcceptanceCriteria,
  parseTasks,
  specCoverage,
} from "./workspace/specs.js";
export type {
  SpecFeature,
  SpecTask,
  SpecAcceptanceCriterion,
} from "./workspace/specs.js";

export { skillTool, createSkillTool, StaticSkillStore, setDefaultSkillStore } from "./tools/skill.js";
export type { SkillStore, SkillToolHandle } from "./tools/skill.js";
export { LspManager, languageIdForPath, parseLocations, DEFAULT_LSP_SERVERS } from "./workspace/lsp.js";
export type { LspServerConfig, LspLocation, LspPosition } from "./workspace/lsp.js";
export { makeLspNavigateTool } from "./tools/lsp_navigate.js";

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
} from "./skills/slashCommands.js";
export type {
  SlashCommand,
  SlashCommandSource,
  SlashCommandFrontmatter,
  DiscoverSlashCommandsOptions,
  DiscoverSlashCommandsResult,
  ResolveResult,
} from "./skills/slashCommands.js";

// ---- MCP (extended — adds SSE, resources, prompts, fail-soft) ----
// Note: McpStdioClient, McpManager, mcpToolName, parseMcpToolName,
// McpToolDescriptor, McpInvokeRequest, McpInvokeResult are already
// exported above in the legacy "MCP" block.
export { McpSseClient, isMcpSseConfig, mcpResourceToolName, MCP_REF_REGEX, parseMcpReference, resolveMcpReferences } from "./mcp/mcp.js";
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
} from "./mcp/mcp.js";

// ---- Tokens (estimator + per-model context windows) ----
export {
  estimateTokens,
  heuristicTokens,
  setTokenizer,
  resetTokenizer,
  getActiveTokenizer,
  hasRealTokenizer,
  tryLoadRealTokenizer,
  estimateMessagesTokens,
  estimateObjectTokens,
  estimateEventsTokens,
  IMAGE_TOKEN_ESTIMATE,
  lookupContextWindow,
  resolveCompactionThreshold,
  estimateCostUSD,
} from "./compaction/tokens.js";
export type { TokenEstimator, ModelContextWindow, ModelCost } from "./compaction/tokens.js";

// ---- Prompt-cache analysis ----
export {
  analyzeCacheWaste,
  DEFAULT_CACHE_TTL_MS,
  CACHE_MISS_NOISE_FLOOR,
} from "./compaction/cacheStats.js";
export type {
  CacheTurn,
  CacheMiss,
  CacheMissCause,
  CacheWasteReport,
} from "./compaction/cacheStats.js";
export {
  decideCacheWarm,
  cacheTtlMs,
  CACHE_WARM_TTL_FRACTION,
  CACHE_WARM_MIN_SAVINGS_USD,
} from "./compaction/cacheWarmer.js";
export type { CacheWarmDecision, CacheWarmInput } from "./compaction/cacheWarmer.js";

// ---- Audit log (structured tool-call record) ----
export { AuditLogger, readAuditLog, auditDir } from "./telemetry/audit.js";
export type { AuditRecord } from "./telemetry/audit.js";

// ---- Per-project runtime state (~/.codepilot/projects/<hash>/) ----
export {
  projectHash,
  projectStateRoot,
  projectStatePath,
  scratchDir,
  ensureProjectState,
} from "./workspace/projectState.js";

// ---- Checkpoints (cross-session memory files) ----
export {
  CHECKPOINT_SECTIONS,
  shouldCheckpoint as shouldCheckpointNow,
  buildCheckpointSnapshot,
  renderCheckpointMarkdown,
  parseCheckpointMarkdown,
  writeCheckpoint,
  writeCheckpointFromSnapshot,
  appendCheckpointRound,
  readCheckpoint,
  checkpointExists,
  checkpointPath,
  legacyCheckpointPath,
  summariseCheckpointForPrompt,
  makeCheckpointHook,
} from "./session/checkpoints.js";
export type {
  CheckpointSection,
  CheckpointOptions,
  CheckpointTrigger,
  CheckpointSnapshot,
  CheckpointHook,
  WriteCheckpointResult,
} from "./session/checkpoints.js";

// ---- Snapshots (checkpoint rewind) ----
export {
  createSnapshot,
  rewindToSnapshot,
  listSnapshots,
  deleteSnapshot,
} from "./session/snapshots.js";

// ---- /init project guidance ----
export { initProjectGuidance } from "./config/projectInit.js";
export type { InitProjectOptions, InitProjectResult } from "./config/projectInit.js";

// ---- One-time QR remote control ----
export {
  mintRemotePairing,
  redeemRemotePairing,
  resolveRemoteGrant,
  remoteGrantAllows,
  revokeAllRemoteControl,
  cancelUnusedPairings,
} from "./workspace/remoteControl.js";
export type {
  MintRemotePairingOpts,
  MintRemotePairingResult,
  RedeemRemotePairingResult,
  RemoteGrant,
  RemotePairing,
} from "./workspace/remoteControl.js";

// ---- Scheduled / idle tasks ----
export {
  listScheduledTasks,
  hasPendingScheduledTasks,
  addScheduledTask,
  updateScheduledTask,
  removeScheduledTask,
  schedulerTick,
  startSchedulerWatcher,
} from "./agent/scheduler.js";
export type {
  ScheduledTask,
  ScheduledTaskKind,
  ScheduledDelivery,
  SchedulerTickContext,
  SchedulerWatcherHandle,
} from "./agent/scheduler.js";

// ---- LAN advertise (phone QR) ----
export { listLanIPv4, advertiseUrl, isLoopbackHost } from "./workspace/netAdvertise.js";

// ---- MCP marketplace links + paste JSON ----
export {
  listMcpMarkets,
  installMcpJson,
  listInstalledMcpServers,
  setMcpServerEnabled,
  inspectMcpServer,
  authorizeMcpServer,
} from "./mcp/mcpRegistry.js";
export type {
  McpMarketLink,
  InstallMcpJsonResult,
  InstalledMcpServer,
  InspectMcpServerResult,
  AuthorizeMcpServerResult,
  McpCapabilityTool,
  McpCapabilityResource,
  McpCapabilityPrompt,
} from "./mcp/mcpRegistry.js";
export {
  acquireSharedMcp,
  releaseSharedMcp,
  mcpServersKey,
  resetMcpPoolForTests,
} from "./mcp/mcp-pool.js";

// ---- Office connectors (Feishu / DingTalk / …) ----
export {
  CONNECTOR_CATALOG,
  listConnectors,
  listConnectorsWithStatus,
  queryConnectorsWithStatus,
  getConnector,
  getConnectorStatus,
  installConnector,
  updateConnector,
  setConnectorEnabled,
  connectorInstalled,
} from "./config/connectors.js";

// ---- Skills install / enable / disable ----
export {
  listManagedSkills,
  queryManagedSkills,
  installSkillFromConnector,
  installSkillFromArchive,
  installSkillFromSource,
  supportedSkillArchiveExts,
  setSkillEnabled,
  userSkillInstalled,
  getSkillContent,
  getSkillFile,
  saveSkillContent,
  saveSkillFile,
  SKILL_CREATOR_STARTER_PROMPT,
} from "./skills/skillManage.js";
export type {
  ManagedSkill,
  ManagedSkillState,
  InstallSkillResult,
  InstallSkillArchiveResult,
  SkillContent,
  SkillFileContent,
  SaveSkillResult,
  SkillListQuery,
  SkillListPage,
  SkillListTab,
} from "./skills/skillManage.js";
export { readDisabledSkillNames } from "./skills/skills.js";

// ---- Remote catalogs (GitHub JSON, once-per-day update) ----
export {
  loadCatalogDocument,
  refreshAllCatalogs,
  shouldAttemptDailyUpdate,
  resetCatalogMemoryForTests,
} from "./config/remoteCatalog.js";
export type { CatalogName, CacheFile as CatalogCacheFile } from "./config/remoteCatalog.js";
export { listSearchEngines, SEARCH_ENGINES } from "./config/searchEngines.js";
export type { SearchEngineTemplate } from "./config/searchEngines.js";
export type {
  ConnectorRecipe,
  ConnectorKind,
  ConnectorCredentialField,
  ConnectorStatus,
  ConnectorWithStatus,
  ConnectorInstallState,
  InstallConnectorInput,
  InstallConnectorResult,
  CatalogListTab,
  ConnectorListQuery,
  ConnectorListPage,
} from "./config/connectors.js";

// ---- Memory (structured sections) ----
export {
  MEMORY_SECTIONS,
  parseMemory,
  renderMemory,
  classifySection,
  summariseMemoryText,
} from "./memory/memory.js";
export type { MemorySection as MemorySectionName, ParsedMemory } from "./memory/memory.js";

// ---- Session (auto-title, search, export, rich summary) ----
export {
  getSessionsDir,
  searchSessions,
  exportSession,
  deleteSession,
} from "./session/session-utils.js";
export type {
  RichSessionSummary,
  SessionExportFormat,
  SessionState,
} from "./session/session-utils.js";
export { CORE_VERSION, linkIdForEvent, readGitBranch, stampEventMeta } from "./telemetry/eventMeta.js";
export {
  DAY_MS,
  applyUpdate,
  checkEngineUpdate,
  checkForUpdate,
  compareVersions,
  currentInstalledVersion,
  detectInstallRoot,
  normalizeVersion,
  resetSelfUpdateWatcherForTests,
  runUpdateCheck,
  startSelfUpdateWatcher,
} from "./config/selfUpdate.js";
export type {
  EngineUpdateInfo,
  SelfUpdateOptions,
  SelfUpdateWatcherHandle,
  UpdateCheckResult,
} from "./config/selfUpdate.js";

// ---- Session internals (split modules — MCP wiring + prompt telemetry) ----
export {
  startMcp,
  resolveSessionMcpReferences,
  jsonSchemaToZod,
  compileJsonSchema,
} from "./mcp/sessionBind.js";
export type { SessionMcpHost } from "./mcp/sessionBind.js";
export { startPromptSpan, endPromptSpan } from "./session/session-telemetry.js";
export type { PromptSpan } from "./session/session-telemetry.js";

// ---- Goal (checkpoint callback + structured blocked reason) ----
export { goalPromptBody, COMPLETION_MARKERS } from "./subagent/goal.js";
export type { GoalRunOptionsEx, GoalCheckpointInfo } from "./subagent/goal.js";

// ---- Worktree isolation for sub-agents ----
export {
  createWorktree,
  removeWorktree,
  resolveRepoRoot,
  worktreeDiffStat,
  isGitAvailable,
} from "./workspace/worktree.js";
export type {
  WorktreeHandle,
  WorktreeCreateOptions,
  WorktreeCreateResult,
  WorktreeRemoveResult,
} from "./workspace/worktree.js";

// ---- Subagent isolation modes (re-exported from the task tool) ----
export { ISOLATION_MODES } from "./tools/task.js";
export type { Isolation } from "./tools/task.js";
export { AGENT_TYPES } from "./tools/task.js";
export type { AgentType } from "./tools/task.js";
export { parseCsv } from "./tools/task.js";
export { buildSubagentToolRegistry } from "./tools/subagentTools.js";
export { taskBoardTool } from "./tools/task_board.js";
export { TaskBoard, foldTasks } from "./subagent/taskBoard.js";
export type { TaskBoardEntry, TaskSnapshot, TaskStatus, TaskBoardResult } from "./subagent/taskBoard.js";

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
} from "./agent/management.js";
export type {
  McpSummary,
  HooksSummary,
  AgentsSummary,
  SkillsSummary,
  ContextSummary,
} from "./agent/management.js";

// ---- MCP tool-name normalization (64-char limit + hash collision prevention) ----
export { normalizeMcpToolName, buildMcpToolNameMap, MCP_TOOL_NAME_MAX_LENGTH } from "./mcp/mcp.js";

// ---- Consistency assertion (model-visible equals logged, debug/test only) ----
export { consistencyAssertEnabled, assertConsistency, ConsistencyError } from "./agent/consistency.js";
export { applyContextTransform, validateTransformedView } from "./compaction/contextTransform.js";
export type { ContextTransformCheck } from "./compaction/contextTransform.js";
export { BoundedSinkQueue } from "./session/sessionSink.js";
export type { SessionEventSink, BoundedSinkQueueOptions } from "./session/sessionSink.js";
export { BUILTIN_COMMANDS, sharedBuiltinCommands } from "./skills/builtinCommands.js";
export type { BuiltinCommand, BuiltinCommandScope, CommandKind } from "./skills/builtinCommands.js";
export { FileObservationStore, hashFileContent } from "./workspace/fsObservation.js";
export type { FileObservation, FreshnessResult, CheckFreshOptions } from "./workspace/fsObservation.js";

// ---- Keyless transcript replay (test mode, no API key needed) ----
export { ReplayProvider, extractReplayTurns } from "./agent/replayProvider.js";

// ---- Headless (non-interactive / print-mode) output contract ----
export {
  runHeadless,
  parseOutputFormat,
  extractFinalAssistantText,
  countAssistantTurns,
} from "./agent/headless.js";
export type { OutputFormat, HeadlessResult, HeadlessOptions, HeadlessSession } from "./agent/headless.js";

// ---- Status line (declarative preset or custom script) ----
export {
  runStatusLine,
  buildPayload,
  renderPresetStatusLine,
  resolvePresetItems,
  STATUS_LINE_PRESETS,
} from "./config/statusLine.js";
export type {
  StatusLinePayload,
  StatusLineConfig,
  StatusLinePresetConfig,
  StatusLineCommandConfig,
  StatusLineResult,
  StatusLineItem,
  StatusLinePresetName,
  RateLimitSnapshot,
} from "./config/statusLine.js";

// ---- OpenTelemetry-compatible telemetry (OTLP/HTTP-JSON export) ----
export { Tracer, loadTelemetryConfig, getTracer, setTracer } from "./telemetry/telemetry.js";
export type { Span, TelemetryConfig as OtelTelemetryConfig } from "./telemetry/telemetry.js";

// ---- Plugins (bundled, distributable extensions + marketplace) ----
export {
  discoverPlugins,
  pluginResourcePaths,
  collectPluginProviderTemplates,
  mergePluginConfig,
  installPlugin,
  inspectPluginSource,
  uninstallPlugin,
  fetchMarketplaceIndex,
  searchMarketplace,
  listPluginMarket,
  describeMarketplaceEntry,
  describePluginCapabilities,
  derivePluginName,
  loadPluginRuntimes,
  pluginSensitiveTrusted,
  trustPlugin,
  initPluginRuntimes,
  pluginDefaultRuntime,
  pluginPermissionReport,
  PLUGIN_PERMISSIONS,
} from "./plugins/plugins.js";
export {
  PluginTrustStore,
  pluginContentHash,
  defaultPluginTrustPath,
} from "./plugins/plugins-trust.js";
export {
  McpTrustStore,
  mcpServerConfigHash,
  defaultMcpTrustPath,
  listProjectMcpServers,
  approveProjectMcpServer,
} from "./mcp/mcpTrust.js";
export type { ProjectMcpServer } from "./mcp/mcpTrust.js";
export {
  defaultFolderTrustPath,
  findTrustedFolder,
  isFolderTrusted,
  isBroadFolder,
  trustFolder,
} from "./permissions/folderTrust.js";
export type { TrustedFolder, FolderTrustOptions } from "./permissions/folderTrust.js";
export {
  projectSourcedMcpServerNames,
  mcpTrustFileForCwd,
  listProjectMcpServersForCwd,
  approveProjectMcpServerForCwd,
} from "./mcp/sessionBind.js";
export type {
  PluginManifest,
  PluginProviderTemplate,
  Plugin,
  PluginPermission,
  PluginPermissionReport,
  PluginCapabilityReport,
  MarketplaceEntry,
  DiscoverPluginsOptions,
  InstallOptions,
  PluginRuntimeLoadResult,
  PluginRuntimeInit,
  InitPluginRuntimesOptions,
} from "./plugins/plugins.js";

