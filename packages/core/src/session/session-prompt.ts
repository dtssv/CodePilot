// User-turn entry (`prompt`) and error-resume helpers. Extracted from Session (move-only split).

import { randomUUID } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import { type AgentDeps } from "../agent/agent.js";
import { type PermissionClassifier } from "../permissions/permissionClassifier.js";
import { type AgentRuntime } from "../agent/runtime.js";
import type {
  AgentMode,
  CodepilotConfig,
  Event,
  ImageAttachment,
  PermissionRequest,
  PermissionResolution,
  PromptFile,
  SessionOptions,
} from "../types.js";
import { type ToolRegistry } from "../tools/types.js";
import { type ArtifactStore } from "../tools/artifacts.js";
import { type PermissionEngine } from "../permissions/permissions.js";
import { type McpManager } from "../mcp/mcp.js";
import { type HookEngine } from "../hooks/hooks.js";
import { type ResolvedSandbox } from "../sandbox/sandbox.js";
import { type PersistentShell } from "../sandbox/persistentShell.js";
import { type WorkspaceTracker } from "../workspace/workspaceTracker.js";
import { type PostWrite } from "../workspace/postWrite.js";
import { type DedupCache } from "../agent/doomLoop.js";
import { type FileObservationStore } from "../workspace/fsObservation.js";
import { type ChatProvider } from "../providers/types.js";
import type { CacheTurn } from "../compaction/cacheStats.js";
import { startPromptSpan, endPromptSpan, type PromptSpan } from "./session-telemetry.js";
import { resolveSessionMcpReferences } from "../mcp/sessionBind.js";
import {
  extractDeliveryRootsFromText,
  mergeDeliveryRoots,
} from "../workspace/deliveryRoots.js";
import { resolveImageMentions } from "../workspace/imageMentions.js";
import { materializeUploads } from "../workspace/promptFiles.js";
import { projectStatePath, scratchDir } from "../workspace/projectState.js";
import {
  buildStopTranscriptHint,
  effectiveStopVerifyMode,
  resolveStopVerifyForceContinue,
  runBuiltinStopVerify,
  STOP_VERIFY_ADVICE_PREFIX,
} from "../agent/stopVerify.js";
import {
  createSnapshot,
  createSnapshotFromContents,
  readFileOrNull,
} from "./snapshots.js";
import {
  type HistoryHost,
  type UndoEntry,
  openWorkspaceTracker,
  persistUndoBoundary,
} from "./session-history.js";
import { type SteeringItem } from "./session-steer.js";
import { buildProvider } from "./session-utils.js";
import {
  DEFAULT_STOP_HOOK_BLOCK_CAP,
  DEFAULT_STOP_VERIFY_FORCE_CAP,
  NON_MUTATING_TOOLS,
  persistAutoAcceptModeSuggestions,
  slimSubagentEvent,
} from "./session-helpers.js";

type SystemPromptCache = {
  staticPrefix: string;
  dynamicSuffix: string;
  full: string;
  stableContext?: string;
  volatileSuffix?: string;
} | null;

export type PromptHost = {
  disposed: boolean;
  id: string;
  cwd: string;
  config: CodepilotConfig;
  model: string;
  mode: AgentMode;
  prePlanMode: AgentMode | null;
  autoAcceptModeSuggestions: boolean;
  title: string | null;
  resumedFromInterrupt: boolean;
  memoryIndexDirty: boolean;
  turnCounter: number;
  turnOverrideModel: string | null;
  events: Event[];
  hooks: HookEngine;
  mcp: McpManager | null;
  mcpReady: Promise<McpManager | null>;
  deliveryRoots: string[];
  toolRegistry: ToolRegistry;
  artifacts: ArtifactStore;
  permissions: PermissionEngine;
  sandbox: ResolvedSandbox;
  providerOverride?: ChatProvider;
  systemPromptCache: SystemPromptCache;
  cancelController: AbortController | null;
  steerController: AbortController | null;
  steeringQueue: SteeringItem[];
  turnPreImages: Map<string, Buffer | null>;
  pendingWritePaths: Map<string, string[]>;
  turnBaseTree: string | null;
  turnTreePending: boolean;
  workspaceTracker: WorkspaceTracker | null | undefined;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  touchedFiles: Set<string>;
  persistentShell: PersistentShell | null;
  pluginContextTransform:
    | ((view: import("../providers/types.js").ProviderMessage[]) => import("../providers/types.js").ProviderMessage[])
    | undefined;
  dedupCache: DedupCache;
  fileObservations: FileObservationStore;
  postWrite: PostWrite;
  redactPatterns: readonly import("../permissions/redact.js").RedactionPattern[];
  pendingRelevantMemories: string | null;
  lastProviderInputTokens: number;
  contextAnchor: { input: number; eventCount: number } | null;
  usageTotal: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cacheTurns: CacheTurn[];
  contextChangedForNextTurn: boolean;
  rateLimitSnapshot:
    | { requestsRemaining?: number; tokensRemaining?: number; resetsInSeconds?: number }
    | undefined;
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionResolution>;
  onAskUser?: SessionOptions["onAskUser"];
  isBusy(): boolean;
  enqueueFollowUp(opts: {
    text: string;
    images?: ImageAttachment[];
    files?: PromptFile[];
  }): void;
  cancelCacheWarm(): void;
  persistEvent(e: Event): Promise<void>;
  notify(e: Event): void;
  drainFollowUps(): Promise<void>;
  grantSandboxForMentionedRoots(dirs: string[]): Promise<void>;
  rebuildSystemPrompt(): Promise<void>;
  recallRelevantMemories(query: string): Promise<string | null>;
  historyFingerprint(): string;
  ensureContextUnderWindow(): Promise<void>;
  getRuntime(): AgentRuntime;
  refreshRuntimeClock(now?: string): void;
  expandWritablePath(dir: string, opts?: { persist?: boolean }): Promise<string>;
  addDeliveryRoot(dir: string): void;
  livePersistentShellHandle(): AgentDeps["persistentShell"];
  diagnosticsProviderChain(): AgentDeps["diagnosticsProvider"];
  onPermissionRequestWithBatch(req: PermissionRequest): Promise<PermissionResolution>;
  getPermissionClassifier(): PermissionClassifier;
  setAgentMode(mode: AgentMode): Promise<void>;
  maybeCompact(opts?: { force?: boolean; focus?: string }): Promise<void>;
  refreshTitle(firstUserText: string): Promise<void>;
  maybeCheckpoint(): Promise<void>;
  clearTurnOverrides(): void;
  precomputeCompaction(): Promise<void>;
  runMemoryPipeline(): Promise<void>;
  startPersistentShell(): PersistentShell | null;
  scheduleCacheWarm(candidate: {
    prefixTokens: number;
    replay: (signal: AbortSignal) => Promise<void>;
  }): void;
};/**
 * Start a user turn, or enqueue it if a turn is already running.
 * Returns `"queued"` when the text was added to the follow-up queue
 * instead of starting immediately.
 */
/**
 * Resume the last turn from the existing transcript instead of sending a
 * new message. Use after a turn ended in a recoverable error (provider
 * failure, tool failure, Stop-verify cap) so "retry" picks up where it
 * stopped — WITHOUT adding another user bubble. Re-enters the agent loop
 * driven purely by `host.events`; dangling `tool_use` calls are repaired by
 * the provider-message builder. Returns "noop" when there is nothing to
 * resume (no prior user turn, or the last turn did not end in an error).
 */
export async function sessionResumeLastTurn(host: PromptHost): Promise<"started" | "queued" | "noop"> {
  if (host.disposed) throw new Error("session disposed");
  if (host.isBusy()) return "queued";
  if (!sessionCanResumeLastTurn(host)) return "noop";
  const lastUserText = lastUserPromptText(host) ?? "";
  return sessionPrompt(host, lastUserText, undefined, undefined, { resume: true });
}

/**
 * True when the last turn ended in a recoverable error and there is a user
 * prompt to resume from. Clients use this to show a "retry from here" affordance
 * distinct from "send a new message".
 */
export function sessionCanResumeLastTurn(host: PromptHost): boolean {
  let sawUser = false;
  for (const e of host.events) if (e.type === "message" && e.role === "user") sawUser = true;
  if (!sawUser) return false;
  // Walk back past transient/bookkeeping events to the last meaningful one.
  for (let i = host.events.length - 1; i >= 0; i--) {
    const e = host.events[i]!;
    if (e.type === "status" || e.type === "usage" || e.type === "activity") continue;
    return e.type === "error";
  }
  return false;
}

/** Text of the most recent persisted user message, or null. */
function lastUserPromptText(host: PromptHost): string | null {
  for (let i = host.events.length - 1; i >= 0; i--) {
    const e = host.events[i]!;
    if (e.type === "message" && e.role === "user") {
      const text = e.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      return text || null;
    }
  }
  return null;
}

export async function sessionPrompt(host: PromptHost,
  text: string,
  images?: ImageAttachment[],
  files?: PromptFile[],
  opts?: { resume?: boolean },
): Promise<"started" | "queued"> {
  if (host.disposed) throw new Error("session disposed");
  if (host.isBusy()) {
    host.enqueueFollowUp({ text, images, files });
    return "queued";
  }
  const resume = opts?.resume === true;
  // A real turn supersedes any pending prompt-cache warm.
  host.cancelCacheWarm();
  // Reset per-turn recall; recomputed below for a fresh prompt, absent on resume.
  host.pendingRelevantMemories = null;
  host.cancelController = new AbortController();
  host.steerController = new AbortController();

  // Undo baseline: pre-images are captured lazily before each file write.
  host.turnPreImages = new Map();
  host.pendingWritePaths = new Map();
  host.turnBaseTree = null;
  host.turnTreePending = true;

 // Telemetry: wrap each prompt in a span (no-op when OTEL is not configured).
  const promptSpan: PromptSpan = startPromptSpan(host.id, text.length);

 // Run UserPromptSubmit hooks. A blocking hook stops the prompt; a
 // rewriting hook replaces the text (first hook wins).
  const promptHook = resume
    ? ({ action: "allow" as const, warnings: [] as string[] })
    : await host.hooks.runUserPromptSubmit(text).catch((): {
    action: "allow";
    rewrittenPrompt?: string;
    warnings: string[];
  } => ({ action: "allow", warnings: ["UserPromptSubmit hook threw; ignored"] }));
  if (promptHook.action === "block") {
    const ev: Event = {
      type: "error",
      message: `prompt blocked by UserPromptSubmit hook: ${promptHook.reason ?? "(no reason)"}`,
      recoverable: true,
    };
    host.events.push(ev);
    await host.persistEvent(ev);
    host.notify(ev);
    host.cancelController = null;
    endPromptSpan(promptSpan);
    void host.drainFollowUps();
    return "started";
  }
  // On resume there is no fresh user input: skip @mcp resolution,
  // delivery-root extraction, image mentions and uploads — they all act on
  // a NEW prompt. `effectivePrompt` stays the recovered last prompt (used
  // only as the compaction fallback), `attachedImages`/`savedUploads` empty.
  let effectivePrompt = resume ? text : (promptHook.rewrittenPrompt ?? text);
  let attachedImages: ImageAttachment[] = [];
  let savedUploads: Awaited<ReturnType<typeof materializeUploads>> = [];

  // Show the user's bubble the instant the prompt is accepted — BEFORE the
  // per-turn preprocessing (@mcp resolution, image mentions, uploads, and the
  // query-time memory recall, which calls the small model over the network).
  // Those steps run before the real user event is appended below, so without
  // this the bubble only appears once they finish, right as the model starts
  // replying. We NOTIFY a placeholder now (never persist it — the JSONL is
  // append-only with no by-id dedup, so persisting here then again below
  // would replay as two bubbles). The authoritative event is appended once,
  // after preprocessing, reusing this same id so the live UI upserts the one
  // bubble in place (web reducer matches by message id).
  const userEventId = `msg_${randomUUID()}`;
  if (!resume) {
    host.notify({
      type: "message",
      id: userEventId,
      role: "user",
      content: [{ type: "text", text }],
      ts: Date.now(),
      ...(images && images.length > 0 ? { images } : {}),
    });
  }

  if (!resume) {
 // Wait for background MCP (if still starting) so tools / @mcp refs work.
  await host.mcpReady.catch(() => null);
 // Resolve `@mcp:<server>/<uri>` references into inline resource content.
 // This lets users paste MCP resource URIs into their prompt to inject
 // server-side context (e.g. `@mcp:github/repos/foo/bar`).
  effectivePrompt = await resolveSessionMcpReferences(host.mcp, effectivePrompt);

 // Extend delivery roots from path-like tokens in the user prompt
 // (absolute, ~/…, drive, or relative with a slash). Generic — any task.
  const mentionedRoots = extractDeliveryRootsFromText(effectivePrompt, host.cwd);
  if (mentionedRoots.length > 0) {
    const merged = mergeDeliveryRoots(host.deliveryRoots, mentionedRoots);
    host.deliveryRoots.length = 0;
    host.deliveryRoots.push(...merged);
    // Delivery roots are not the OS jail. When the user EXPLICITLY names a
    // target directory, the sandbox must grant it up-front — otherwise the
    // write is silently blocked by the jail, or the model is forced to ask.
    // The sandbox itself requests the directory's permission here (host
    // prompt in ask-mode; auto-granted in auto-edit/yolo), so a user-named
    // path "just works" without the LLM negotiating for it.
    await host.grantSandboxForMentionedRoots(mentionedRoots).catch(() => undefined);
    await host.rebuildSystemPrompt().catch(() => undefined);
  }

  const mentioned = await resolveImageMentions(effectivePrompt, host.cwd);
  if (mentioned.failures.length > 0) {
    const ev: Event = {
      type: "error",
      message: `could not attach image: ${mentioned.failures.join("; ")}`,
      recoverable: true,
    };
    host.events.push(ev);
    await host.persistEvent(ev);
    host.notify(ev);
  }
  attachedImages = [...(images ?? []), ...mentioned.images];

 // Uploads are written to disk and listed on the message event. The
 // attachment note is injected only when building the provider prompt
 // (see agent-messages) so the user's bubble stays clean.
  if (files?.length) {
    try {
      savedUploads = await materializeUploads(host.cwd, files);
      if (!effectivePrompt.trim() && savedUploads.length > 0) {
        effectivePrompt = savedUploads.length === 1
          ? `Please look at the attached file (${savedUploads[0]!.name}).`
          : "Please look at the attached files.";
      }
    } catch (err) {
      const ev: Event = {
        type: "error",
        message: `could not save attached file: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: true,
      };
      host.events.push(ev);
      await host.persistEvent(ev);
      host.notify(ev);
      host.cancelController = null;
      endPromptSpan(promptSpan);
      void host.drainFollowUps();
      return "started";
    }
  }

  // Query-time progressive recall: pick the memory topic files most relevant
  // to this query and stash their truncated bodies for the volatile per-turn
  // context. Fail-soft and non-blocking — recall never holds up the turn.
  host.pendingRelevantMemories = await host.recallRelevantMemories(effectivePrompt).catch(
    () => null,
  );
  } // end preprocessing (skipped on resume)

  try {
 // Durable-execution claim: atomically append a `running` status carrying the
 // execution identity BEFORE the agent loop starts. If the process dies mid-run
 // this claim is the tail of the JSONL; the crash-recovery sweep finds it, seals
 // any orphaned tool call, and flips the session to a clean idle. The agent
 // loop's own per-step `running` heartbeats are claim-less; only this opening
 // marker carries the claim, and the trailing `idle` releases it.
    host.turnCounter += 1;
    const claimStatus: Event = {
      type: "status",
      status: "running",
      claim: {
        executionId: `exec_${randomUUID()}`,
        turn: host.turnCounter,
        model: host.turnOverrideModel ?? host.model,
        fingerprint: host.historyFingerprint(),
        startedAt: Date.now(),
      },
    };
    host.events.push(claimStatus);
    await host.persistEvent(claimStatus).catch(() => undefined);
    host.notify(claimStatus);
 // Lazily start the persistent shell (one per session). Its cwd/env
 // persist across foreground bash calls so `cd` / `export` carry over.
    if (!host.persistentShell) {
      host.persistentShell = host.startPersistentShell();
    }
 // Apply turn-scoped overrides.
 // The model override applies to THIS prompt only; allowed-tools rules
 // were already pushed onto the permission engine by setTurnOverrides
 // and are popped in the finally block below.
    const effectiveModel = host.turnOverrideModel ?? host.model;
    // Shrink an already-oversize resumed transcript before the first send.
    await host.ensureContextUnderWindow();
    // Resolve the agent runtime now (memoized). A plugin runtime installs
    // its tools / context transform during resolution, so this must happen
    // before we build `deps` that reads `host.pluginContextTransform`.
    const runtime = host.getRuntime();
    // Lazily ensure the system prompt exists. Resume defers the init-time
    // build (to return history faster), so build on first use if needed.
    // Also rebuild when a background consolidation updated the memory index,
    // so the model never reads a stale MEMORY.md after it was consolidated.
    if (!host.systemPromptCache || host.memoryIndexDirty) {
      host.memoryIndexDirty = false;
      await host.rebuildSystemPrompt().catch(() => undefined);
    }
    // Refresh wall clock at each user turn; pin it for the whole agent loop
    // (tool iterations reuse deps.systemPrompt and must not re-stamp now).
    host.refreshRuntimeClock();
    const deps: AgentDeps = {
      provider:
        host.providerOverride ??
        buildProvider({ ...host.config, model: effectiveModel }),
      tools: host.toolRegistry,
      artifacts: host.artifacts,
      permissions: host.permissions,
      config: { ...host.config, model: effectiveModel },
      cwd: host.cwd,
      sessionId: host.id,
      systemPrompt: host.systemPromptCache ?? undefined,
      promptCacheKey: host.id,
      signal: host.cancelController.signal,
      agentMode: host.mode,
      sandbox: host.sandbox,
      expandSandboxWritable: (dir, opts) =>
        host.expandWritablePath(dir, opts).then(() => undefined),
      deliveryRoots: host.deliveryRoots,
      scratchDir: scratchDir(host.cwd, host.id),
      projectStateDir: projectStatePath(host.cwd),
      addDeliveryRoot: (dir) => host.addDeliveryRoot(dir),
      hooks: host.hooks,
      // Live handle — expandWritablePath may close+replace the shell
      // mid-turn; do not capture the instance by value.
      persistentShell: host.livePersistentShellHandle(),
      diagnosticsProvider: host.diagnosticsProviderChain(),
      postWrite: host.postWrite,
      redactPatterns: host.redactPatterns,
      // Installed during runtime resolution above (a plugin runtime may set
      // it); undefined → agent.ts treats the transform as a no-op.
      contextTransform: host.pluginContextTransform,
      parentSpan: promptSpan,
      dedupCache: host.dedupCache,
      fileObservations: host.fileObservations,
      relevantMemories: host.pendingRelevantMemories ?? undefined,
      drainSteering: (opts) => {
        const scope = opts?.scope ?? "all";
        // Any drain that consumes user steers rotates the steer controller so
        // the next provider request starts with a fresh (un-aborted) signal.
        const rotate = (): void => {
          if (host.steerController?.signal.aborted) {
            host.steerController = new AbortController();
          }
        };
        if (scope === "all") {
          const q = host.steeringQueue;
          host.steeringQueue = [];
          rotate();
          return q;
        }
        // scope === "steer": take steer-delivery items + all system notices;
        // leave followup items queued for the next top-level turn.
        const take: SteeringItem[] = [];
        const keep: SteeringItem[] = [];
        for (const item of host.steeringQueue) {
          if (item.source === "system" || item.delivery === "steer") take.push(item);
          else keep.push(item);
        }
        host.steeringQueue = keep;
        rotate();
        return take;
      },
      peekSteering: () =>
        host.steeringQueue.some(
          (i) => i.source === "user" && i.delivery === "steer",
        ),
      getSteerSignal: () => host.steerController?.signal,
      onEvent: async (e) => {
        // `tool_started` is awaited right before execution, so the base tree
        // still reflects the pre-tool state.
        if (e.type === "tool_started" && host.turnTreePending && !NON_MUTATING_TOOLS.has(e.name)) {
          host.turnTreePending = false;
          const tracker = await openWorkspaceTracker(host as unknown as HistoryHost);
          host.turnBaseTree = tracker ? await tracker.capture() : null;
        }
        if (e.type === "tool_started") {
          for (const p of host.pendingWritePaths.get(e.toolCallId) ?? []) {
            const abs = pathResolve(host.cwd, p);
            if (host.turnPreImages.has(abs)) continue;
            host.turnPreImages.set(abs, await readFileOrNull(abs).catch(() => null));
          }
          host.pendingWritePaths.delete(e.toolCallId);
        }
        if (e.type === "retry" || e.type === "activity" || e.type === "edit_delta") {
 // Transient UI notice — never part of the transcript. `edit_delta`
 // is live edit progress; the tool_result holds the final outcome.
          host.notify(e);
          return;
        }
 // Stream deltas are for live UI only. Persisting every 1–2 char
 // fragment balloons ~/.codepilot/sessions/*.jsonl (90%+ of events
 // in real runs) and inflates token estimates; the final `message`
 // event already holds the complete text / tool_use blocks.
        if (e.type === "message_delta") {
          host.notify(e);
          return;
        }
        if (e.type === "subagent") {
          const inner = e.event?.type;
          // Persist usage so sub-agent token totals survive resume and can
          // be shown separately from the parent until rollup.
          const replayable = inner === undefined || inner === "message" || inner === "tool_call" ||
            inner === "tool_result" || inner === "plan" || inner === "error" || inner === "usage";
          if (!replayable) {
            host.notify(e);
            return;
          }
          e = slimSubagentEvent(e);
        }
        host.events.push(e);
        await host.persistEvent(e);
        host.notify(e);
        if (
          e.type === "usage" &&
          !e.rollup &&
          typeof e.usage?.input === "number" &&
          e.usage.input > 0
        ) {
          host.lastProviderInputTokens = e.usage.input;
          // Anchor the hybrid context estimate to this measurement: the
          // provider tokenised everything in the log up to now, so the event
          // count here is the boundary past which later events are estimated.
          host.contextAnchor = { input: e.usage.input, eventCount: host.events.length };
        }
 // plan_done approval: leave plan mode. Land in `agent` so the
 // approved plan can be executed — UNLESS the user entered plan mode
 // from `chat` (they wanted answers + a plan, not autonomous edits),
 // in which case restore `chat` and let them opt into agent mode.
        if (e.type === "mode_request") {
          // A suggest_mode acceptance may carry "remember" → auto-accept
          // future suggestions this session (the "Always switch" choice), and
          // persist the preference to the user config so it survives a restart.
          if (e.rememberAuto) {
            host.autoAcceptModeSuggestions = true;
            void persistAutoAcceptModeSuggestions().catch(() => undefined);
          }
          const target = e.mode === "agent" && host.prePlanMode === "chat"
            ? "chat"
            : e.mode;
          await host.setAgentMode(target);
        }
 // Track files touched by write/edit/apply_patch/notebook_edit for snapshot
 // rewind.
        if (e.type === "tool_call") {
          const t = e as { type: "tool_call"; id: string; name: string; input: unknown };
          if (
            t.name === "write_file" ||
            t.name === "edit_file" ||
            t.name === "apply_patch" ||
            t.name === "notebook_edit"
          ) {
            const inp = t.input as Record<string, unknown> | undefined;
            const paths: string[] = [];
            // notebook_edit names its target `notebook_path`; the others `path`.
            const path = t.name === "notebook_edit" ? inp?.notebook_path : inp?.path;
            if (typeof path === "string") paths.push(path);
 // apply_patch may touch multiple files — parse is expensive, so
 // we rely on the patch's own `*** Add/Delete/Update File:` / `*** Move to:` lines.
            if (t.name === "apply_patch" && typeof inp?.patch === "string") {
              for (const m of (inp.patch as string).matchAll(/\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)/g)) {
                paths.push(m[1]!.trim());
              }
            }
            for (const p of paths) host.touchedFiles.add(p);
            if (paths.length > 0) host.pendingWritePaths.set(t.id, paths);
          }
        }
      },
      // Wrapped so an always/always-project grant unlocks other in-flight
      // permission prompts the new rule now covers (pending-batch unlock).
      onPermissionRequest: host.onPermissionRequest
        ? (req) => host.onPermissionRequestWithBatch(req)
        : undefined,
      // Background classifier for `auto` permission mode. Built lazily and
      // reused; only consulted by agent-tools when the mode is `auto`.
      permissionClassifier: host.getPermissionClassifier(),
      onAskUser: host.onAskUser,
      onUsage: (u) => {
        host.usageTotal.input += u.input ?? 0;
        host.usageTotal.output += u.output ?? 0;
        host.usageTotal.cacheRead += u.cacheRead ?? 0;
        host.usageTotal.cacheWrite += u.cacheWrite ?? 0;
        // Record the turn for cache-waste attribution. A re-bill right after
        // a compaction/branch is expected (new content), so carry that flag.
        if ((u.input ?? 0) > 0) {
          host.cacheTurns.push({
            at: Date.now(),
            model: host.model,
            input: u.input ?? 0,
            cacheRead: u.cacheRead ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
            contextChanged: host.contextChangedForNextTurn,
          });
          host.contextChangedForNextTurn = false;
        }
      },
      onRateLimit: (info) => {
        host.rateLimitSnapshot = info;
      },
      // Mid-run compaction: agent already detected pressure (local estimate
      // OR last provider inputTokens). Force — do not re-gate on the local
      // estimator, which under-counts vs gateway usage and can let requests
      // climb past the configured contextWindow.
      compactNow: async () => {
        const before = host.events;
        await host.maybeCompact({ force: true });
        if (host.events === before) return null;
        return host.events.slice();
      },
      onWarmableRequest: (candidate) => host.scheduleCacheWarm(candidate),
      lastProviderInputTokens: host.lastProviderInputTokens,
    };

    // Stop-hook continue loop: when a Stop hook blocks ending the turn,
    // re-enter the agent with the reason as feedback (capped).
    const stopCap =
      typeof host.config.stopHookBlockCap === "number" && host.config.stopHookBlockCap >= 0
        ? host.config.stopHookBlockCap
        : DEFAULT_STOP_HOOK_BLOCK_CAP;
    let stopHookActive = false;
    let stopContinueCount = 0;
    let turnText = effectivePrompt;
    let turnImages = attachedImages;
    let turnFiles = savedUploads;

    // Append the authoritative user message now that preprocessing is done,
    // so the transcript the model sees carries the final content (@mcp
    // rewrite, mentioned images, upload note). On a fresh prompt (not resume)
    // this is appended/persisted/notified ONCE, reusing the id of the
    // placeholder bubble notified at the top of prompt(): persisting is
    // deferred to here (the JSONL has no by-id dedup, so this stays a single
    // line) and the final notify upserts the live bubble in place with the
    // final content. The agent loop is told it is already in history
    // (userAlreadyEmitted) so it does not emit a duplicate.
    const userEmittedEarly = !resume;
    if (userEmittedEarly) {
      const userEvent: Event = {
        type: "message",
        id: userEventId,
        role: "user",
        content: [{ type: "text", text: turnText }],
        ts: Date.now(),
        turnStart: true,
        ...(turnImages.length > 0 ? { images: turnImages } : {}),
        ...(turnFiles.length > 0 ? { files: turnFiles } : {}),
      };
      host.events.push(userEvent);
      await host.persistEvent(userEvent).catch(() => undefined);
      host.notify(userEvent);
    }

    let firstPass = true;
    for (;;) {
      // Continues after Stop/stopVerify inject feedback for the model only
      // (`systemContinue`) — never as a persisted user bubble.
      const isStopContinue = stopContinueCount > 0;
      // Resume applies only to the FIRST re-entry: it re-engages the model
      // on the existing transcript with no new user event. Later passes are
      // Stop-hook continues, which use `systemContinue` instead.
      const isResume = resume && firstPass && !isStopContinue;
      // The user event was already appended+surfaced above; only the first
      // pass of a fresh prompt must suppress the loop's own emit.
      const alreadyEmitted = userEmittedEarly && firstPass && !isStopContinue;
      firstPass = false;
      await runtime.prompt(
        {
          history: host.events,
          userText: isStopContinue ? "" : turnText,
          ...(isResume ? { resume: true } : {}),
          ...(alreadyEmitted ? { userAlreadyEmitted: true } : {}),
          ...(isStopContinue
            ? { systemContinue: turnText }
            : {
                images: turnImages.length > 0 ? turnImages : undefined,
                files: turnFiles.length > 0 ? turnFiles : undefined,
              }),
        },
        deps,
      );

      // The interrupt-recovery guidance (if any) has now reached the model.
      host.resumedFromInterrupt = false;

      if (host.title == null && stopContinueCount === 0) {
        await host.refreshTitle(effectivePrompt);
      }

      await host.maybeCompact();
      await host.rebuildSystemPrompt().catch(() => undefined);
      await host.maybeCheckpoint();

      // User cancel: do not let Stop hooks force a continue.
      if (host.cancelController?.signal.aborted) break;

      // stopVerify is strictly opt-in: it runs only when the user set a mode
      // ("prompt"/"tests"/true). No automatic "modified code → run tests"
      // upgrade. See `effectiveStopVerifyMode`.
      const stopMode = effectiveStopVerifyMode({
        configured: host.config.stopVerify,
      });
      // By default the built-in verdict is advisory (non-blocking notice). Only
      // the object form `{ mode, forceContinue: true }` re-runs the turn on a
      // negative verdict, and then with a lower default cap so a false negative
      // still can't spin to the full Stop-hook cap.
      const stopForceContinue = resolveStopVerifyForceContinue(host.config.stopVerify);
      const builtinStopCap =
        typeof host.config.stopHookBlockCap === "number" && host.config.stopHookBlockCap >= 0
          ? host.config.stopHookBlockCap
          : DEFAULT_STOP_VERIFY_FORCE_CAP;
      const hasUserStop = host.hooks.hasHooks("Stop");
      if (stopMode === "off" && !hasUserStop) break;

      const stopPayload = {
        reason: stopContinueCount === 0 ? "prompt_completed" : "stop_hook_continue",
        stop_hook_active: stopHookActive,
        stop_continue_count: stopContinueCount,
        stop_continue_cap: stopForceContinue ? builtinStopCap : stopCap,
        session_id: host.id,
        transcript_hint: buildStopTranscriptHint(host.events),
      };

      // Built-in validity gate first, then user-configured Stop hooks.
      let stopResult: import("../hooks/hooks.js").PreHookResult =
        stopMode === "off"
          ? { action: "allow", warnings: [] }
          : await runBuiltinStopVerify(
              stopMode,
              {
                cwd: host.cwd,
                ...stopPayload,
                resolvers: host.hooks.getResolvers(),
              },
              { forceContinue: stopForceContinue },
            ).catch((): import("../hooks/hooks.js").PreHookResult => ({
              action: "allow",
              warnings: ["built-in stopVerify threw; ignored"],
            }));

      if (stopResult.action !== "block" && hasUserStop) {
        stopResult = await host.hooks
          .runStop(stopPayload)
          .catch((): import("../hooks/hooks.js").PreHookResult => ({
            action: "allow",
            warnings: ["Stop hook threw; ignored"],
          }));
      }

      for (const w of stopResult.warnings) {
        // Soft skips / rate-limit noise from stopVerify stay off the transcript.
        if (/rate.?limit|\b429\b|skipped|no prompt resolver/i.test(w)) continue;
        // Advisory verdicts (forceContinue off) are notices, not failures:
        // the turn still ended; surface the concern for the user to act on.
        const isAdvice = w.startsWith(STOP_VERIFY_ADVICE_PREFIX);
        const message = isAdvice
          ? `${w} (advisory — the turn ended; set stopVerify.forceContinue to re-run instead)`
          : w;
        const ev: Event = { type: "error", message, recoverable: true };
        host.events.push(ev);
        await host.persistEvent(ev).catch(() => undefined);
        host.notify(ev);
      }

      if (stopResult.action !== "block") break;

      // Forced continues use the lower built-in cap; user Stop hooks use the
      // full configured cap.
      const effectiveCap = stopForceContinue ? builtinStopCap : stopCap;
      if (stopContinueCount >= effectiveCap) {
        const ev: Event = {
          type: "error",
          message:
            `Stop verify kept blocking after ${effectiveCap} continue(s); ending the turn ` +
            `(set stopHookBlockCap to raise the limit, or stopVerify: "off").`,
          recoverable: true,
        };
        host.events.push(ev);
        await host.persistEvent(ev).catch(() => undefined);
        host.notify(ev);
        break;
      }

      stopContinueCount += 1;
      stopHookActive = true;
      const reason =
        stopResult.reason?.trim() ||
        "Stop verify blocked ending this turn without a reason.";
      // UI-only progress event (not persisted).
      host.notify({
        type: "stop_continue",
        count: stopContinueCount,
        cap: effectiveCap,
        reason,
      });
      turnText =
        `<stop_hook_continue count="${stopContinueCount}" cap="${stopCap}">\n` +
        `${reason}\n` +
        `Address this feedback, then finish the task. Do not stop until the ` +
        `concern is resolved or you must ask the user a clarifying question.\n` +
        `</stop_hook_continue>`;
      turnImages = [];
      turnFiles = [];
    }
  } finally {
    // Record undo boundary when this turn mutated files (file tools, or any
    // workspace change the shadow-git tracker saw — bash/MCP included).
    let afterTree: string | null = null;
    let treeChanged = false;
    if (host.turnBaseTree && !host.cancelController?.signal.aborted) {
      try {
        afterTree = (await host.workspaceTracker?.capture()) ?? null;
        treeChanged = afterTree !== null && afterTree !== host.turnBaseTree;
      } catch {
        afterTree = null;
      }
    }
    if ((host.turnPreImages.size > 0 || treeChanged) && !host.cancelController?.signal.aborted) {
      try {
        const baselineId = await createSnapshotFromContents(host.cwd, host.turnPreImages, `pre-turn-${Date.now()}`);
        const afterId = await createSnapshot(host.cwd, [...host.turnPreImages.keys()], `post-turn-${Date.now()}`);
        const entry: UndoEntry = {
          baselineId,
          afterId,
          label: `turn ${host.undoStack.length + 1}`,
          ...(treeChanged && afterTree ? { baseTree: host.turnBaseTree!, afterTree } : {}),
        };
        host.undoStack.push(entry);
        host.redoStack = [];
        // Persist the boundary so `/undo` survives a reload. A control event:
        // not sent to the model, not shown in the transcript.
        await persistUndoBoundary(host as unknown as HistoryHost, "push", entry);
        if (entry.baseTree) {
          await host.workspaceTracker?.pin(
            host.undoStack.flatMap((u) => (u.baseTree && u.afterTree ? [u.baseTree, u.afterTree] : [])),
          );
        }
      } catch {
        /* ignore snapshot failures */
      }
    }
    host.turnPreImages = new Map();
    host.pendingWritePaths = new Map();
    host.turnBaseTree = null;
    host.turnTreePending = false;
    const turnAborted = host.cancelController?.signal.aborted === true;
    host.cancelController = null;
 // Clear turn-scoped overrides so the session model + permission
 // grants resume on the user's next message.
    host.clearTurnOverrides();
 // End the telemetry span (no-op when disabled).
    endPromptSpan(promptSpan);
 // Kick the next queued follow-up (if any) once we are no longer busy.
    void host.drainFollowUps();
 // Turn-boundary pre-compaction: if tokens are in the soft band (approaching
 // the hard trigger but not there yet), compact in the background now — while
 // the history is frozen and the user is reading — so the next turn reuses it
 // for free instead of blocking on the small model. Fire-and-forget; the
 // fingerprint guard discards it if the next prompt changes the transcript.
    if (!turnAborted) void host.precomputeCompaction();
 // Fold this session's durable learnings into project memory in the
 // background (fire-and-forget, fail-soft): extract notes from the
 // transcript, then run a project-wide consolidation when its dual gate
 // (time since last run + accumulated drafts) is satisfied.
    if (!turnAborted) void host.runMemoryPipeline();
  }
  return "started";
}