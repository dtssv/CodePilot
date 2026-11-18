import { ErrorCode, RpcError } from "../../rpc.js";
import { assertInitialized, type ServerContext } from "../context.js";
import type {
  EventParams,
  PromptCancelParams,
  PromptFollowupRemoveParams,
  PromptFollowupSendNowParams,
  PromptFollowupUpdateParams,
  PromptResumeParams,
  PromptResumeResult,
  PromptSendParams,
  PromptSendResult,
} from "../wireTypes.js";

export async function handlePromptSend(
  ctx: ServerContext,
  params: PromptSendParams,
): Promise<PromptSendResult> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  const delivery = params.delivery ?? "auto";
  const busy = typeof session.isBusy === "function" && session.isBusy();

  if (delivery === "steer") {
    // Steer never cancels. When idle, start a normal turn so "Inject" still
    // delivers the text instead of silently falling through to a second path.
    if (busy) {
      session.steer(params.text);
      return { delivery: "steered" };
    }
    void session.prompt(params.text, params.images, params.files).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      void ctx.peer
        .notify<EventParams>("event", {
          sessionId: session.id,
          event: { type: "error", message, recoverable: false },
        })
        .catch(() => {});
    });
    return { delivery: "started" };
  }

  if ((delivery === "queue" || delivery === "auto") && busy) {
    session.enqueueFollowUp({
      text: params.text,
      images: params.images,
      files: params.files,
    });
    return { delivery: "queued" };
  }

  // Fire-and-forget: events stream back as `event` notifications.
  void session.prompt(params.text, params.images, params.files).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    void ctx.peer
      .notify<EventParams>("event", {
        sessionId: session.id,
        event: { type: "error", message, recoverable: false },
      })
      .catch(() => {});
  });
  return { delivery: "started" };
}

export async function handlePromptResume(
  ctx: ServerContext,
  params: PromptResumeParams,
): Promise<PromptResumeResult> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  // Nothing to resume (no prior user turn, or the last turn ended cleanly):
  // report `noop` so the client can fall back to a normal send.
  if (!session.canResumeLastTurn()) {
    return { delivery: "noop" };
  }
  // Fire-and-forget: the resumed turn's events stream back as `event`
  // notifications, exactly like a normal prompt.
  void session.resumeLastTurn().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    void ctx.peer
      .notify<EventParams>("event", {
        sessionId: session.id,
        event: { type: "error", message, recoverable: false },
      })
      .catch(() => {});
  });
  return { delivery: "started" };
}

export async function handlePromptFollowupRemove(
  ctx: ServerContext,
  params: PromptFollowupRemoveParams,
): Promise<Record<string, never>> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  session.removeFollowUp(params.id);
  return {};
}

export async function handlePromptFollowupUpdate(
  ctx: ServerContext,
  params: PromptFollowupUpdateParams,
): Promise<Record<string, never>> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  if (typeof session.updateFollowUp === "function") {
    session.updateFollowUp(params.id, params.text);
  }
  return {};
}

export async function handlePromptFollowupSendNow(
  ctx: ServerContext,
  params: PromptFollowupSendNowParams,
): Promise<{ delivery: "steered" | "started" | "missing" }> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  if (typeof session.sendFollowUpNow !== "function") {
    return { delivery: "missing" };
  }
  const result = session.sendFollowUpNow(params.id);
  if (result === false) return { delivery: "missing" };
  return { delivery: result };
}

export async function handlePromptCancel(
  ctx: ServerContext,
  params: PromptCancelParams,
): Promise<Record<string, never>> {
  assertInitialized(ctx);
  const session = ctx.sessions.get(params.sessionId);
  if (!session) {
    throw new RpcError(
      ErrorCode.SessionNotFound,
      `session not found: ${params.sessionId}`,
    );
  }
  session.cancel();
  return {};
}