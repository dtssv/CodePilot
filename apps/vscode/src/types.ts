// Headless protocol types — kept in sync with docs/PROTOCOL.md and
// packages/core/src/types.ts. We redeclare the subset we touch here so the
// VSCode extension has zero runtime dependency on @codepilot/core (it only
// needs to speak NDJSON JSON-RPC).

export type PermissionMode = "ask" | "auto-edit" | "yolo";
export type PermissionDecision = "allow" | "deny" | "always";

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

export type MessageDelta =
  | { type: "text"; text: string }
  | { type: "tool_input_json"; toolCallId: string; partialJson: string };

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
  | { type: "tool_call"; id: string; name: string; input: unknown }
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
  | { type: "status"; status: "idle" | "running" | "waiting_permission" | "compacting" }
  | { type: "error"; message: string; recoverable: boolean };

/** Server -> client `event` notification payload. */
export interface ServerEvent {
  sessionId: string;
  event: Event;
}

/** Server -> client `permission/request` request payload. */
export interface PermissionRequestParams {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string;
}

/** Server -> client `session/usage` notification payload. */
export interface SessionUsageNotification {
  sessionId: string;
  usage: UsageInfo;
}

/** Capabilities returned by `initialize`. */
export interface ServerCapabilities {
  tools: string[];
  providers: string[];
}

export interface InitializeResult {
  protocolVersion: number;
  capabilities: ServerCapabilities;
}

/* ---------- JSON-RPC envelopes ---------- */

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

/* ---------- Client params (subset we actually use) ---------- */

export interface InitializeParams {
  protocolVersion: number;
  cwd: string;
  permissionMode: PermissionMode;
  clientInfo: { name: string; version: string };
}

export interface SessionNewParams {
  cwd?: string;
  model?: string;
  systemPromptExtra?: string;
}

export interface PromptSendParams {
  sessionId: string;
  text: string;
  images?: Array<{ mediaType: string; base64: string }>;
}

export interface PromptCancelParams {
  sessionId: string;
}

export interface PermissionRespondParams {
  requestId: string;
  decision: PermissionDecision;
}

export interface SessionResumeParams {
  sessionId: string;
}