// Public type surface for @codepilot/core.
// These mirror the API.md contract exactly. Keep changes in sync with docs/API.md.

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError?: boolean;
  artifactRef?: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
}

export interface UsageInfo {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUSD?: number;
}

export type TextDelta = { type: "text"; text: string };
export type ToolInputJsonDelta = { type: "tool_input_json"; toolCallId: string; partialJson: string };
export type MessageDelta = TextDelta | ToolInputJsonDelta;

export type Event =
  | {
      type: "message";
      id: string;
      role: "user" | "assistant";
      content: ContentBlock[];
      model?: string;
    }
  | {
      type: "message_delta";
      messageId: string;
      delta: MessageDelta;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      content: string;
      isError?: boolean;
      artifactRef?: string;
    }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "usage"; usage: UsageInfo }
  | { type: "compaction"; summary: string }
  | {
      type: "status";
      status: "idle" | "running" | "waiting_permission" | "compacting";
    }
  | { type: "error"; message: string; recoverable: boolean };

export type PermissionMode = "ask" | "auto-edit" | "yolo";

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string;
}

export type PermissionDecision = "allow" | "deny" | "always";

export type ProviderName = "anthropic" | "openai" | "copilot";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CodepilotConfig {
  provider?: ProviderName;
  model?: string;
  smallModel?: string;
  /** API key; otherwise read from env: ANTHROPIC_API_KEY / OPENAI_API_KEY / GITHUB_TOKEN. */
  apiKey?: string;
  /** OpenAI-compatible base URL (e.g. DeepSeek / vLLM / Ollama). */
  baseURL?: string;
  permissionMode?: PermissionMode;
  maxTokens?: number;
  /** Token threshold to trigger compaction. */
  contextWindow?: number;
  mcpServers?: Record<string, McpServerConfig>;
  /** Tool names or bash command regexes that auto-approve. */
  autoApprove?: string[];
}

export interface ImageAttachment {
  mediaType: string;
  base64: string;
}

export interface SessionOptions {
  cwd: string;
  config?: CodepilotConfig;
  /** Resume an existing session. */
  sessionId?: string;
  systemPromptExtra?: string;
  model?: string;
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export interface GoalRunOptions extends SessionOptions {
  objective: string;
  maxRounds?: number;
  onRound?: (round: number, status: string) => void;
}

export interface GoalRunResult {
  status: "completed" | "blocked" | "round_limit";
  reason?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  cwd: string;
}
