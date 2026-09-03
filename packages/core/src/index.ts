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
