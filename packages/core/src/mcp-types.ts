// Shared types for the MCP (Model Context Protocol) client.
//
// This module defines the public type surface used by every transport
// (stdio / SSE / Streamable HTTP) and by the McpManager. Keeping the types
// in one place lets the transports depend on a single, stable header
// without circular imports — the transport implementations import from
// here, and `mcp.ts` (the entry point) re-exports everything for backward
// compatibility with existing call sites that import from "./mcp.js".

import type { McpServerConfig } from "./types.js";

// Re-export the base config type so transport sub-modules can import all MCP
// config shapes from one place (`./mcp-types.js`).
export type { McpServerConfig };

// ---------------------------------------------------------------------------
// Tool-name normalization (64-char limit + hash collision prevention)
// ---------------------------------------------------------------------------

/**
 * Maximum length for a normalized MCP tool name. Provider APIs (Anthropic,
 * OpenAI) and the model's function-call schema generally enforce a 64-char
 * limit on function names. Names exceeding this must be truncated, and to
 * avoid collisions between two long names that share a prefix, a short hash
 * of the full original name is appended.
 */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A tool advertised by an MCP server. */
export interface McpToolDescriptor {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpInvokeRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpInvokeResult {
  content: string;
  isError?: boolean;
}

/** A resource advertised by an MCP server. Mirrors the JSON shape of the
 *  `resources/list` response. */
export interface McpResourceDescriptor {
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** A prompt advertised by an MCP server. */
export interface McpPromptDescriptor {
  server: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** Result of a `resources/read` call. */
export interface McpResourceReadResult {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string; // base64
  }>;
}

/** Per-server startup failure. Returned by `McpManager.startErrors()`. */
export interface McpStartError {
  server: string;
  message: string;
}

/** A unified client interface — both transports implement it. */
export interface McpClient {
  /** Display name of the server (the key in the config map). */
  readonly serverName: string;
  /** Start the transport and complete the `initialize` handshake. */
  start(): Promise<void>;
  /** Shut the transport down. Safe to call multiple times. */
  stop(): Promise<void>;
  /** Tools advertised by the server (cached after `start`). */
  listTools(): McpToolDescriptor[];
  /** Invoke a tool by name with the given arguments. */
  invokeTool(req: McpInvokeRequest): Promise<McpInvokeResult>;
  /** Resources advertised by the server. May be empty if the server does
   *  not implement the resources capability. */
  listResources(): McpResourceDescriptor[];
  /** Read a resource by URI. Throws if the server returns an error. */
  readResource(uri: string): Promise<McpResourceReadResult>;
  /** Prompts advertised by the server. May be empty. */
  listPrompts(): McpPromptDescriptor[];
  /** Render a prompt by name with the given arguments. */
  getPrompt(name: string, args?: Record<string, string>): Promise<unknown>;
  /** Install a handler for server-initiated requests (elicitation,
   *  sampling). When unset, such requests are rejected. */
  setServerRequestHandler(h: McpServerRequestHandler | null): void;
}

// ---------------------------------------------------------------------------
// Server-config types (stdio form is the original, exported from types.ts;
// SSE form is new and lives here so we don't have to touch types.ts).
// ---------------------------------------------------------------------------

/** Stdio MCP server — spawns `command` with `args`, talks JSON-RPC over its
 *  stdio. The shape is what `McpServerConfig` in `types.ts` already is. */
export type McpStdioServerConfig = McpServerConfig;

/** SSE MCP server — POSTs JSON-RPC to `url`, opens a long-lived GET for the
 *  per-session event stream returned in the `initialize` response. */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  /** Optional HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
}

/** Discriminated union of all supported server-config shapes. We treat a
 *  config object with a `type: "sse"` as SSE, `type: "http"` as Streamable
 *  HTTP, anything else as stdio. This keeps existing configs (which have no
 *  `type` field) backward compatible. */
export type McpServerConfigEntry =
  | McpStdioServerConfig
  | McpSseServerConfig
  | McpHttpServerConfig;

/** Streamable HTTP MCP server (MCP 2025-03-26): a single endpoint that
 *  answers POSTs with either JSON or an SSE stream, tracks sessions via the
 *  `mcp-session-id` header, and accepts DELETE to end the session. */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** Type guard. */
export function isMcpSseConfig(
  cfg: McpServerConfigEntry
): cfg is McpSseServerConfig {
  return Boolean(cfg) && (cfg as McpSseServerConfig).type === "sse";
}

/** Type guard. */
export function isMcpHttpConfig(
  cfg: McpServerConfigEntry
): cfg is McpHttpServerConfig {
  return Boolean(cfg) && (cfg as McpHttpServerConfig).type === "http";
}

// ---------------------------------------------------------------------------
// Reverse-request (elicitation / sampling) types
// ---------------------------------------------------------------------------

/**
 * Handler for server-initiated (reverse) requests such as
 * `elicitation/create` and `sampling/createMessage`. Returning a value
 * resolves the request; throwing rejects it with a JSON-RPC error.
 */
export type McpServerRequestHandler = (
  serverName: string,
  method: string,
  params: unknown
) => Promise<unknown>;

/** Result shape for an `elicitation/create` response. */
export interface McpElicitationResult {
  /** The user's action: "accept" to return the data, "decline" to refuse
   *  without data, "cancel" to abort the request entirely. */
  action: "accept" | "decline" | "cancel";
  /** The elicited data, when `action === "accept"`. */
  data?: Record<string, unknown>;
}

/** Result shape for a `sampling/createMessage` response. */
export interface McpSamplingResult {
  role: "assistant";
  content: { type: "text"; text: string } | { type: "image"; data: string; mimeType?: string };
  /** Provider-specific model identifier that produced the message. */
  model?: string;
  /** Optional stop reason. */
  stopReason?: "end_turn" | "stop_sequence" | "max_tokens" | string;
}

// ---------------------------------------------------------------------------
// Transport context (OAuth host hook)
// ---------------------------------------------------------------------------

/** Context passed to every transport, used for OAuth on remote servers. */
export interface McpTransportContext {
  /** The working directory, for token persistence. */
  cwd: string;
  /** Host hook to open the OAuth authorization URL. If null, OAuth is
   *  disabled and remote servers requiring auth surface 401s as errors. */
  openAuthUrl: ((server: string, url: string) => void | Promise<void>) | null;
}
