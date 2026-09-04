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
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "mode"; mode: AgentMode };

/**
 * Cursor-style collaboration mode. Controls which tools the model is allowed
 * to call and how the system prompt is shaped.
 *
 * - `chat`: read-only Q&A. Only safe read tools are exposed. No file edits,
 *   no shell. Model is asked to answer questions / give suggestions without
 *   modifying the codebase.
 * - `plan`: read-only + `plan_update`. The model explores the code and
 *   produces a structured plan but does not execute any mutations.
 * - `agent`: full autonomy — the default. All tools are available.
 */
export type AgentMode = "chat" | "plan" | "agent";

export type PermissionMode = "ask" | "auto-edit" | "yolo";

/**
 * Sandbox policy for shell commands and file tools.
 *
 * - `off`             — no sandboxing (legacy behaviour; not recommended).
 * - `workspace-write` — commands may read the host but may only write inside
 *                       the session cwd, the system temp dir, and
 *                       `~/.codepilot`. File tools enforce the same boundary.
 * - `read-only`       — no writes at all.
 *
 * Enforcement is two-layer:
 *   1. Process layer: bash commands are wrapped in `sandbox-exec` (macOS
 *      Seatbelt) or `bwrap` (Linux) when available.
 *   2. Tool layer: read_file / write_file / edit_file / ls / glob / grep
 *      paths are validated against the policy before any I/O happens.
 *
 * `network: false` blocks outbound network for sandboxed commands where the
 * platform sandbox supports it.
 *
 * `fallback` decides what happens when no OS sandbox binary is available and
 * mode is not "off": "deny" refuses to run bash (fail closed, the default),
 * "allow-unsandboxed" runs the command anyway with a loud warning.
 */
export interface SandboxConfig {
  mode?: "off" | "workspace-write" | "read-only";
  network?: boolean;
  /** Extra absolute paths that are writable in workspace-write mode. */
  writablePaths?: string[];
  fallback?: "deny" | "allow-unsandboxed";
}

/**
 * claude-code style permission rules. Each rule is a string:
 *
 *   "read_file"                 — the whole tool
 *   "mcp__github__*"            — wildcard over tool names
 *   "bash(npm test *)"          — prefix/glob match on the tool's primary
 *                                 argument (bash→command, read_file/write_file/
 *                                 edit_file→path, web_fetch→url)
 *   "bash(/^git (status|diff)/)" — regex match on the primary argument
 *
 * Evaluation order: deny > ask > allow > mode default. `deny` applies in
 * every mode, including yolo — it is the last-line safety net.
 */
export interface PermissionRules {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

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
  /** Tool names or bash command regexes that auto-approve.
   *  @deprecated prefer `permissions.allow` (same rule syntax). */
  autoApprove?: string[];
  /** claude-code style allow/ask/deny rule lists. See {@link PermissionRules}. */
  permissions?: PermissionRules;
  /** OS-level sandbox policy. Default: workspace-write, fail-closed. */
  sandbox?: SandboxConfig;
  /** Maximum assistant turns per prompt (default 50). */
  maxTurns?: number;
  /** Default collaboration mode for new sessions (default: "agent"). */
  agentMode?: AgentMode;
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
  /** Initial collaboration mode (default: "agent"). Override at runtime via Session.setAgentMode. */
  agentMode?: AgentMode;
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
