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
      /** Images returned by image-capable tools (e.g. read_image). They are
       *  emitted alongside the tool_result as image content blocks so the
       *  model can see them. */
      images?: ImageAttachment[];
    }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "usage"; usage: UsageInfo }
  | { type: "compaction"; summary: string }
  | {
      type: "status";
      status: "idle" | "running" | "waiting_permission" | "compacting";
    }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "mode"; mode: AgentMode }
  | { type: "mode_request"; mode: AgentMode; reason?: string }
  | TeamMessageEvent;

/**
 * Communication between members of an agent team (ROADMAP-NEXT §4.2):
 * leader assignments, worker conclusions, conflict notices.
 *
 * These events are persisted and streamed to the UI so a team run can be
 * audited afterwards, but they are deliberately invisible to the model —
 * `compactTranscriptToProviderMessages` ignores them, so a team's internal
 * chatter never inflates the parent's context. The parent agent learns the
 * outcome from the `task` tool result, as with any other sub-agent.
 */
export interface TeamMessageEvent {
  type: "team_message";
  /** Member name, or "team" for orchestrator notices. */
  from: string;
  /** Target member name, or "all" for a broadcast. */
  to: string;
  content: string;
  /** Epoch milliseconds. */
  timestamp: number;
  /** What kind of message this is, for UI grouping. */
  kind?: "assignment" | "conclusion" | "conflict" | "summary" | "status";
}

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

/** A structured question posed to the user via the host UI. */
export interface QuestionSpec {
  /** Stable id echoed back in the answers map. */
  id: string;
  /** Optional short heading (e.g. "Confirm", "Scope"). */
  header?: string;
  question: string;
  /** Optional choices; omitting them yields a free-text answer. */
  options?: Array<{ label: string; description?: string }>;
  /** Allow selecting more than one option (default false). */
  multiSelect?: boolean;
}

export interface QuestionRequest {
  requestId: string;
  questions: QuestionSpec[];
}

/** Answers keyed by question id: option label(s) or free text. */
export type QuestionAnswers = Record<string, string | string[]>;

export type ProviderName = "anthropic" | "openai" | "copilot";

/** A backup provider tried when the primary fails transiently. */
export interface ProviderFallbackConfig {
  provider: ProviderName;
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export interface McpServerConfig {
  /** Transport selector. Defaults to "stdio" when omitted (back-compat). */
  type?: "stdio" | "sse" | "http";
  /** stdio: executable to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** sse / http: endpoint URL. */
  url?: string;
  /** sse / http: extra HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** sse / http: OAuth 2.1 client id. If set (or if the server supports
   *  dynamic registration), the client runs the Authorization Code + PKCE
   *  flow on a 401 with `WWW-Authenticate: Bearer resource_metadata`. */
  oauthClientId?: string;
  /** sse / http: OAuth client secret, for confidential clients. Public
   *  clients (the default) rely on PKCE alone and leave this unset. */
  oauthClientSecret?: string;
  /** sse / http: OAuth scopes to request. Defaults to the server-advertised
   *  scopes or "openid profile". */
  oauthScopes?: string[];
}

/** A user-configured lifecycle hook (claude-code style). */
export interface HookEntryConfig {
  /** Regex matched against the tool name; "*" matches all.
   *  For SessionStart/PreCompact/PostCompact/SubagentStop, matched against
   *  the event's discriminator (source/trigger/agent_type) instead. */
  matcher: string;
  /** Shell command; receives a JSON payload on stdin. Exit 2 = block (where
   *  the event supports blocking). Stdout JSON `{"decision":"block","reason":"..."}`
   *  also blocks; PostToolUse may emit `{"feedback":"..."}`; PreToolUse may
   *  emit `{"updatedInput":{...}}` to rewrite the tool input.
   *
   *  Mutually exclusive with `http`, `mcp_tool`, `prompt`, and `agent`.
   *  At least one handler type must be provided. */
  command?: string;
  /** HTTP endpoint to POST the hook payload to (claude-code-style `http`
   *  handler). The response body is interpreted as JSON for decisions
   *  (same schema as `command` stdout: `{"decision":"block","reason":"..."}`
   *  etc.). A non-2xx status is treated as exit-code-2 (block) when the
   *  status is 4xx, or a warning (non-fatal) otherwise.
   *
   *  Mutually exclusive with `command`. */
  http?: string;
  /** Optional: extra headers for the `http` request. Ignored for `command`. */
  httpHeaders?: Record<string, string>;
  /** Optional: timeout in ms for `http` requests (default 10s). */
  timeout?: number;
  /** MCP tool handler: invoke an MCP server tool by name
   *  (`<server>:<tool>`). The hook payload is passed as the tool's
   *  arguments. The tool's text result is interpreted as JSON for
   *  decisions (same schema as `command` stdout).
   *
   *  Mutually exclusive with `command` and `http`. Requires an MCP
   *  resolver to be wired into the HookEngine. */
  mcpTool?: string;
  /** Prompt handler: send the hook payload (as JSON) to the small model
   *  as a user message and interpret the model's text response as JSON
   *  for decisions. Use for natural-language hook logic that's hard to
   *  express in a shell script (e.g. "is this command safe to run?").
   *
   *  Mutually exclusive with `command` and `http`. Requires a prompt
   *  resolver to be wired into the HookEngine. */
  prompt?: string;
  /** Agent handler: spawn a sub-agent with the hook payload as its
   *  objective. The sub-agent's conclusion text is interpreted as JSON
   *  for decisions. Heavier than `prompt` but can use tools (e.g.
   *  read_file to inspect the repo before deciding).
   *
   *  Mutually exclusive with `command` and `http`. Requires an agent
   *  resolver to be wired into the HookEngine. */
  agent?: string;
}

/** Lifecycle hooks configuration. See hooks.ts. */
export interface HooksConfig {
  /** Fires when a session begins or resumes. Matcher: source (startup|resume|clear|compact|fork). */
  SessionStart?: HookEntryConfig[];
  /** Fires when the user submits a prompt, before the model sees it. Can block or rewrite. */
  UserPromptSubmit?: HookEntryConfig[];
  PreToolUse?: HookEntryConfig[];
  PostToolUse?: HookEntryConfig[];
  /** Fires before context compaction. Matcher: trigger (manual|auto). Can block. */
  PreCompact?: HookEntryConfig[];
  /** Fires after compaction. Matcher: trigger (manual|auto). Cannot block. */
  PostCompact?: HookEntryConfig[];
  /** Fires when a sub-agent finishes. Matcher: agent_type (explore|worker|custom). */
  SubagentStop?: HookEntryConfig[];
  Notification?: HookEntryConfig[];
  Stop?: HookEntryConfig[];
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
  /** Auto-compaction trigger as a fraction of the context window (0–1).
   *  Default 0.92 (claude-code-style: compact when ~92% full). Set to 1 to
   *  only compact at the hard window limit, or set `autoCompact: false` to
   *  disable auto-compaction entirely (manual `/compact` still works). */
  compactionThreshold?: number;
  /** Master toggle for auto-compaction. When false, the session never
   *  auto-compacts regardless of token pressure; the user must invoke
   *  `/compact` explicitly. Default true. */
  autoCompact?: boolean;
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
  /** Lifecycle hooks (PreToolUse/PostToolUse/Notification/Stop). */
  hooks?: HooksConfig;
  /** Ordered backup providers for automatic failover (rate limit / outage). */
  fallbacks?: ProviderFallbackConfig[];
  /** Default collaboration mode for new sessions (default: "agent"). */
  agentMode?: AgentMode;
  /** Auto memory master toggle (default: true). When false, the agent never
   *  writes auto-memory notes and the index is not loaded into the prompt. */
  autoMemoryEnabled?: boolean;
  /** Directory for plan files (default: <cwd>/.codepilot/plans). Relative
   *  to the project root. Plan files are written here when the agent calls
   *  `plan_done`, so they survive as reviewable artifacts. */
  plansDirectory?: string;
  /** web_fetch configuration: per-domain allowlist + cache TTL. */
  webFetch?: WebFetchConfig;
  /** Model reasoning effort (codex-style). Controls how much the model
   *  "thinks" before responding. Providers that support it (OpenAI o-series,
   *  DeepSeek) pass this through; others ignore it. Default undefined
   *  (provider default). */
  reasoningEffort?: "low" | "medium" | "high";
  /** Model output verbosity. Unlike `outputStyle` (which controls the
   *  teaching posture), this is a direct verbosity hint some providers
   *  honour. Default undefined (provider default). */
  modelVerbosity?: "low" | "medium" | "high";
  /** Custom status-line script (claude-code-style). When set, the TUI spawns
   *  this command on each status update, feeds it a JSON payload on stdin
   *  describing the session, and renders its stdout as the status line. */
  statusLine?: StatusLineConfig;
  /** Name of a registered `AgentRuntime` (ROADMAP-NEXT §4.1) to drive this
   *  session's agent loop instead of the built-in default loop. Undefined
   *  (or "default") means the standard `runAgent()` loop. Unknown names
   *  throw at prompt time rather than silently degrading. Plugins register
   *  custom runtimes via `runtimeRegistry.register()` in their init hook. */
  runtime?: string;
  /** Per-runtime options, keyed by runtime name (e.g.
   *  `{ mcts: { candidates: 4 } }`). Each runtime reads and validates its
   *  own entry; unknown keys are ignored rather than rejected, so a plugin
   *  runtime can define options the core knows nothing about. */
  runtimeOptions?: Record<string, unknown>;
}

export interface StatusLineConfig {
  /** Must be `"command"`. */
  type: "command";
  /** Path to an executable or inline command. `~` is expanded. */
  command: string;
  /** Horizontal inset (in characters) for the status line container. Default 0. */
  padding?: number;
  /** Minimum interval between invocations in ms. Clamped to >= 300. Default 300. */
  updateIntervalMs?: number;
  /** Maximum time the command may run before being killed. Default 2000. */
  timeoutMs?: number;
}

export interface WebFetchConfig {
  /** Domains the agent may fetch without an interactive permission prompt.
   *  Each entry is matched by suffix (e.g. `github.com` matches
   *  `api.github.com` too). When omitted/empty, all domains are asked (the
   *  pre-existing behaviour). */
  allowedDomains?: string[];
  /** Domains always denied (overrides allowedDomains). */
  blockedDomains?: string[];
  /** Cache TTL in minutes (default 15; set 0 to disable caching). */
  cacheTtlMinutes?: number;
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
  /** Host surface this session runs in: "cli" (default) | "tui" | "vscode" | "idea".
   *  Surfaced into the system prompt so the model can tailor advice (e.g.
   *  "open the diff" only makes sense in an IDE). */
  hostSurface?: "cli" | "tui" | "vscode" | "idea";
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
  /** Host handler for structured user questions (ask_user_question / plan_done). */
  onAskUser?: (req: QuestionRequest) => Promise<QuestionAnswers>;
  /** Handler for MCP server-initiated requests (`elicitation/create`,
   *  `sampling/createMessage`). When unset, such requests are rejected
   *  with a JSON-RPC error. The handler receives the server name, the
   *  method, and the params object, and should return the JSON-RPC
   *  `result` field. */
  onMcpServerRequest?: (
    serverName: string,
    method: string,
    params: unknown
  ) => Promise<unknown>;
  /** Host handler for MCP OAuth: called when a remote MCP server requires
   *  authorization. The host should open `authorizationUrl` in a browser
   *  (or print it for the user) and return once the URL has been surfaced.
   *  The core handles the redirect listener + token exchange. When unset,
   *  remote servers requiring OAuth will fail with a 401 instead of
   *  launching a browser flow. */
  onMcpOpenAuthUrl?: (serverName: string, authorizationUrl: string) => void | Promise<void>;
  /** Host-supplied LSP diagnostics provider. When set, the `diagnostics`
   *  tool reads from it; otherwise the tool reports unavailability. */
  diagnosticsProvider?: import("./tools/diagnostics.js").DiagnosticsProvider;
  /** Override the chat provider. When set, skips `buildProvider()` entirely.
   *  Used by the Agent SDK for replay mode and custom provider injection. */
  provider?: import("./providers/types.js").ChatProvider;
  /** Name of a registered `AgentRuntime` to use for this session's prompt
   *  loop (ROADMAP-NEXT §4.1). Overrides `config.runtime`. Undefined/"default"
   *  keeps the standard `runAgent()` loop. */
  runtime?: string;
  /** Whether `createSession` should discover plugins and register the agent
   *  runtimes they declare (ROADMAP-NEXT §4.1 Phase 2). Default true. Set
   *  false to keep the process registry untouched — plugin runtime modules
   *  execute host code, so hosts that never opt into plugins can skip it. */
  pluginRuntimes?: boolean;
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
