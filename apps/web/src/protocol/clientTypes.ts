import type { Event, PermissionMode, QuestionSpec } from "@codepilot/core";
import type {
  DiagnosticsRequestParams,
  DiagnosticsRequestResult,
  InitializeResult,
} from "@codepilot/protocol";
import type { RpcTransport } from "@codepilot/protocol/rpc";

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  reason: string;
 /** Out-of-sandbox write: allow adds this folder (always also persists). */
  sandboxExpand?: { path: string };
  sandboxEscalation?: true;
  /** Live-disk before/after preview for write/edit/apply_patch. */
  preview?: string;
}

/** Context-window usage report (mirrors core Session.contextReport). */
export interface ContextReport {
  /** Event-log-only token total (back-compat). */
  totalTokens: number;
  /** Full per-turn send estimate: event log + system prompt + skills + tool/MCP
   * schemas. The schemas + system prompt ride every request but live outside
   * the event log, so this exceeds `totalTokens` and drives the gauge. */
  sentTokens?: number;
  /** Provider-reported prompt size from the last request (0 until the first
   * response). Most accurate numerator when > 0. */
  providerInputTokens?: number;
  window: number;
  triggerThreshold: number;
  triggerFraction: number;
  usagePercent: number;
  autoCompactEnabled: boolean;
  byEventType: { type: string; tokens: number; count: number }[];
  byCategory?: { category: string; tokens: number; isDeferred?: boolean }[];
  topFileReads: { path: string; reads: number; tokens: number }[];
  duplicateReads: { path: string; reads: number }[];
}

export interface PendingQuestion {
  requestId: string;
  sessionId: string;
  questions: QuestionSpec[];
}

export interface ClientCallbacks {
  onEvent(sessionId: string, event: Event): void;
  onPermission(req: PendingPermission): void;
  onQuestion(req: PendingQuestion): void;
 /** Another client following the session answered this request. */
  onPromptResolved?(kind: "permission" | "question", requestId: string): void;
 /** Transport went away — the UI should offer to reconnect. */
  onClose(reason?: string): void;
 /** Automatic reconnect succeeded after a transport drop. */
  onReconnected?(init: InitializeResult): void;
 /** Automatic reconnect is being attempted. */
  onReconnecting?(attempt: number, delayMs: number): void;
  /** A watched workspace directory changed on disk (debounced). */
  onWorkspaceChanged?(params: WorkspaceChangedParams): void;
  /** MCP OAuth: open / show this authorization URL (loopback callback pending). */
  onMcpOauthRequired?(params: { name: string; url: string }): void;
  /** The server's `diagnostics` tool asks the host for LSP diagnostics. A host
   * with a language server returns them inline; a browser with none should
   * return `{ unavailable: true }`. When this callback is absent the client
   * replies `unavailable` so the tool falls back to its "use bash" guidance. */
  onDiagnosticsRequest?(params: DiagnosticsRequestParams): Promise<DiagnosticsRequestResult>;
}

export interface WorkspaceChangedParams {
  path: string;
  kinds: Array<"rename" | "change">;
 /** Set when the server-side watcher failed; fall back to polling. */
  error?: string;
}

export interface ConnectOptions {
 /** `ws://host:port/rpc` — the token is appended from `token`. */
  url: string;
  token?: string;
 /** Optional until the user opens a workspace folder. */
  cwd?: string;
  permissionMode?: PermissionMode;
}

export type ModelModality = "text" | "image" | "audio" | "video";

export interface ModelCapabilities {
 /** Provider-reported ceiling when `/models` returns it; otherwise omitted. */
  contextWindowMax?: number;
  contextWindow: number;
  modalities: ModelModality[];
  maxOutputTokens?: number;
  /** When set, overrides id heuristics for the thinking-effort UI. */
  reasoningEffortChoices?: Array<"off" | "low" | "medium" | "high">;
}

export interface RemoteModelInfo {
  id: string;
  contextWindowMax?: number;
  modalities?: ModelModality[];
  maxOutputTokens?: number;
}

/** Writable provider preset for `config/upsertProvider`. */
export interface ConfigProviderPreset {
  provider: "anthropic" | "openai" | "copilot" | "gemini" | "azure";
  displayName?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  smallModel?: string;
  models?: string[];
  apiStyle?: "chat" | "responses";
  headers?: Record<string, string>;
  modelCapabilities?: Record<string, ModelCapabilities>;
}

/** Redacted preset returned by `config/get` (no full apiKey). */
export interface ConfigProviderRedacted {
  provider: "anthropic" | "openai" | "copilot" | "gemini" | "azure";
  displayName?: string;
  baseURL?: string;
  hasApiKey: boolean;
  apiKeyHint?: string;
  model?: string;
  smallModel?: string;
  models?: string[];
  apiStyle?: "chat" | "responses";
  headers?: Record<string, string>;
  modelCapabilities?: Record<string, ModelCapabilities>;
}

export interface SelectableModelInfo {
  id: string;
  providerId: string;
  providerLabel: string;
  model: string;
  kind: "chat" | "small";
}

export interface ProviderTemplateInfo {
  id: string;
  displayName: string;
  provider: "anthropic" | "openai" | "copilot" | "gemini" | "azure";
  baseURL?: string;
  models?: string[];
  smallModel?: string;
  apiStyle?: "chat" | "responses";
  description?: string;
  requiresBaseURL?: boolean;
}

/** HTTP template for a `custom` web_search backend. */
export interface CustomSearchTemplateInfo {
  method?: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  resultsPath?: string;
  fields?: { title?: string; url?: string; snippet?: string };
}

/** One ready-made search engine from the catalog. */
export interface SearchEngineInfo {
  id: string;
  displayName: string;
  description?: string;
  signupUrl?: string;
  needsKey?: boolean;
  keyEnvVar?: string;
  template: CustomSearchTemplateInfo;
}

export interface ConfigSnapshot {
  active: {
    provider?: string;
    model?: string;
    smallModel?: string;
    baseURL?: string;
    providerId?: string;
    hasApiKey: boolean;
    apiKeyHint?: string;
    onboardedAt?: string;
  };
  providers: Record<string, ConfigProviderRedacted>;
  selectableModels: SelectableModelInfo[];
  templates: ProviderTemplateInfo[];
  imageGen?: { baseURL?: string; model?: string; enabled: boolean; hasApiKey: boolean };
  webSearch?: {
    provider?: string;
    hasApiKey: boolean;
    customUrl?: string;
    engineId?: string;
    custom?: CustomSearchTemplateInfo;
    env?: Record<string, string>;
    engines: SearchEngineInfo[];
  };
  sandbox?: { mode: "off" | "workspace-write" | "read-only" };
}

export interface SessionOptions {
  cwd?: string;
  permissionMode?: PermissionMode;
 /** Reported to the server as `clientInfo.name`. */
  clientName?: string;
}

/** A live transport plus the hooks the client needs to manage it. */
export interface OpenedTransport {
  transport: RpcTransport;
  close(): void;
  onClose(listener: () => void): void;
}

/** Opens a fresh transport; called again for every automatic reconnect. */
export type TransportOpener = () => Promise<OpenedTransport>;

/** Minimal RPC surface used by split `client*.ts` method modules. */
export interface ClientRpcHost {
  call<R>(method: string, params?: unknown): Promise<R>;
}