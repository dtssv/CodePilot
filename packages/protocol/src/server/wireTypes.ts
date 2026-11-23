import type {
  AgentMode,
  Diagnostic,
  EngineUpdateInfo,
  Event,
  PermissionDecision,
  PermissionMode,
  ProviderPreset,
  QuestionAnswers,
  QuestionRequest as CoreQuestionRequest,
  RichSessionSummary,
  UsageInfo,
} from "@codepilot/core";

/** Mirrors the headless protocol's `event` notification params. */
export interface EventParams {
  sessionId: string;
  event: Event;
}

export interface UsageParams {
  sessionId: string;
  usage: UsageInfo;
}

export interface InitializeParams {
  protocolVersion: number;
  cwd: string;
  permissionMode: PermissionMode;
  clientInfo: { name: string; version: string };
}

export interface InitializeResult {
  protocolVersion: number;
  capabilities: {
    tools: string[];
    providers: string[];
 /** Supported collaboration modes (per the headless protocol). */
    modes: AgentMode[];
 /** Config / model management methods available on this server. */
    config?: boolean;
    setModel?: boolean;
    /** Native/system folder picker (`workspace/pickFolder`) is available. */
    workspacePick?: boolean;
    /** Scoped phone QR remote-control session (limited RPCs). */
    remoteControl?: boolean;
    /** Extended git operations (git/branches, git/commit, git/push, …). */
    git?: boolean;
  };
  /** Running engine (CLI/daemon) version — distinct from IDE plugin / VSIX. */
  serverInfo?: { name: string; version: string; channel: "engine" };
}

export interface SystemUpdateCheckResult {
  engine: EngineUpdateInfo;
}

export interface SystemUpdateApplyResult {
  applied: boolean;
  version: string;
  message?: string;
}

export interface SessionSetModelParams {
  sessionId: string;
  model: string;
 /** Named provider preset id; when set, switches vendor + model. */
  providerId?: string;
  /**
   * Reasoning / extended-thinking effort. `null` turns thinking off;
   * omit to leave the session's current effort unchanged.
   */
  reasoningEffort?: "low" | "medium" | "high" | null;
}

export interface ConfigUpsertProviderParams {
  id: string;
  preset: ProviderPreset;
 /** When true, also activate this preset as the user default. */
  setActive?: boolean;
 /** Optional session to sync immediately. */
  sessionId?: string;
}

export interface ConfigDeleteProviderParams {
  id: string;
}

export interface ConfigSetActiveParams {
  providerId: string;
  model?: string;
  sessionId?: string;
 /** Persist as user default (default true). */
  persist?: boolean;
}

export interface SessionNewParams {
  cwd?: string;
  model?: string;
  systemPromptExtra?: string;
 /** Initial collaboration mode (default "agent"). */
  agentMode?: AgentMode;
}

export interface SessionResumeParams {
  sessionId: string;
  /** Open read-only when another process holds the write lease: no lease is
   * taken and no events are appended. Used to inspect a session owned
   * elsewhere. When false/absent and a live owner holds the lease, resume
   * fails with a SESSION_LOCKED error carrying the owner's attach info. */
  readOnly?: boolean;
  /** Cap on events returned in the initial resume payload. Defaults to
   * {@link DEFAULT_RESUME_HISTORY_LIMIT}. Pass `0` for the full history.
   * Older events are available via `session/history`. */
  historyLimit?: number;
}

export interface SessionResumeResult {
  sessionId: string;
  events: Event[];
  /** True when the session was opened read-only (another process owns the
   * write lease); prompts and persisted edits are inert for this handle. */
  readOnly?: boolean;
  /** True when `events` is a tail slice — call `session/history` with
   * `before: historyBefore` to fetch older events. */
  historyTruncated?: boolean;
  /** Exclusive end index into the full history for the next older page. */
  historyBefore?: number;
}

export interface SessionHistoryParams {
  sessionId: string;
  /** Exclusive end index into the full history (from a prior resume/history). */
  before: number;
  /** Max events to return (default {@link DEFAULT_RESUME_HISTORY_LIMIT}). */
  limit?: number;
}

export interface SessionHistoryResult {
  events: Event[];
  /** True when still more older events remain. */
  historyTruncated: boolean;
  /** Next `before` for another page, when truncated. */
  historyBefore?: number;
}

/** Default tail size for `session/resume` / `session/history` pages. */
export const DEFAULT_RESUME_HISTORY_LIMIT = 250;

export interface SessionListResult {
  sessions: RichSessionSummary[];
}

export interface WorkspaceListParams { path?: string; cwd?: string; }
export interface WorkspaceEntry { name: string; path: string; kind: "file" | "directory"; size?: number; }
export interface WorkspaceListResult { path: string; entries: WorkspaceEntry[]; }
/** Native OS folder dialog (server-side). Cancel → path null. */
export interface WorkspacePickFolderResult { path: string | null; supported: boolean; }
/** Browse an absolute directory on the serve host (folder picker UI). */
export interface WorkspaceBrowseParams { path?: string; cwd?: string; }
export interface WorkspaceBrowseResult {
  path: string;
  parent?: string;
  entries: Array<{ name: string; path: string; kind: "file" | "directory" }>;
  roots: Array<{ label: string; path: string }>;
}
export interface WorkspaceReadParams { path: string; cwd?: string; }
export interface WorkspaceReadResult {
  path: string;
  content: string;
  size: number;
  hash: string;
  truncated: boolean;
  /** utf8 (default) or base64 for binary previews (images). */
  encoding?: "utf8" | "base64";
  /** MIME hint when encoding is base64 (e.g. image/png). */
  mediaType?: string;
}
export interface WorkspaceSearchParams { query: string; path?: string; maxResults?: number; cwd?: string; }
export interface WorkspaceSearchResult { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean; }

/** Slash-command discovery for the `/` menu (shared by every client surface). */
export interface CommandsListParams { cwd?: string; }
export interface CommandInfoRpc {
  name: string;
  description: string;
  argumentHint?: string;
  /** "builtin" = shipped shared command; "project"/"user" = markdown command;
   * "plugin" = command shipped by an installed plugin;
   * "mcp" = dynamic MCP prompt (expanded via prompts/get). */
  source: "builtin" | "project" | "user" | "plugin" | "mcp";
  /** "local" = a client-side action (switch mode, open a picker, compact, …);
   * "prompt" = expands into a model turn. Built-ins are local; custom markdown
   * and MCP prompt commands are prompt. Lets a GUI client branch without a
   * hard-coded name list. */
  kind: "local" | "prompt";
}
export interface CommandsListResult { commands: CommandInfoRpc[]; warnings: string[]; }

/** Expand a prompt-kind slash command (markdown body or MCP prompts/get). */
export interface CommandsExpandParams {
  /** Command name without leading `/`. */
  name: string;
  /** Raw argument text after the command name. */
  args?: string;
  cwd?: string;
}
export interface CommandsExpandResult {
  prompt: string;
  model?: string;
  allowedTools?: string[];
  source: CommandInfoRpc["source"];
}

/** `@`-mention completion for the composer. One endpoint, many candidate kinds. */
export type CompletionKind = "file" | "dir" | "mcp" | "git" | "skill";
export interface WorkspaceCompleteParams {
  /** Text typed after `@` (may be empty to list top candidates). */
  query: string;
  /** Restrict to specific kinds; default = all available. */
  kinds?: CompletionKind[];
  maxResults?: number;
  cwd?: string;
}
export interface CompletionCandidate {
  kind: CompletionKind;
  /** The token inserted into the prompt (what the agent resolves), e.g. the
   * path, or `@mcp:server/uri`. */
  value: string;
  /** Human label for the menu. */
  label: string;
  /** Secondary detail (relative dir, server name, symbol kind…). */
  detail?: string;
}
export interface WorkspaceCompleteResult {
  candidates: CompletionCandidate[];
  /** True when more matches existed than returned (caller should keep typing / drill into a folder). */
  truncated?: boolean;
}
/** Resolve a (possibly bare / relative) path to an absolute one the host can
 * open, using the same workspace basename fallback as workspace/read. */
export interface WorkspaceResolveParams { path: string; cwd?: string; }
export interface WorkspaceResolveResult { path: string; absolute: string; exists: boolean; }
export interface WorkspaceWriteParams { path: string; content: string; expectedSize?: number; expectedHash?: string; cwd?: string; }
export interface WorkspaceWriteResult { path: string; size: number; hash: string; }
export interface WorkspaceGitStatusResult { branch: string; files: Array<{ path: string; index: string; worktree: string; status: string }>; }
export interface WorkspaceGitDiffParams { path?: string; staged?: boolean; cwd?: string; }
export interface WorkspaceGitDiffResult { path?: string; diff: string; truncated: boolean; }

// ---- Extended Git operations (workspace panel actions) ----
export interface GitBranchesResult { current: string; branches: Array<{ name: string; current: boolean; upstream?: string; ahead?: number; behind?: number }>; tags: string[]; detached: boolean; }
export interface GitActionParams {
  cwd?: string;
  /** For stage/unstage/commit-scope: specific paths; omit = all. */
  paths?: string[];
}
export interface GitCommitParams { cwd?: string; message: string; all?: boolean; }
export interface GitPushPullParams { cwd?: string; remote?: string; branch?: string; setUpstream?: boolean; }
export interface GitCheckoutParams { cwd?: string; branch: string; create?: boolean; }
export interface GitGenericResult { ok: boolean; output: string; }
export interface GitCommitMessageResult { message: string; }

/** Inline (Tab) code completion for the editor plugins. prefix/suffix framed
 * for a future native FIM swap. Stateless: the client owns debounce / cancel / cache. */
export interface InlineCompletionParams {
  /** Text before the cursor (client-capped). */
  prefix: string;
  /** Text after the cursor (FIM-ready; chat phase uses as trailing context). */
  suffix: string;
  /** Workspace-relative path of the edited file — language inference only. */
  path: string;
  /** Opaque client token; echoed so the client can match its newest request. */
  requestId: string;
  /** Which workspace / session's provider to use. */
  cwd?: string;
  sessionId?: string;
  /** Soft cap on suggestion length (tokens). Defaults to the core small cap. */
  maxTokens?: number;
}
export interface InlineCompletionResult {
  /** Text to insert at the cursor. Empty string = no suggestion. */
  completion: string;
  /** Echoed request token for the client to match against its latest request. */
  requestId: string;
  /** Set when completion was skipped WITHOUT calling the model — currently
   * "no-small-model" when the resolved model is the main chat model (design
   * §2.5). Lets the client show the one-time "configure a lightweight
   * completion model" notice. */
  disabledReason?: string;
}
/** Cancel an in-flight inline completion by its requestId so the upstream model
 * call is aborted (stops burning tokens on a suggestion the client discarded). */
export interface CompletionCancelParams { requestId: string; }
export interface WorkspaceStatParams { path: string; cwd?: string; }
export interface WorkspaceStatResult { path: string; exists: boolean; size: number; hash: string; modifiedAt?: number; }
export interface WorkspaceWatchParams { path?: string; cwd?: string; }
export interface WorkspaceWatchResult { watching: boolean; path: string; }
export interface WorkspaceChangedParams {
  path: string;
 /** Debounced change kinds since the last notification. */
  kinds: Array<"rename" | "change">;
 /** Set when the underlying watcher failed; clients should fall back to polling. */
  error?: string;
}

export interface PromptSendParams {
  sessionId: string;
  text: string;
  images?: { mediaType: string; base64: string }[];
 /** Non-image uploads; written under `~/.codepilot/projects/<hash>/uploads/`. */
  files?: { name: string; mediaType?: string; base64: string }[];
  /**
   * How to deliver the prompt when a run may already be active:
   * `auto` (idle→start, busy→queue), `queue`, or `steer` (inject into run).
   */
  delivery?: "auto" | "queue" | "steer";
}

export interface PromptSendResult {
  delivery: "started" | "queued" | "steered";
}

export interface PromptResumeParams {
  sessionId: string;
}

export interface PromptResumeResult {
  /**
   * `started` — re-entered the last turn. `queued` — a run was already active.
   * `noop` — nothing to resume (no prior user turn, or last turn ended cleanly).
   */
  delivery: "started" | "queued" | "noop";
}

export interface PromptFollowupRemoveParams {
  sessionId: string;
  id: string;
}

export interface PromptFollowupUpdateParams {
  sessionId: string;
  id: string;
  text: string;
}

export interface PromptFollowupSendNowParams {
  sessionId: string;
  id: string;
}

export interface PromptCancelParams {
  sessionId: string;
}

export interface PermissionRespondParams {
  requestId: string;
 /** `abort` = "deny & stop": refuse this call and end the whole prompt/turn. */
  decision: PermissionDecision | "abort";
 /** Decline-with-feedback: when `decision` is `"deny"`, an optional correction
  * message that is surfaced to the model as the tool result instead of a
  * canned "permission denied". Ignored for allow/always. */
  feedback?: string;
}

export interface QuestionRespondParams {
  requestId: string;
 /** Answers keyed by question id: option label(s) or free text. */
  answers: QuestionAnswers;
}

export interface SessionForkParams {
  sessionId: string;
  atEventIndex?: number;
}

/**
 * Wire params for `session/setMode`: change a session's collaboration
 * mode at runtime.
 */
export interface SessionSetModeParams {
  sessionId: string;
  mode: AgentMode;
}

/** Scope of a persisted permission rule: project (`repo`) or global (`user`). */
export type PermissionRuleScope = "repo" | "user";
export type PermissionRuleEffect = "allow" | "ask" | "deny";

/** `permissions/list`: read persisted permission rules for a scope. */
export interface PermissionsListParams {
  sessionId: string;
  scope?: PermissionRuleScope;
}
export interface PermissionsListResult {
  scope: PermissionRuleScope;
  allow: string[];
  ask: string[];
  deny: string[];
}

/** `permissions/add` / `permissions/remove`: CRUD a persisted rule. The change
 * is written to the scope's config file AND hot-applied to the live session. */
export interface PermissionsEditParams {
  sessionId: string;
  rule: string;
  effect: PermissionRuleEffect;
  scope?: PermissionRuleScope;
}
export interface PermissionsAddResult {
  path: string;
}
export interface PermissionsRemoveResult {
  removed: boolean;
}

/** Wire params for the reverse request we send to the client. */
export interface PermissionRequestParams {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string;
 /** Present when the write sits outside sandbox writable roots. */
  sandboxExpand?: { path: string };
 /** Present when this ask is a per-command sandbox jail drop. */
  sandboxEscalation?: true;
  /** Live-disk before/after preview for write/edit/apply_patch approvals. */
  preview?: string;
}

/** Wire params for the reverse `question/request` (ask_user_question / plan_done). */
export interface QuestionRequestParams {
  sessionId: string;
  requestId: string;
  questions: CoreQuestionRequest["questions"];
}

/** Notification (`permission/resolved` / `question/resolved`): another
 * client answered this request — dismiss any prompt still showing it. */
export interface PromptResolvedParams {
  sessionId: string;
  requestId: string;
}

/** Wire params for the reverse `diagnostics/request` the server sends to the
 * client when the `diagnostics` tool runs. The host (an IDE with a language
 * server) answers it inline; a host with no LSP replies `unavailable`. */
export interface DiagnosticsRequestParams {
  sessionId: string;
 /** Omit for the whole workspace; present for a single file. */
  path?: string;
}

/** Inline result the client returns for `diagnostics/request`. Exactly one of
 * `diagnostics` (file request) / `files` (workspace request) is populated, or
 * `unavailable: true` when the host has no language server — then the core tool
 * prints its "not available, use bash" fallback. */
export interface DiagnosticsRequestResult {
  diagnostics?: Diagnostic[];
  files?: { path: string; diagnostics: Diagnostic[] }[];
  unavailable?: boolean;
}