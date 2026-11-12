// Public type surface for @codepilot/core.
// Public session/event types for the headless core API.

// The status-line config union is owned by statusLine.ts (the module that
// renders it); imported for use on CodepilotConfig and re-exported below so the
// public config type surface stays here.
import type { StatusLineConfig } from "./statusLine.js";

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

/** Extended-thinking / chain-of-thought text (Anthropic thinking, Gemini
 * thought parts, etc.). Persisted on the assistant `message` for replay and
 * export; stripped when rebuilding provider messages so it is not re-sent. */
export interface ReasoningBlock {
  type: "reasoning";
  text: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ReasoningBlock;

/**
 * Optional envelope fields stamped onto every persisted session event so
 * transcripts can be audited (cwd / branch / version / parent chain)
 * without bloating the live UI event stream.
 */
export interface EventMeta {
  /** Epoch ms when the event was produced. */
  ts?: number;
  /** Link id of the previous persisted event (`message.id`, `tool_call.id`, …). */
  parentId?: string;
  /** Workspace cwd at persist time. */
  cwd?: string;
  /** Current git branch when available. */
  gitBranch?: string;
  /** `@codepilot/core` version that wrote the event. */
  version?: string;
}

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
  /** Number of prompt-cache breakpoints the request placed (Anthropic inline
   * cache_control). Telemetry only; undefined for providers that do not place
   * inline markers (OpenAI/Gemini implicit caching). */
  cacheBreakpoints?: number;
}

export type TextDelta = { type: "text"; text: string };
export type ReasoningDelta = { type: "reasoning"; text: string };
export type ToolInputJsonDelta = { type: "tool_input_json"; toolCallId: string; partialJson: string };
export type MessageDelta = TextDelta | ReasoningDelta | ToolInputJsonDelta;

/** Outcome of sealing a crash-interrupted run: which execution was cut off and
 * how many orphaned tool calls were closed. Carried by the `interrupted_run`
 * event and returned by the boot-time recovery sweep. */
export interface InterruptedRunInfo {
  sessionId: string;
  /** The claim the interrupted run held, when one was recorded. */
  claim?: {
    executionId: string;
    turn: number;
    model: string;
    startedAt: number;
  };
  /** How many orphaned tool calls were sealed during recovery. */
  sealedToolCalls: number;
}

type EventBody =
  | {
      type: "message";
      id: string;
      role: "user" | "assistant";
      content: ContentBlock[];
 /**
  * Anchor this message against compaction: a pinned message is never folded,
  * trimmed, or dropped while unpinned content could be shed. Used for a key
  * requirement kept verbatim; only biases compaction eviction order.
  */
      pinned?: boolean;
 /** Images the user attached to this message. Persisted with the event so
 * later turns and resumed sessions still send them to the model. */
      images?: ImageAttachment[];
 /** Non-image files the user uploaded; written under
 * `~/.codepilot/projects/<hash>/uploads/` and referenced in the prompt so
 * the model can read them on disk. */
      files?: SavedUpload[];
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
/**
 * Lifecycle marker persisted when a tool call clears permission and is about
 * to execute. Lets crash-recovery seal an orphaned call: no marker = never
 * began; marker but no result = UNKNOWN. Control event; never sent to model.
 */
  | { type: "tool_started"; toolCallId: string; name: string }
  /**
   * Loop-detection telemetry emitted when a layer fires (warn/refuse/seq/path/
   * ask_reask). `count` is the exact-repetition count at fire time. Control
   * event; never sent to the model.
   */
  | {
      type: "doom_loop";
      kind: "warn" | "refuse" | "seq" | "path" | "ask_reask";
      tool: string;
      count: number;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      content: string;
      isError?: boolean;
      artifactRef?: string;
 /** Images returned by image-capable tools (e.g. read_image). They are
 * emitted alongside the tool_result as image content blocks so the
 * model can see them. */
      images?: ImageAttachment[];
    }
  | { type: "plan"; steps: PlanStep[] }
  | {
      type: "usage";
      usage: UsageInfo;
      /** True when this event rolls sub-agent tokens into the parent after
       * the child finished. Must not update last-provider-input heuristics
       * used for auto-compaction (it is a sum, not a single request size). */
      rollup?: boolean;
    }
  | {
 /**
 * Timing record for a single LLM request (one provider stream within a
 * turn). Persisted to the session log so slow turns can be diagnosed
 * precisely instead of inferred from file mtimes.
 */
      type: "request";
 /** Epoch ms when the provider stream was initiated. */
      startedAt: number;
 /** Epoch ms when the stream finished (or errored/aborted). */
      finishedAt: number;
 /** Wall-clock duration in ms (finishedAt − startedAt). */
      durationMs: number;
 /** Time-to-first-token in ms, when observed (first delta/usage). */
      ttftMs?: number;
 /** Model that served the request. */
      model?: string;
 /** Prompt tokens sent (input), when the provider reported usage. */
      inputTokens?: number;
 /** Completion tokens produced (output), when reported. */
      outputTokens?: number;
 /** False when the request errored or was aborted mid-stream. */
      ok: boolean;
    }
  | {
      type: "compaction";
      summary: string;
/**
 * Context reduction kind: `"summary"` (default) compactor dropped old
 * history for an LLM summary (original turns stay on disk); `"micro-fold"`
 * folds old large tool_results to short stubs (lossless).
 */
      kind?: "summary" | "micro-fold";
 /**
 * Index into the append-only session file of the first event still in
 * the live context after this summary. Used to rebuild the model view
 * on resume without re-summarising.
 */
      keepFrom?: number;
    }
 /**
  * A large payload was moved to the artifact store, leaving a head+tail stub in
  * the owning event. Durable record so a fork can replicate, artifact GC can
  * walk refs, and audit can account for offloads. NOT sent to the model.
  */
  | {
      type: "content_replacement";
      /** The event whose content was offloaded: the owning tool_call id for a
       * tool_result, or the message id for an offloaded image. */
      ownerId: string;
      /** What kind of payload was replaced. */
      target: "tool_result" | "image";
      /** The content-addressed artifact ref the full payload now lives at. */
      artifactRef: string;
      /** Size of the replaced payload in bytes (pre-offload). */
      bytes: number;
      /** Originating tool name, when the payload came from a tool_result. */
      tool?: string;
    }
  | {
      type: "status";
      status: "idle" | "running" | "waiting_permission" | "compacting";
      /**
       * Durable-execution claim, attached to the opening `running` status of a
       * real turn. Its presence in the JSONL tail after an unclean shutdown is
       * the crash-recovery signal; cleared by the trailing `idle`.
       */
      claim?: {
        /** Unique id for this execution attempt (one per prompt/turn start). */
        executionId: string;
        /** 1-based turn/prompt counter within the session. */
        turn: number;
        /** Model id driving the run. */
        model: string;
        /** Fingerprint of the history the run started from (event count +
         * last link id), so a resumer can tell the transcript apart. */
        fingerprint: string;
        /** Epoch ms when the claim was taken. */
        startedAt: number;
      };
    }
  | { type: "error"; message: string; recoverable: boolean }
 /** A prior run was interrupted (crash/kill) and sealed to idle by the
  * crash-recovery sweep. Advisory for the host; NOT persisted and never sent
  * to the model (it gets recovery context via the `<interrupted_run>` block). */
  | ({ type: "interrupted_run" } & InterruptedRunInfo)
 /** Transient failure being retried. Not persisted. When `discardMessageId`
 * is set, the partially streamed assistant message with that id was
 * thrown away and will be regenerated, together with the tool calls in
 * `discardToolCallIds` (streamed but never executed). */
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
      discardMessageId?: string;
      discardToolCallIds?: string[];
    }
 /** The fallback chain switched to a backup provider before any content was
  * produced. Carries the from/to provider names, the triggering error, and the
  * structured failover class (rate_limit / overloaded / server_5xx / transport
  * / quota). Observational only: never sent to the model, zero context cost. */
  | {
      type: "provider_failover";
      from: string;
      to: string;
      reason: string;
      failureKind: string;
    }
 /** Live progress marker — what the run is waiting on right now (the model,
 * or the named tools). Not persisted. */
  | { type: "activity"; phase: "model" | "tools"; since: number; tools?: string[] }
 /** Per-turn budget snapshot for the client status line. Emitted each turn so
  * a UI can show progress/stall. `windDownAt`/`maxTurns` null when unlimited;
  * `warning` true at/after the "turns left" nudge. Not persisted; not sent to
  * the model. */
  | {
      type: "turn_budget";
      turn: number;
      windDownAt: number | null;
      maxTurns: number | null;
      stalledTurns: number;
      warning?: boolean;
    }
 /** Stop hook blocked ending the turn; the agent will continue. Not persisted. */
  | { type: "stop_continue"; count: number; cap: number; reason: string }
 /** Live progress of one sub-agent spawned by a `task` call, for UIs. Never
 * sent to the model. `sessionId` is the sub-agent's run id (pass back as
 * `continue_session_id` to continue it); `runSeq` is a session-global monotonic
 * counter for unique UI labels. */
  | {
      type: "subagent";
      parentToolCallId: string;
      index: number;
      objective: string;
      state?: "running" | "ok" | "failed" | "interrupted";
      event?: Event;
      sessionId?: string;
      runSeq?: number;
     /** True for a sub-agent dispatched with `run: "background"` (returns
      * immediately; delivers a one-time completion summary to the parent). */
      background?: boolean;
    }
  | { type: "mode"; mode: AgentMode }
  | { type: "mode_request"; mode: AgentMode; reason?: string; rememberAuto?: boolean }
 /** The model asked (via `start_goal`) to escalate the current task into a
  * long-horizon goal loop. The host picks this up and drives rounds via
  * `runGoal` on this session. Nothing auto-fires in core. */
  | { type: "goal_request"; objective: string; maxRounds?: number; reason?: string }
  /** The model reported the goal's status via the structured `goal_status`
   * tool — the authoritative, format-drift-proof channel the goal loop trusts
   * ahead of scanning assistant text for `<goal_status>` markers. Only
   * meaningful inside an active goal loop; a no-op otherwise. Never sent to the
   * model. */
  | { type: "goal_status"; status: "completed" | "blocked"; reason?: string }
 /** Per-round progress of an active goal loop, surfaced for UIs. Mirrors the
  * data in `GoalCheckpointInfo`: round index, status, optional reason/blocker.
  * Emitted by the host while driving `driveGoalRounds` (via its onRound /
  * onCheckpoint callbacks). Purely informational — never sent to the model. */
  | {
      type: "goal_progress";
      round: number;
      status: "running" | "completed" | "blocked" | "round_limit";
      maxRounds?: number;
      reason?: string;
      blockedReason?: string;
    }
 /** A single edit applied by `edit_file`, streamed live for UIs so a
  * multi-edit (or large-file) edit shows progress as each hunk lands rather
  * than only at the final tool_result. `index`/`total` track position within a
  * multi-edit batch. Informational only — never sent to the model (the
  * tool_result already carries the authoritative outcome). */
  | {
      type: "edit_delta";
      path: string;
      index: number;
      total: number;
      strategy: string;
      occurrences: number;
    }
 /** Session endpoint changed via setModel / setProvider. */
  | { type: "model"; model: string; providerId?: string }
  | TeamMessageEvent
 /** Follow-up prompts queued while a run is busy. Not sent to the model;
 * UI-only. The queue itself lives on the Session; this event mirrors it. */
  | {
      type: "followup";
      action: "queued" | "removed" | "cleared" | "started" | "updated";
      items: FollowUpItem[];
    }
 /**
  * Anchor/unanchor a prior message against compaction (`pinned` on its
  * `message` event). Append-only safe: the original line is never rewritten;
  * on load the latest `pin` for a message id wins (last-writer-wins).
  */
  | { type: "pin"; messageId: string; pinned: boolean }
  /** A turn-boundary snapshot pair pushed onto (or moved between) the undo/redo
   * stacks, so `/undo` survives a reload. `action` replays the stack mutation on
   * load: `"push"` appends an undo entry (and clears redo), `"undo"` moves the
   * top undo entry to redo, `"redo"` moves it back. A control event — never sent
   * to the provider and absent from the live transcript's model view. */
  | {
      type: "undo_boundary";
      action: "push" | "undo" | "redo";
      baselineId: string;
      afterId: string;
      label: string;
    }
  /** Telemetry: the streaming-degeneration guard stopped a turn whose output
   * collapsed into a short repeating unit. `unit`/`repeats`/`soFarLen` describe
   * the loop. Informational; never sent to the model. */
  | {
      type: "degeneration";
      action: "stopped";
      unit: string;
      repeats: number;
      soFarLen: number;
    };

export type Event = EventBody & EventMeta;

/** A user prompt waiting to run after the current busy turn finishes. */
export interface FollowUpItem {
  id: string;
  text: string;
  images?: ImageAttachment[];
  files?: PromptFile[];
  /** Epoch ms when the item was enqueued. */
  queuedAt: number;
}

/**
 * Communication between members of an agent team (assignments, conclusions,
 * conflict notices). Persisted/streamed to the UI for audit, but invisible to
 * the model; the parent learns the outcome from the `task` tool result.
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
 * Collaboration mode. Controls which tools the model may call and shapes the
 * system prompt. `chat`: read-only Q&A. `plan`: read-only + `plan_update`.
 * `agent`: full autonomy (default; all tools).
 */
export type AgentMode = "chat" | "plan" | "agent";

/**
 * How unmatched tool calls are resolved.
 * `ask` (default) / `auto-edit` / `yolo` / `auto` (classifier) / `dont-ask`.
 * Hard floors (dangerous, sensitive paths) always prompt regardless.
 */
export type PermissionMode = "ask" | "auto-edit" | "yolo" | "auto" | "dont-ask";

/** Named permission presets: a single knob that bundles a permission mode with
 * a sandbox mode, so a user can switch overall posture in one step instead of
 * configuring the two dimensions separately. */
export type PermissionPresetName = "safe" | "standard" | "full-access" | "supervised-auto";

/** The (permissionMode, sandboxMode) each preset applies. Sandbox values match
 * `ResolvedSandbox["mode"]`. Kept as data so clients can render a picker and
 * the session can apply a preset through its existing live switches. */
export const PERMISSION_PRESETS: Record<
  PermissionPresetName,
  { permissionMode: PermissionMode; sandbox: "off" | "workspace-write" | "read-only"; description: string }
> = {
  // Read-only sandbox + prompt for everything: inspect a repo without risk.
  safe: { permissionMode: "ask", sandbox: "read-only", description: "read-only sandbox, prompt for every tool" },
  // The default balance: writes confined to the workspace, prompt for writes.
  standard: { permissionMode: "auto-edit", sandbox: "workspace-write", description: "workspace-write sandbox, auto-approve edits" },
  // No sandbox, never prompt: trusted, unattended runs.
  "full-access": { permissionMode: "yolo", sandbox: "off", description: "no sandbox, never prompt (trusted/unattended)" },
  // Mostly-unattended with a safety net: a background classifier lets benign
  // calls through and prompts (or denies) risky ones, inside a workspace jail.
  "supervised-auto": {
    permissionMode: "auto",
    sandbox: "workspace-write",
    description: "workspace-write sandbox, classifier auto-approves benign calls and prompts for risky ones",
  },
};

/**
 * Sandbox policy for shell commands and file tools.
 * `off` (legacy), `workspace-write` (read host, write cwd+temp+`~/.codepilot`),
 * `read-only` (no writes). Two-layer enforcement: process + tool.
 */
export interface SandboxConfig {
  mode?: "off" | "workspace-write" | "read-only";
  /**
   * Network policy. Boolean legacy form (`true`=full, `false`=none). Object form
   * enables an allowlist egress proxy: `{ mode, allow, allowPorts }`.
   * Modes: "off" / "full" / "proxy".
   */
  network?:
    | boolean
    | {
        mode: "off" | "full" | "proxy";
        /** Host globs reachable in "proxy" mode (e.g. "*.npmjs.org"). */
        allow?: string[];
        /** Allowed destination ports in "proxy" mode. Default [80, 443]. */
        allowPorts?: number[];
        /** Log refused hosts to the bash output tail. Default true. */
        denyLog?: boolean;
      };
 /** Extra absolute paths that are writable in workspace-write mode. */
  writablePaths?: string[];
  fallback?: "deny" | "allow-unsandboxed";
 /**
  * Carve the resolved `.git` directory (incl. a linked worktree's gitdir) out
  * of the writable roots as OS-level read-only, so an approved bash command
  * cannot rewrite hooks/config/objects. Unset leaves `.git` writable.
  */
  protectGit?: boolean;
 /**
  * How `.git` is treated at the OS sandbox layer; wins over `protectGit`.
  *  "protect": carve read-only. "allow-git-cli" (default): leave writable; risk
  *  gated at file-tool layer. "ask": same; file-tool ask is the gate.
  */
  gitWrite?: "protect" | "allow-git-cli" | "ask";
}

/**
 * Permission rules (`allow`/`ask`/`deny`), each a string:
 * "read_file" | "mcp__github__*" (wildcard) | "bash(npm test *)" (glob) |
 * "bash(/^…/ )" (regex). Order: deny > ask > allow > mode default.
 */
export interface PermissionRules {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  /**
   * Policy for reads/writes outside the working set (cwd + extra dirs + sandbox
   * writable roots + delivery roots). `ask` (default) prompts + grants;
   * `deny-write`/`deny-read-write` hard-deny writes/both.
   */
  workspaceBoundary?: "ask" | "deny-write" | "deny-read-write";
  /**
   * Extra directories that count as in-boundary alongside cwd. "Allow this
   * directory" grants persist here.
   */
  additionalWorkingDirectories?: string[];
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string;
 /**
 * When set, this ask is because the write target sits outside the sandbox
 * writable roots. Allow once → add `path` for this session only; Always →
 * also persist it under `sandbox.writablePaths`.
 */
  sandboxExpand?: { path: string };
}

/**
 * A permission decision from the host.
 * `always`: grants for the rest of THIS session (in-memory, not persisted).
 * `always-project`: additionally persists the narrowed rule to project config.
 */
export type PermissionDecision = "allow" | "deny" | "always" | "always-project";

/**
 * What a host's permission handler may return: a plain
 * {@link PermissionDecision}; a deny with `feedback` (→ steering); or
 * `{ decision: "abort" }` — cancel the whole turn; session NOT cleared.
 */
export type PermissionResolution =
  | PermissionDecision
  | { decision: "deny"; feedback: string }
  | { decision: "abort" };

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

/** The single source of truth for supported provider names. The type below is
 * derived from it, and both the config zod enum (`config.ts`) and the
 * protocol's advertised `capabilities.providers` (`server.ts`) consume this
 * same array so the three can never drift apart. */
export const PROVIDER_NAMES = ["anthropic", "openai", "copilot", "gemini", "azure"] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

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
 * dynamic registration), the client runs the Authorization Code + PKCE
 * flow on a 401 with `WWW-Authenticate: Bearer resource_metadata`. */
  oauthClientId?: string;
 /** sse / http: OAuth client secret, for confidential clients. Public
 * clients (the default) rely on PKCE alone and leave this unset. */
  oauthClientSecret?: string;
 /** sse / http: OAuth scopes to request. Defaults to the server-advertised
 * scopes or "openid profile". */
  oauthScopes?: string[];
  /** When true, keep the entry but do not start the server. */
  disabled?: boolean;
}

/** A user-configured lifecycle hook. */
export interface HookEntryConfig {
 /** Regex matched against the tool name ("*" = all); for
 * SessionStart/PreCompact/PostCompact/SubagentStop, the event discriminator. */
  matcher: string;
  /** Shell command; JSON payload on stdin. Exit 2 blocks (where the event
  * supports blocking); stdout JSON `{"decision":"block","reason":...}` blocks;
  * PostToolUse may emit `{"feedback":...}`; PreToolUse may emit
  * `{"updatedInput":{...}}`. Mutually exclusive with the other handlers. */
  command?: string;
 /** HTTP endpoint to POST the payload to. Response body = JSON decisions (same
 * schema as `command` stdout). Non-2xx: 4xx → block, else warning. */
  http?: string;
 /** Optional: extra headers for the `http` request. Ignored for `command`. */
  httpHeaders?: Record<string, string>;
 /** Optional: timeout in ms for `http` requests (default 10s). */
  timeout?: number;
 /** MCP tool handler: invoke `<server>:<tool>` with the payload as args; result
 * parsed as JSON decisions. Requires a wired MCP resolver. */
  mcpTool?: string;
 /** Prompt handler: send payload as JSON to the small model; parse its text
 * response as JSON decisions. For NL hook logic. Requires a prompt resolver. */
  prompt?: string;
 /** Agent handler: spawn a sub-agent with the payload as its objective; its
 * conclusion text is parsed as JSON decisions. Heavier than `prompt` but can
 * read_file to inspect the repo. Mutually exclusive with `command`/`http`. */
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
 /**
   * Fires when a sub-agent finishes. Matcher: agent_type (explore|worker|custom).
   * Exit 2 / `decision: block` continues the sub-agent with feedback (capped
   * by `stopHookBlockCap`), same contract as Stop.
   */
  SubagentStop?: HookEntryConfig[];
  Notification?: HookEntryConfig[];
  /**
   * Fires when the agent is about to end a turn. Exit 2 / `decision: block`
   * continues the run with the reason as feedback (capped by
   * `stopHookBlockCap`). `stopVerify` runs before these hooks when enabled.
   */
  Stop?: HookEntryConfig[];
}

/** Convergence / no-progress thresholds. Every field is optional; an unset
 * field falls back to the built-in constant. See `CodepilotConfig.convergence`. */
export interface ConvergenceConfig {
  /** Soft convergence ceiling (same as `convergenceCap`; 0 disables it). */
  cap?: number;
  /** Turns of slack between where wind-down starts and the hard break. */
  hardSlack?: number;
  /** No-durable-progress turn count that triggers the soft nudge (default 8). */
  noProgressSoft?: number;
  /** …the stronger nudge (default 12). */
  noProgressStrong?: number;
  /** …the tool lock + synthesis urge (default 16). A soft land, not a failure. */
  noProgressLock?: number;
  /** Turns before the ceiling at which the "turns left" nudge fires (default 2). */
  remainingNudgeAt?: number;
}

/** Loop-detection thresholds + exclusions. Every field is optional; an unset
 * field falls back to the built-in constant. See `CodepilotConfig.doomLoop`. */
export interface DoomLoopConfig {
  /** Exact-repetition count at which a call is WARNED (default 3). */
  warnAt?: number;
  /** Exact-repetition count at which a call is REFUSED (default 4). */
  refuseAt?: number;
  /** Sliding window size for rotating-batch detection (default 6). */
  seqWindow?: number;
  /** Overlap count within the window that trips a rotating loop (default 4). */
  seqRepeat?: number;
  /** Whether a tripped rotating-batch loop (layer 2) REFUSES the call (default
   * true) or only WARNS. The counterpart of `refuseAt: 0` for layer 2. */
  seqRefuse?: boolean;
  /** Overlapping re-read count for `read_file` that WARNS (default 3). */
  pathWarnAt?: number;
  /** Window-overlap fraction counting as a re-read spiral (default 0.6). */
  pathOverlap?: number;
  /** Tool names or `tool::glob` patterns excluded from layer 1/2 counting. */
  exclude?: string[];
}

export interface CodepilotConfig {
  provider?: ProviderName;
  model?: string;
  smallModel?: string;
 /** API key; otherwise read from env: ANTHROPIC_API_KEY / OPENAI_API_KEY / GITHUB_TOKEN. */
  apiKey?: string;
 /** OpenAI-compatible base URL (e.g. DeepSeek / vLLM / Ollama). For the
 * `azure` provider this is the Azure OpenAI resource endpoint, e.g.
 * `https://<resource>.openai.azure.com`. */
  baseURL?: string;
 /** Azure OpenAI `api-version` query param. Only used when `provider` is
 * `azure`; defaults to a recent GA version when omitted. */
  azureApiVersion?: string;
 /** OpenAI API dialect. `chat` (default) uses `/v1/chat/completions`;
 * `responses` uses the newer `/v1/responses` endpoint (tool calls and
 * reasoning stream as named events). Only consulted when `provider` is
 * `openai`; other providers ignore it. */
  apiStyle?: "chat" | "responses";
  permissionMode?: PermissionMode;
  maxTokens?: number;
 /** Token threshold to trigger compaction. */
  /** Model context window (tokens). Soft auto-compact fires near
   * `window × compactionThreshold`; every provider request is hard-trimmed
   * to stay under the usable window (window − output reserve − system). */
  contextWindow?: number;
 /** Soft fold target for mid-run tool_result pruning (default 48_000).
 * Independent of `contextWindow`: keeps routine turns small/fast. The hard
 * window cap still applies — raising this cannot exceed `contextWindow`. */
  maxContextTokens?: number;
 /** Rolling tool-output window: fold tool_results older than the keep
 * window down to this many, early and
 * independent of the token budget, so numerous small results can't quietly
 * accumulate. Default 24; set 0 to fold all old results. The budget-based
 * fold still applies regardless. */
  maxToolResultsInContext?: number;
 /** Hard upper bound on bytes `read_file` buffers for a single read. A file
  * larger than this is refused before its contents are read, so a huge file
  * cannot OOM the process. Default 64 MiB; line windows do not bypass it. */
  maxReadBytes?: number;
 /** `grep` search backend. "walker" (default) uses the built-in file walker
  * (no native dependency). "rg" shells out to ripgrep on PATH (walker fallback
  * if absent/failed); "auto" prefers ripgrep when installed for speed on large
  * trees, else the walker. */
  grep?: { backend?: "walker" | "rg" | "auto" };
 /** Auto-compaction trigger as a fraction of the context window (0–1).
 * Default 0.92. Checked before each model turn during a long tool loop,
 * not only after the prompt ends. Set `autoCompact: false` to disable
 * (manual `/compact` still works). */
  compactionThreshold?: number;
 /** Master toggle for auto-compaction. When false, the session never
 * auto-compacts regardless of token pressure; the user must invoke
 * `/compact` explicitly. Default true. */
  autoCompact?: boolean;
 /** Consecutive failed/ineffective auto-compactions before the circuit breaker
  * disables auto-compaction for the session. A failure is a throw, a no-change
  * result, or a success that left the transcript still over the hard trigger.
  * A manual `/compact` can still run and, if it gets back under budget,
  * re-enables auto-compaction. Default 3. */
  autoCompactMaxConsecutiveFailures?: number;
 /** Tuning for the `auto` permission mode's background classifier (see
  * {@link PermissionMode}). Only consulted when the mode is `auto`. */
  permissionAuto?: {
   /** Consecutive classifier denials before the engine stops trusting the
    * classifier and falls back to an interactive prompt for the current ask.
    * A misfiring classifier must be able to hand control back to the human.
    * Default 3. */
   maxConsecutiveDenials?: number;
   /** Total classifier denials in a session before every subsequent soft ask
    * falls back to an interactive prompt (regardless of the consecutive
    * streak). 0 disables the total cap. Default 10. */
   maxTotalDenials?: number;
  };
 /** For `dont-ask` mode: when true, a denied soft ask carries a short standard
  * feedback note to the model ("configured to run without prompts — add an
  * allow rule to enable this") instead of a bare "permission denied". Default
  * true. */
  dontAskFeedback?: boolean;
 /** Models to treat as HIGH-RISK: when the active model id matches one of these
  * (substring, case-insensitive), persisted allow rules are IGNORED during
  * permission matching (deny/ask + safety floors still apply), so a broad allow
  * cannot vouch for a destructive call. Session "always" grants kept unless
  * `highRiskDropSessionAllows` is set. */
  highRiskModels?: string[];
 /** When true, a high-risk model (see {@link highRiskModels}) additionally
  * ignores this-session "always allow" grants, not only persisted ones.
  * Default false. */
  highRiskDropSessionAllows?: boolean;
 /** Inline (Tab) code completion for editor plugins. Off by default; gated to a
  * lightweight model (`completion.model` or `smallModel`), OFF when that is the
  * main chat model. Ignored by non-editor clients. */
  completion?: {
   /** Master toggle. Default false. */
   enabled?: boolean;
   /** Explicit lightweight completion model on the same provider/apiKey.
    * Overrides the smallModel gate when set. */
   model?: string;
   /** Debounce before firing after the user pauses typing (ms). Default ~200. */
   debounceMs?: number;
   /** Soft cap on suggestion length (tokens). Default small (see core). */
   maxTokens?: number;
   /** Use the provider's native fill-in-the-middle endpoint
    * (OpenAI-compatible `/v1/completions` with `suffix`) instead of the prompted
    * chat path. Opt-in: only enable when the completion model is a FIM/Coder
    * model (DeepSeek-Coder, Codestral, Qwen-Coder, …). Default false. */
   fim?: boolean;
  };
 /** Prompt-cache warming (opt-in). When true, keep an Anthropic ephemeral
  * cache alive across idle gaps by replaying the last request (1-token output
  * cap) at ~90% of the cache TTL, but only when expected savings beat the
  * warm's own cost. Default false. */
  cacheWarming?: boolean;
 /** Prompt-cache breakpoint lifetime (Anthropic). "5m" (default) uses the
  * standard ephemeral TTL; "1h" asks for the extended one-hour TTL (lower miss
  * rate after long idle gaps, higher cache-write price). Endpoints that do not
  * support the extended TTL silently fall back to 5m. */
  promptCache?: { ttl?: "5m" | "1h" };
 /** When true, attempt to load the optional pure-JS `gpt-tokenizer` for
  * provider-accurate token counts (falls back to the built-in heuristic
  * when the package is not installed). Default false. */
  preciseTokens?: boolean;
 /** Structured audit log. `true` logs tool calls/results/errors to
  * `~/.codepilot/audit/`; an object may set a custom `dir`. Default off. */
  audit?: boolean | { dir?: string };
  mcpServers?: Record<string, McpServerConfig>;
 /** Allowlist of MCP server names permitted to start. Empty/omitted = no
  * restriction (every configured, non-disabled server starts). When non-empty,
  * a server whose name is not listed is refused start and a note is logged.
  * Intended for a managed layer to pin which MCP servers may run. */
  mcpAllowedServers?: string[];
 /** Opt-in inbound channels: deliver allowlisted MCP server notifications into
  * the session as a synthesized user message. Default off (omitted). A narrow,
  * auditable relay, not a general permission bridge. */
  inboundChannels?: {
    /** Master switch. Default false → no inbound delivery. */
    enabled?: boolean;
    /** Allowlist entries match a notification by `server:method`, bare `method`,
     * or bare `server`. Empty/omitted with `enabled` relays nothing. */
    allow?: string[];
  };
 /** Language-server configs for the `lsp_navigate` tool. Omit to use the
 * built-in TypeScript/JavaScript default. */
  lsp?: { servers?: Array<{ command: string; args?: string[]; languages: string[]; initializationOptions?: Record<string, unknown> }> };
 /** How external MCP tools are surfaced to the model:
 * - "lazy": hide individual schemas, expose a single `mcp` meta-tool (keeps
 *   the prompt small).
 * - "eager": advertise every MCP tool directly.
 * - "auto" (default): eager when few, lazy once many. */
  mcpToolDiscovery?: "auto" | "lazy" | "eager";
 /** Tool-count threshold for `auto` to switch from eager to lazy. Default 8. */
  mcpLazyThreshold?: number;
 /** Progressive disclosure for plugin-contributed tools, mirroring the MCP
  * controls. "eager" (default) advertises every plugin tool schema each turn;
  * "lazy" (or "auto" past `pluginLazyThreshold`) hides the individual schemas
  * and exposes a single `tool_catalog` meta-tool (list/describe/call/batch).
  * Default behaviour is unchanged (eager). */
  pluginToolDiscovery?: "auto" | "lazy" | "eager";
 /** Tool-count threshold for plugin `auto` to switch to lazy. Default 8. */
  pluginLazyThreshold?: number;
 /** Context-gauge precision. "off" (default) uses the local estimate for
  * `/context`. "on-demand" allows `/context --precise` (or a UI action) to call
  * the provider's token-count API once for an exact count; precise counting is
  * never automatic and never feeds the compaction threshold. */
  context?: { preciseCount?: "off" | "on-demand" };
  /** Live streaming-degeneration guard that stops a turn when the output
   * collapses into a short repeating unit. Defaults match the built-in
   * constants; `enabled: false` disables the guard entirely. Orthogonal to the
   * tool-level doom-loop guard. */
  degeneration?: {
    enabled?: boolean;
    windowChars?: number;
    maxPeriod?: number;
    minRepeats?: number;
    threshold?: number;
    checkEveryChars?: number;
  };
 /** Instruction-file discovery. By default the hierarchical walk for
  * CODEPILOT.md / AGENTS(.override).md / CLAUDE(.local).md stops at the git
  * toplevel (or the cwd when not in a repo). `walkToHome: true` walks up to the
  * user's home directory instead. */
  memory?: {
    walkToHome?: boolean;
    /** Query-time progressive recall of relevant memory topic files into the
     * volatile per-turn context. Default on; skipped when auto-memory is off. */
    autoRecall?: boolean;
    /** Max topic files recalled per turn. Default 5. */
    recallMax?: number;
  };
 /** Tool names or bash command regexes that auto-approve.
 * @deprecated prefer `permissions.allow` (same rule syntax). */
  autoApprove?: string[];
 /** allow/ask/deny permission rule lists. See {@link PermissionRules}. */
  permissions?: PermissionRules;
 /** OS-level sandbox policy. Default: workspace-write, fail-closed. */
  sandbox?: SandboxConfig;
 /** Extra secret-redaction patterns applied to tool output, on top of the
  * built-in floor (which always runs and cannot be disabled here). */
  redact?: { patterns?: Array<{ name: string; regex: string; flags?: string; replace?: string }> };
 /**
  * Cap on assistant↔tool round trips for one user prompt. Unset or `0` = no
  * limit (doom-loop/cancel/budget guards still stop the run). Set a positive
  * number for headless/CI cost bounds.
   */
  maxTurns?: number;
 /** Soft convergence ceiling that applies even when `maxTurns` is unlimited.
  * After this many turns the loop winds down: urges synthesis and hard-disables
  * tool calls for the final turn. Catches a weak model re-verifying with variant
  * commands (which the doom-loop guard can't). Unset = built-in default; `0` off.
  */
  convergenceCap?: number;
 /** Fine-grained convergence / no-progress thresholds. Every field defaults to
  * the built-in constant, so an absent block changes nothing. `cap` is an alias
  * for the soft convergence ceiling (0 disables it); the no-progress gradient
  * and wind-down offsets let a long task raise or relax the backstops. */
  convergence?: ConvergenceConfig;
 /** Loop-detection thresholds + exclusions. Every field defaults to a built-in
  * constant, so an unset/empty object changes nothing. `exclude` lists tool
  * names or `tool::glob` patterns that are never counted toward the
  * exact-repetition or rotating-batch layers (dedup replay still applies). */
  doomLoop?: DoomLoopConfig;
 /** code_mode execution runtime. "vm" (default) runs the model's JavaScript in
  * an in-process Node vm context; "subprocess" runs it in a separate Node child
  * wrapped by the same OS sandbox as `bash` (a stronger isolation boundary,
  * opt-in). The delegated tool calls are proxied back to the parent either way,
  * so both runtimes expose the same API and the same path guard. */
  codeMode?: { runtime?: "vm" | "subprocess" };
 /** Per-model tool-exposure downgrade. Each rule hides `drop` tools from any
  * model whose id glob-matches an entry in `models`. Applied after mode
  * filtering, so it can only remove tools. Lets a deployment keep the complex
  * tools (e.g. `code_mode`, `apply_patch`) away from models that serialize
  * them poorly, without affecting stronger models. Unset = no downgrade. */
  toolExposure?: { models: string[]; drop: string[] }[];
 /** How many times a turn whose stream failed transiently (dropped
 * connection, overloaded gateway) is regenerated before giving up.
 * Default 2; 0 disables. */
  turnRetries?: number;
 /** Optional per-sub-agent wall-clock budget in milliseconds. A sub-agent
 * (via the `task` tool) running longer is abandoned so a stuck worker
 * can't starve a parallel fan-out. Unset (default) means no timeout. */
  subagentTimeoutMs?: number;
 /** Max sub-agent nesting depth (default 3). Depth 0 is the top-level agent;
 * a sub-agent calling `task` is depth 1, etc. Enforced by withholding the
 * `task` tool once the cap is reached. */
  subagentMaxDepth?: number;
 /** Max sub-agents running concurrently across the whole session (default 6).
 * A shared semaphore enforces this; the main brake on fan-out speed/cost. */
  subagentMaxThreads?: number;
 /** Max total sub-agents a session may spawn across the whole run (default
 * 200). Bounds cumulative fan-out regardless of tree shape, so a deep/wide
 * tree can't fork-bomb the token budget. */
  subagentMaxTotal?: number;
 /** Whether a built-in sub-agent (explore/worker) shares the parent's live
  * PermissionEngine or runs under a fresh one. "inherit" (default) carries the
  * parent engine in; "independent" gives each its own engine so a mid-session
  * grant to the parent does not widen the sub-agent. Custom agents are always
  * independent. */
  subagentPermissions?: "inherit" | "independent";
 /** Durable reuse of a completed sub-agent's conclusion. When a `task` spec
  * (same objective + agent type + cwd + model) already succeeded within the TTL,
  * the stored conclusion is returned instead of re-running — makes an
  * interrupted fan-out resumable. `enabled` default true; `ttlHours` default 24. */
  subagentCache?: { enabled?: boolean; ttlHours?: number };
 /** Lifecycle hooks (PreToolUse/PostToolUse/Notification/Stop). */
  hooks?: HooksConfig;
 /**
   * Max consecutive Stop-hook continues before the session forces the turn
   * to end. Default 8. Set `0` to never continue (first block still ends
   * the turn after one forced allow). Unset uses the default.
   */
  stopHookBlockCap?: number;
  /**
   * Built-in Stop validity gate (default `"off"`). `"prompt"`/`true`: small
   * model judges correctness; `"tests"`: run a detected project test command.
   */
  stopVerify?:
    | boolean
    | "off"
    | "prompt"
    | "tests"
    | { mode: "off" | "prompt" | "tests"; forceContinue?: boolean };
  /** Expose the `harness_bridge` tool (external agent CLI subprocess). Default off. */
  enableHarnessBridge?: boolean;
  /** harness_bridge backend tuning. The CLI (stdout-scrape) path is the default
   * and the fallback; opt in here to allow the official-protocol backend for a
   * harness that ships one (currently `codex` via its app-server JSON-RPC). */
  harnessBridge?: {
    /** Permit the protocol backend when a tool call asks for it. Default false
     * → only the CLI path is used. */
    allowProtocol?: boolean;
    /** Override the codex app-server launch argv. Default `["codex", "app-server"]`. */
    codexAppServerCommand?: string[];
    /** Scrub secret-looking env keys from the spawned harness's environment.
     * Default true. Set false to inherit the full parent env (not recommended). */
    scrubSecrets?: boolean;
    /** Exact env key names to KEEP despite looking like secrets. */
    envKeep?: string[];
    /** Exact env key names to force-REMOVE in addition to the secret patterns. */
    envScrub?: string[];
  };
  /** Auto-apply model `suggest_mode` switches without re-asking. Default off. */
  autoAcceptModeSuggestions?: boolean;
  /**
   * Execution-reliability guard: verify provider messages match the persisted
   * event log before each request.
   * - `"off"` / `"warn"` (default) / `"throw"` (fail the turn, CI/tests).
   */
  consistencyCheck?: "off" | "warn" | "throw";
 /** When true, command hooks run under the same OS sandbox as `bash`
  * (Seatbelt / bwrap) instead of at full host trust. Opt-in; default off. */
  hookSandbox?: boolean;
 /** Ordered backup providers for automatic failover (rate limit / outage). */
  fallbacks?: ProviderFallbackConfig[];
 /** Failover routing policy for the `fallbacks` chain. Only transient pressure
  * (rate-limit / overload / 5xx / transport) cascades by default; auth and
  * invalid-request errors never cascade. `onQuota` governs an exhausted quota,
  * which is usually account-wide: default "fail" (surface it) over "next". */
  fallbackPolicy?: { onQuota?: "next" | "fail" };
 /** Max HTTP retries on transient errors (429/5xx). Default 8. */
  maxRetries?: number;
 /** Base delay for exponential backoff (ms). Default 2000. */
  baseRetryDelayMs?: number;
 /** Cap for exponential backoff delay (ms). Default 60_000. */
  maxRetryDelayMs?: number;
 /** Abort retrying once the next backoff would exceed this (ms), surfacing
 * a recoverable error instead of blocking. Default 30_000. 0 disables. */
  retryAbortOnDelayMs?: number;
 /** Default collaboration mode for new sessions (default: "agent"). */
  agentMode?: AgentMode;
 /** Auto memory master toggle (default: true). When false, the agent never
 * writes auto-memory notes and the index is not loaded into the prompt. */
  autoMemoryEnabled?: boolean;
 /** Minimum hours between background memory-consolidation runs (default: 6). */
  memoryConsolidationMinHours?: number;
 /** Minimum accumulated draft notes before a consolidation runs (default: 5). */
  memoryConsolidationMinDrafts?: number;
 /** Directory for plan files. Default: `~/.codepilot/projects/<hash>/plans`.
 * Absolute, or relative to the project root when set. Plan files are
 * written here when the agent calls `plan_done`. */
  plansDirectory?: string;
 /** Directory for spec-driven-development artifacts (requirements.md /
 * design.md / tasks.md, one sub-folder per feature). Default:
 * `<cwd>/.codepilot/specs`. Absolute, or relative to the project root when
 * set. Unlike plans, specs default INSIDE the repo so they are reviewed and
 * versioned with the code they describe. */
  specDirectory?: string;
  /** Skill discovery configuration. `enabled: false` disables discovery
   * entirely; `dirs` adds extra skill root directories (relative to cwd);
   * `disabled` omits named skills (kept on disk, not advertised/loadable). */
  skills?: {
    enabled?: boolean;
    dirs?: string[];
    disabled?: string[];
  };
 /** web_fetch configuration: per-domain allowlist + cache TTL. */
  webFetch?: WebFetchConfig;
 /** web_search backend selection (duckduckgo | brave | serper | google). */
  webSearch?: WebSearchConfig;
 /** image_gen configuration. The `image_gen` tool is only registered when
 * this is present with a baseURL + apiKey (and not explicitly disabled) —
 * not every model/provider can generate images, so it's opt-in. */
  imageGen?: ImageGenConfig;
 /** Model reasoning effort. Controls how much the model
 * "thinks" before responding. Providers that support it (OpenAI o-series,
 * DeepSeek) pass this through; others ignore it. Default undefined
 * (provider default). */
  reasoningEffort?: "low" | "medium" | "high";
 /** Extended-thinking token budget (Anthropic). When set and > 0, enables a
  * `thinking` block with this budget; the model's reasoning streams as
  * reasoning deltas. Overrides the budget derived from `reasoningEffort`.
  * Non-Anthropic providers ignore it. Default undefined. */
  thinkingBudget?: number;
 /** Model output verbosity. Unlike `outputStyle` (which controls the
 * teaching posture), this is a direct verbosity hint some providers
 * honour. Default undefined (provider default). */
  modelVerbosity?: "low" | "medium" | "high";
 /** Status line. Either a built-in declarative preset (`type: "preset"`) that
 * renders model/mode/context/branch with no scripting, or a custom script
 * (`type: "command"`) the TUI spawns per update, feeding it a JSON payload on
 * stdin and rendering its stdout. */
  statusLine?: StatusLineConfig;
 /** Name of a registered `AgentRuntime` to drive this
 * session's agent loop instead of the built-in default loop. Undefined
 * (or "default") means the standard `runAgent` loop. Unknown names
 * throw at prompt time rather than silently degrading. Plugins register
 * custom runtimes via `runtimeRegistry.register` in their init hook. */
  runtime?: string;
 /** Per-runtime options, keyed by runtime name (e.g.
 * `{ mcts: { candidates: 4 } }`). Each runtime reads and validates its
 * own entry; unknown keys are ignored rather than rejected, so a plugin
 * runtime can define options the core knows nothing about. */
  runtimeOptions?: Record<string, unknown>;
 /** First-run onboarding marker. Set (to an ISO timestamp) once the user has
  * been shown the first-launch setup guide — whether they completed it or
  * skipped it — so the TUI never auto-opens the guide again. User-scope only. */
  onboardedAt?: string;
 /** Session-lifecycle tuning for a long-lived daemon. */
  sessions?: SessionsConfig;
}

/** Session-lifecycle tuning for a long-lived daemon. */
export interface SessionsConfig {
 /** When the daemon starts, sweep the sessions directory for any session whose
  * last status is in-flight (interrupted by crash/kill) and seal it to idle
  * before anyone reopens it. Seal-and-idle only — never re-enters the agent
  * loop (a prior run's side effects may already have executed). */
  reconcileOnBoot?: boolean;
 /** Delete non-pinned sessions whose transcript is older than this many days
  * (by mtime). 0 (default) never deletes. Pinned sessions are always exempt.
  * Swept fail-soft at daemon startup. */
  retentionDays?: number;
 /** When true, sessions not touched for `coldCompressAfterDays` days have their
  * plaintext JSONL compressed to a `.jsonl.br` sibling (brotli) to reclaim disk;
  * they are transparently decompressed when next opened. Default false. */
  coldCompress?: boolean;
 /** Days of inactivity before a session is eligible for cold compression when
  * `coldCompress` is on. Default 30. */
  coldCompressAfterDays?: number;
}

// Re-export the status-line config shapes (owned by statusLine.ts) so the
// public config type surface stays in one place.
export type {
  StatusLineConfig,
  StatusLinePresetConfig,
  StatusLineCommandConfig,
  StatusLineItem,
  StatusLinePresetName,
} from "./statusLine.js";

export interface WebFetchConfig {
 /** Hard allowlist of fetchable domains, matched by suffix (e.g. `github.com`
  * also matches `api.github.com`). When non-empty, a domain not on the list is
  * refused. When omitted/empty, every non-blocked domain is allowed. */
  allowedDomains?: string[];
 /** Domains always denied, matched by suffix (overrides allowedDomains). */
  blockedDomains?: string[];
 /** Cache TTL in minutes (default 15; set 0 to disable caching). */
  cacheTtlMinutes?: number;
}

/** image_gen configuration. Points at any OpenAI-images-compatible endpoint
 * (OpenAI `gpt-image-1`, or a compatible gateway) with its own key, kept
 * separate from the chat provider since image generation uses a different
 * model and often a different account. */
export interface ImageGenConfig {
 /** Base URL of the images API, e.g. `https://api.openai.com/v1`. Required
 * to enable the tool. The tool POSTs to `${baseURL}/images/generations`
 * (and `/images/edits` for image-to-image). */
  baseURL?: string;
 /** API key for the images endpoint. Supports `${ENV}` interpolation.
 * Required to enable the tool. */
  apiKey?: string;
 /** Image model id (default `gpt-image-1`). */
  model?: string;
 /** Explicit off switch even when baseURL/apiKey are present (default on). */
  enabled?: boolean;
}

/** Which search backend `web_search` uses. */
export type WebSearchProvider = "duckduckgo" | "brave" | "serper" | "google" | "custom";

/**
 * A user-defined HTTP search backend. URL/headers/body support `{query}`/`{max}`/
 * `{language}`/`{region}` placeholders + `${ENV}` interpolation; the JSON response
 * is mapped to hits via `resultsPath` + `fields`. Any JSON search API works.
 */
export interface CustomSearchTemplate {
 /** HTTP method. Default `GET`. */
  method?: "GET" | "POST";
 /** Request URL. Placeholders are URL-encoded. e.g.
  * `https://api.example.com/search?q={query}&n={max}`. */
  url: string;
 /** Request headers; values support `${ENV}` and placeholders. */
  headers?: Record<string, string>;
 /** Request body for POST; a JSON string with placeholders (NOT URL-encoded
  * inside JSON) or any raw string. Ignored for GET. */
  body?: string;
 /** Dot-path to the results array in the JSON response, e.g. `data.items`.
  * Omit when the response is itself an array. */
  resultsPath?: string;
 /** Which fields of each result hold the title / url / snippet. Each is a
  * dot-path relative to a result object. Defaults: `title` / `url` /
  * `snippet`. */
  fields?: { title?: string; url?: string; snippet?: string };
}

export interface WebSearchConfig {
 /** Search backend. Defaults to auto: if a provider API key is present
  * (config or env), that provider is used; otherwise the keyless
  * DuckDuckGo HTML scraper. */
  provider?: WebSearchProvider;
 /** API key for the chosen backend. Supports `${ENV}` interpolation.
  * When omitted, the tool falls back to the provider's conventional env
  * var (BRAVE_API_KEY / SERPER_API_KEY / GOOGLE_API_KEY). Unused by
  * DuckDuckGo. */
  apiKey?: string;
 /** Google Programmable Search Engine id (`cx`). Required for the
  * `google` backend; falls back to the GOOGLE_CSE_ID env var. */
  cx?: string;
 /** Override the backend endpoint (advanced / self-hosted gateways). */
  endpoint?: string;
 /** Preferred result language (ISO-639-1, e.g. `zh`/`en`/`ja`). When omitted,
  * auto-detected from the query (CJK vs. Latin). Mapped to each backend's native
  * param (DDG `kl`, Bing `setlang`, Brave `search_lang`, Google `lr`/`hl`). */
  language?: string;
 /** Preferred result region/country as an ISO-3166-1 alpha-2 code (e.g.
  * `cn`, `us`, `jp`). When omitted, inferred alongside `language`. Mapped to
  * DDG `kl`, Bing `cc`, Brave `country`, Google `gl`, Serper `gl`. */
  region?: string;
 /** Restrict results by recency: `day` | `week` | `month` | `year`. Mapped
  * to Brave `freshness`, Google `dateRestrict`, Serper `tbs`, DDG/Bing `df`.
  * When omitted, no recency filter is applied. */
  freshness?: "day" | "week" | "month" | "year";
 /** HTTP template for the `custom` backend (provider: "custom"). Required
  * when provider is `custom`; ignored otherwise. */
  custom?: CustomSearchTemplate;
}

export interface ImageAttachment {
  mediaType: string;
  base64: string;
}

/** A file the user uploaded with a prompt, after it was written to disk. */
export interface SavedUpload {
  name: string;
 /** Path relative to the session cwd. */
  path: string;
  mediaType?: string;
  bytes: number;
}

/** Raw file payload accepted by `prompt/send` / `Session.prompt`. */
export interface PromptFile {
  name: string;
  mediaType?: string;
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
 * Surfaced into the system prompt so the model can tailor advice (e.g.
 * "open the diff" only makes sense in an IDE). */
  hostSurface?: "cli" | "tui" | "vscode" | "idea";
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionResolution>;
 /** Host handler for structured user questions (ask_user_question / plan_done). */
  onAskUser?: (req: QuestionRequest) => Promise<QuestionAnswers>;
 /** Handler for MCP server-initiated requests (`elicitation/create`,
 * `sampling/createMessage`). When unset, such requests are rejected
 * with a JSON-RPC error. The handler receives the server name, the
 * method, and the params object, and should return the JSON-RPC
 * `result` field. */
  onMcpServerRequest?: (
    serverName: string,
    method: string,
    params: unknown
  ) => Promise<unknown>;
 /** Host handler for MCP OAuth: called when a remote MCP server requires
 * authorization. The host opens `authorizationUrl` (browser or print) and
 * returns; the core handles the redirect listener + token exchange. When unset,
 * OAuth-requiring servers fail with a 401 instead of launching a browser flow. */
  onMcpOpenAuthUrl?: (serverName: string, authorizationUrl: string) => void | Promise<void>;
 /** Host handler for `start_goal`: the model asked to escalate the current
  * task into a long-horizon goal loop. The host should drive rounds (e.g. via
  * `runGoal` on this session) and return true if it accepted. When unset, the
  * `goal_request` event still emits for stream consumers, but the tool tells
  * the model no loop was started so it continues in the current turn. */
  onGoalRequest?: (req: { objective: string; maxRounds?: number; reason?: string }) => boolean | Promise<boolean>;
 /** Host-supplied LSP diagnostics provider. When set, the `diagnostics`
 * tool reads from it; otherwise the tool reports unavailability. */
  diagnosticsProvider?: import("./tools/diagnostics.js").DiagnosticsProvider;
 /** Override the chat provider. When set, skips `buildProvider` entirely.
 * Used by the Agent SDK for replay mode and custom provider injection. */
  provider?: import("./providers/types.js").ChatProvider;
 /** Name of a registered `AgentRuntime` to use for this session's prompt
 * loop. Overrides `config.runtime`. Undefined/"default"
 * keeps the standard `runAgent` loop. */
  runtime?: string;
 /** Whether `createSession` should discover plugins and register the agent
 * runtimes they declare. Default true. Set
 * false to keep the process registry untouched — plugin runtime modules
 * execute host code, so hosts that never opt into plugins can skip it. */
  pluginRuntimes?: boolean;
 /** Extra skill directories (e.g. installed plugins' `skills/` dirs) to merge
  * into discovery during `init()`. Set by `createSession` from discovered
  * plugins; hosts rarely pass this directly. */
  pluginSkillDirs?: string[];
 /** Extra custom-agent directories (plugins' `agents/` dirs) to merge into
  * discovery during `init()`. Set by `createSession` from discovered plugins. */
  pluginAgentDirs?: string[];
 /** Read-only open: do NOT acquire the single-writer lease and never append to
  * the JSONL. Used to inspect a session already owned by another process (or
  * for pure read tooling). A read-only session that attempts a write-path
  * action (prompt, mode/model change persist, reconcile seal) is inert. */
  readOnly?: boolean;
 /** Identity recorded in the write-lease lock file so a second opener can be
  * redirected to attach to this owner as a subscriber. A daemon passes its
  * discovery url + token here. Ignored for read-only opens. */
  lockIdentity?: { host?: string; url?: string; token?: string };
}

/** Owner recorded in a session's write-lease lock file, re-exported on the
 * SessionLockedError a write-open throws when a live owner already holds it. */
export interface SessionLockOwnerInfo {
  pid: number;
  acquiredAt: number;
  host?: string;
  url?: string;
  token?: string;
}

export interface GoalRunOptions extends SessionOptions {
  objective: string;
  maxRounds?: number;
  onRound?: (round: number, status: string) => void;
  /** Force the loop to `blocked` after this many CONSECUTIVE rounds that made
   * no observable progress (no write/edit, no successful shell, no plan step
   * advanced, and an empty or marker-less reply). Any round with progress resets
   * the counter. Default 3; set 0 to disable stall detection. */
  maxStalls?: number;
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
  /** Pinned within its workspace (at most one per cwd). */
  pinned?: boolean;
  /** Archived: hidden from the main list, shown under an "Archived" section. */
  archived?: boolean;
}
