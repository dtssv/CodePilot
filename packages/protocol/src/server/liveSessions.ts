import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest as CorePermissionRequest,
  PermissionResolution,
  QuestionAnswers,
  QuestionRequest as CoreQuestionRequest,
  Session,
} from "@codepilot/core";
import { driveGoalRounds } from "@codepilot/core";
import type { ServerContext } from "./context.js";
import type {
  EventParams,
  PermissionRequestParams,
  PromptResolvedParams,
  QuestionRequestParams,
  UsageParams,
} from "./wireTypes.js";

/** A reverse request shown on every client following the session; the first
 * answer wins and the others are told to dismiss it. */
export type PendingPrompt =
  | {
      kind: "permission";
      params: PermissionRequestParams;
      settle: (d: PermissionResolution) => void;
      declined: Set<ServerContext>;
    }
  | {
      kind: "question";
      params: QuestionRequestParams;
      settle: (a: QuestionAnswers) => void;
      declined: Set<ServerContext>;
    };

/**
 * Process-wide registry of LIVE sessions, shared across connections with a
 * refcount. A busy run survives the last UI closing; idle sessions are
 * disposed when the last holder leaves (or `shutdown` force-disposes).
 */
export interface LiveSession {
  session: Session;
  /** Connections currently holding this session (refcount = size). May be empty
   * while a background run continues after the last client disconnected. */
  holders: Set<ServerContext>;
  /** Permission / question requests awaiting an answer from ANY holder. */
  prompts: Map<string, PendingPrompt>;
}

export const liveSessions = new Map<string, LiveSession>();

function isBusySession(session: Session): boolean {
  try {
    return typeof session.isBusy === "function" && session.isBusy();
  } catch {
    return false;
  }
}

/** Record that `ctx` now holds `session` (idempotent per connection). */
export function retainSession(ctx: ServerContext, session: Session): void {
  ctx.sessions.set(session.id, session);
  const live = liveSessions.get(session.id);
  if (live) live.holders.add(ctx);
  else liveSessions.set(session.id, { session, holders: new Set([ctx]), prompts: new Map() });
}

/** Release `sessionId` for this connection. When no holders remain: keep a busy
 * session alive for reconnect (unless `force`), otherwise fail-closed pending
 * prompts and dispose. */
export async function releaseSession(
  ctx: ServerContext,
  sessionId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!ctx.sessions.delete(sessionId)) return; // this connection didn't hold it
  const unsub = ctx.sessionSubs.get(sessionId);
  if (unsub) { try { unsub(); } catch { /* ignore */ } ctx.sessionSubs.delete(sessionId); }
  ctx.pendingGoals.delete(sessionId);
  ctx.activeGoalLoops.delete(sessionId);
  const live = liveSessions.get(sessionId);
  if (!live) return;
  live.holders.delete(ctx);
  if (live.holders.size === 0) {
 // Browser refresh / tab close: detach UI but let an in-flight prompt keep
 // running. Pending permission/question prompts stay queued for replay on
 // the next resume. Explicit shutdown passes force to tear everything down.
    if (!opts.force && isBusySession(live.session)) {
      return;
    }
    for (const p of Array.from(live.prompts.values())) failClosed(live, p, ctx.defaultPermissionMode);
    liveSessions.delete(sessionId);
    try { await live.session.dispose(); } catch { /* ignore */ }
  } else {
 // Another client may still answer; only give up if every remaining
 // holder has already declined.
    for (const p of Array.from(live.prompts.values())) {
      if ([...live.holders].every((h) => p.declined.has(h))) failClosed(live, p, ctx.defaultPermissionMode);
    }
  }
}

function failClosed(live: LiveSession, p: PendingPrompt, mode: PermissionMode): void {
  if (p.kind === "permission") settlePrompt(live, p.params.requestId, defaultDecision(mode), null);
  else settlePrompt(live, p.params.requestId, {}, null);
}

/** Resolve a pending prompt once and tell every other holder to dismiss it. */
export function settlePrompt(
  live: LiveSession,
  requestId: string,
  value: PermissionResolution | QuestionAnswers,
  from: ServerContext | null,
): boolean {
  const p = live.prompts.get(requestId);
  if (!p) return false;
  live.prompts.delete(requestId);
  if (p.kind === "permission") p.settle(value as PermissionResolution);
  else p.settle(value as QuestionAnswers);
  const method = p.kind === "permission" ? "permission/resolved" : "question/resolved";
  for (const h of live.holders) {
    if (h === from) continue;
    void h.peer
      .notify<PromptResolvedParams>(method, { sessionId: live.session.id, requestId })
      .catch(() => {});
  }
  return true;
}

/** Send a pending prompt to one holder. Clients answer either inline (the
 * reverse request's result carries `decision` / `answers`, as the CLI
 * does) or later via `permission/respond` / `question/respond` (web). */
function sendPrompt(live: LiveSession, p: PendingPrompt, holder: ServerContext): void {
  const method = p.kind === "permission" ? "permission/request" : "question/request";
  void holder.peer
    .request<typeof p.params, { decision?: PermissionDecision; feedback?: string; answers?: QuestionAnswers } | undefined>(method, p.params)
    .then((res) => {
      if (p.kind === "permission" && res?.decision) {
        settlePrompt(live, p.params.requestId, toResolution(res.decision, res.feedback), holder);
      } else if (p.kind === "question" && res?.answers) {
        settlePrompt(live, p.params.requestId, res.answers, holder);
      }
    })
    .catch(() => {
      p.declined.add(holder);
      if (live.prompts.has(p.params.requestId) && [...live.holders].every((h) => p.declined.has(h))) {
        failClosed(live, p, holder.defaultPermissionMode);
      }
    });
}

/** Replay still-pending prompts to a connection that just attached. */
export function replayPrompts(ctx: ServerContext, sessionId: string): void {
  const live = liveSessions.get(sessionId);
  if (!live) return;
  for (const p of live.prompts.values()) sendPrompt(live, p, ctx);
}

/**
 * Record a model-requested goal loop (from `start_goal`) as pending. Not
 * started here — waits for the triggering turn to settle, then
 * `maybeStartGoalLoop` takes over.
 */
export function recordPendingGoal(
  ctx: ServerContext,
  sessionId: string,
  req: { objective: string; maxRounds?: number },
): boolean {
  ctx.pendingGoals.set(sessionId, {
    objective: req.objective,
    ...(req.maxRounds ? { maxRounds: req.maxRounds } : {}),
  });
  return true;
}

/**
 * On a turn settling idle: if this session has a pending goal and no loop is
 * driving, consume it and start `driveGoalRounds`. `activeGoalLoops` guards
 * against re-entry (one loop at a time).
 */
function maybeStartGoalLoop(ctx: ServerContext, session: Session): void {
  const sessionId = session.id;
  if (ctx.activeGoalLoops.has(sessionId)) return;
  const pending = ctx.pendingGoals.get(sessionId);
  if (!pending) return;
  ctx.pendingGoals.delete(sessionId);
  ctx.activeGoalLoops.add(sessionId);
  void driveGoalRounds(session, {
    objective: pending.objective,
    maxRounds: pending.maxRounds,
    // Surface per-round progress to UIs via the session's event stream (which
    // `attachSessionEvents` already relays to this connection as `event`
    // notifications). The checkpoint file remains the authoritative record.
    onCheckpoint: (info) =>
      session.emitGoalProgress({
        round: info.round,
        status: info.status,
        maxRounds: pending.maxRounds,
        reason: info.reason,
        blockedReason: info.blockedReason,
      }),
  })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      void ctx.peer
        .notify<EventParams>("event", {
          sessionId,
          event: { type: "error", message, recoverable: false },
        })
        .catch(() => {});
    })
    .finally(() => {
      ctx.activeGoalLoops.delete(sessionId);
    });
}

function attachSessionEvents(ctx: ServerContext, session: Session): { unsubscribe: () => void } {
 // Subscribe THIS connection to the session's event stream. Keyed per-ctx
 // (not globally) so multiple clients can follow the same live session and a
 // reconnect re-subscribes without clobbering another connection's stream.
  const prev = ctx.sessionSubs.get(session.id);
  if (prev) return { unsubscribe: prev };
 // `subscribe` replays the history synchronously before returning. Clients
 // get that history in the `session/new` / `session/resume` result, so only
 // stream what happens from now on — replaying it here as well delivered
 // every earlier event twice.
  let replaying = true;
  const unsubscribe = session.subscribe((e) => {
    if (replaying) return;
 // Fire-and-forget; the peer logs failures itself.
    void ctx.peer
      .notify<EventParams>("event", { sessionId: session.id, event: e })
      .catch(() => {});
    if (e.type === "usage") {
      void ctx.peer
        .notify<UsageParams>("session/usage", {
          sessionId: session.id,
          usage: e.usage,
        })
        .catch(() => {});
    }
  // When a turn settles (idle) and the model requested a goal loop this
  // session (via `start_goal`), take over driving rounds now. We wait for the
  // triggering turn to finish because `session.prompt()` enqueues rather than
  // reenters while busy; driving here lets the loop's own prompts run cleanly.
    if (e.type === "status" && e.status === "idle") {
      maybeStartGoalLoop(ctx, session);
    }
  });
  replaying = false;
  ctx.sessionSubs.set(session.id, unsubscribe);
  return { unsubscribe };
}

export function registerSession(
  ctx: ServerContext,
  session: Session,
): { sessionId: string } {
  retainSession(ctx, session);
  attachSessionEvents(ctx, session);
  return { sessionId: session.id };
}

/** Wire request ids are `<sessionId>#<coreId>`. */
export function liveForRequest(requestId: string): LiveSession | undefined {
  const hash = requestId.indexOf("#");
  return hash > 0 ? liveSessions.get(requestId.slice(0, hash)) : undefined;
}

/** The shared live entry for `session`, or a private one for a session that
 * is not (or no longer) registered — then only `ctx` is asked. */
export function liveFor(ctx: ServerContext, session: Session): LiveSession {
  return liveSessions.get(session.id) ?? { session, holders: new Set([ctx]), prompts: new Map() };
}

/** Build a core `PermissionResolution` from a wire decision + optional
 * feedback. Feedback only matters on a deny; allow/always pass through as the
 * bare decision string. */
export function toResolution(
  decision: PermissionDecision | "abort",
  feedback?: string,
): PermissionResolution {
  if (decision === "abort") return { decision: "abort" };
  if (decision === "deny" && feedback && feedback.trim().length > 0) {
    return { decision: "deny", feedback };
  }
  return decision;
}

export function defaultDecision(mode: PermissionMode): PermissionDecision {
  switch (mode) {
    case "yolo":
    case "auto-edit":
      return "allow";
    // `auto` / `dont-ask` resolve soft asks inside the agent (classifier /
    // immediate deny); if a request still reaches here with no handler, fail
    // closed like `ask`.
    case "auto":
    case "dont-ask":
    case "ask":
    default:
      return "deny";
  }
}

/**
 * Issue a server-initiated `permission/request` and resolve with the client's
 * `permission/respond` decision. The wire requestId is `<sessionId>#<coreId>`
 * for global uniqueness; the client echoes it back unchanged.
 */
export async function requestPermissionFromClient(
  ctx: ServerContext,
  session: Session,
  req: CorePermissionRequest,
): Promise<PermissionResolution> {
  const live = liveFor(ctx, session);
  const params: PermissionRequestParams = {
    sessionId: session.id,
    requestId: `${session.id}#${req.requestId}`,
    toolName: req.toolName,
    input: req.input,
    reason: req.reason,
    ...(req.sandboxExpand ? { sandboxExpand: req.sandboxExpand } : {}),
  };
  return new Promise<PermissionResolution>((settle) => {
    const p: PendingPrompt = { kind: "permission", params, settle, declined: new Set() };
    live.prompts.set(params.requestId, p);
    for (const h of live.holders) sendPrompt(live, p, h);
  });
}

/**
 * Issue a server-initiated `question/request` and resolve with the client's
 * `question/respond` answers. Same `<sessionId>#<id>` wire-id as permission.
 * Transport failure resolves with empty answers (fail-closed).
 */
export async function requestQuestionFromClient(
  ctx: ServerContext,
  session: Session,
  req: CoreQuestionRequest,
): Promise<QuestionAnswers> {
  const live = liveFor(ctx, session);
  const params: QuestionRequestParams = {
    sessionId: session.id,
    requestId: `${session.id}#${req.requestId}`,
    questions: req.questions,
  };
  return new Promise<QuestionAnswers>((settle) => {
    const p: PendingPrompt = { kind: "question", params, settle, declined: new Set() };
    live.prompts.set(params.requestId, p);
    for (const h of live.holders) sendPrompt(live, p, h);
  });
}