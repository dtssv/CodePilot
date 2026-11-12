// Opt-in ACP (Agent Client Protocol) stdio server adapter — a SECONDARY
// interface reachable only via `codepilot acp`. The native JSON-RPC in
// server.ts stays primary. ACP rides the same `Peer`/`StdioTransport` (no new
// deps), translating core `Session` events to ACP `session/update` and prompts
// to ACP reverse requests. Single-client: each ACP session maps to one core
// Session and one peer (no multi-holder broadcast).

import { Peer, StdioTransport, RpcError, ErrorCode, type RpcTransport } from "./rpc.js";
import type {
  Session,
  Event,
  PermissionRequest,
  PermissionResolution,
  QuestionRequest,
  QuestionAnswers,
  ImageAttachment,
} from "@codepilot/core";

/** ACP protocol version this adapter implements. */
export const ACP_PROTOCOL_VERSION = 1;

/** A minimal ACP content block (text / resource_link are the baseline). */
interface AcpContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

interface AcpInitializeParams {
  protocolVersion?: number;
  clientCapabilities?: Record<string, unknown>;
  clientInfo?: { name?: string; version?: string };
}

interface AcpNewSessionParams {
  cwd?: string;
  mcpServers?: unknown[];
}

interface AcpPromptParams {
  sessionId?: string;
  prompt?: AcpContentBlock[];
}

interface AcpCancelParams {
  sessionId?: string;
}

interface AcpLoadSessionParams {
  sessionId?: string;
  cwd?: string;
}

/** The core factory the adapter depends on — injectable so tests can supply a
 * fake Session without a real model/provider. Mirrors `createSession`. */
export type AcpSessionFactory = (opts: {
  cwd: string;
  sessionId?: string;
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionResolution>;
  onAskUser?: (req: QuestionRequest) => Promise<QuestionAnswers>;
}) => Promise<Session>;

export interface AcpServerOptions {
  /** Working directory used when a client omits `cwd` on session/new. */
  defaultCwd?: string;
  /** Factory for core sessions; defaults to `@codepilot/core`'s createSession. */
  createSession?: AcpSessionFactory;
  /** Transport to run over; defaults to a stdio transport. */
  transport?: RpcTransport;
}

export interface AcpServerHandle {
  peer: Peer;
  dispose(): Promise<void>;
}

/** One live ACP session: the core Session plus its event unsubscribe. */
interface AcpSession {
  session: Session;
  unsubscribe: () => void;
}

/** Flatten ACP prompt content blocks into the plain text + images the core
 * `session.prompt` accepts. Text/resource_link blocks fold into one string;
 * image blocks (base64) map to core ImageAttachments. */
function decodePrompt(
  blocks: AcpContentBlock[] | undefined,
): { text: string; images: ImageAttachment[] } {
  const parts: string[] = [];
  const images: ImageAttachment[] = [];
  for (const b of blocks ?? []) {
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "resource_link" && typeof b["uri"] === "string") {
      parts.push(String(b["uri"]));
    } else if (b.type === "image") {
      const data = b["data"];
      const mimeType = b["mimeType"];
      if (typeof data === "string" && typeof mimeType === "string") {
        images.push({ mediaType: mimeType, base64: data });
      }
    }
  }
  return { text: parts.join("\n"), images };
}

/** Translate a core `Event` to an ACP `session/update` payload, or null when the
 * event has no meaningful ACP counterpart (internal/telemetry events). */
function toSessionUpdate(e: Event): Record<string, unknown> | null {
  switch (e.type) {
    case "message_delta": {
      if (e.delta.type === "text") {
        return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.delta.text } };
      }
      if (e.delta.type === "reasoning") {
        return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.delta.text } };
      }
      return null;
    }
    case "message": {
      // A finalized assistant message: surface its text as a chunk so clients
      // that don't accumulate deltas still see the content. (User messages are
      // the client's own input echoed back; skip to avoid a loop.)
      if (e.role !== "assistant") return null;
      const text = e.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (!text) return null;
      return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
    }
    case "tool_call":
      return {
        sessionUpdate: "tool_call",
        toolCallId: e.id,
        title: e.name,
        rawInput: e.input,
        status: "in_progress",
      };
    case "tool_result":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: e.toolCallId,
        status: e.isError ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: e.content } }],
      };
    case "plan":
      return {
        sessionUpdate: "plan",
        entries: e.steps.map((s) => ({
          content: s.title,
          status: s.status === "in_progress" ? "in_progress" : s.status === "completed" ? "completed" : "pending",
          priority: "medium",
        })),
      };
    case "mode":
      return { sessionUpdate: "current_mode_update", currentModeId: e.mode };
    default:
      return null;
  }
}

/** Map a core permission request to an ACP `session/request_permission` reverse
 * request and translate the chosen option back to a core resolution. */
async function askPermissionViaAcp(
  peer: Peer,
  sessionId: string,
  req: PermissionRequest,
): Promise<PermissionResolution> {
  try {
    const res = await peer.request<unknown, { outcome?: { outcome?: string; optionId?: string } }>(
      "session/request_permission",
      {
        sessionId,
        toolCall: { toolCallId: req.requestId, title: req.toolName, rawInput: req.input },
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      },
    );
    const chosen = res?.outcome?.optionId;
    if (res?.outcome?.outcome === "cancelled") return { decision: "abort" };
    if (chosen === "allow_always") return "always";
    if (chosen === "allow_once") return "allow";
    return "deny";
  } catch {
    // Client could not answer (disconnected / unsupported) → fail closed.
    return "deny";
  }
}

/** Map a core ask-user request to an ACP reverse request. ACP has no first-class
 * multi-question form, so we send the structured request and accept a
 * `{ answers: Record<id, string|string[]> }` reply; unanswered → empty. */
async function askUserViaAcp(
  peer: Peer,
  sessionId: string,
  req: QuestionRequest,
): Promise<QuestionAnswers> {
  try {
    const res = await peer.request<unknown, { answers?: QuestionAnswers }>("session/ask_user", {
      sessionId,
      requestId: req.requestId,
      questions: req.questions,
    });
    return res?.answers ?? {};
  } catch {
    return {};
  }
}

/**
 * Register the ACP baseline agent methods on `peer`, backed by core sessions.
 * Returns a handle whose `dispose` tears down every live session. The native
 * protocol is untouched — this is a parallel, opt-in surface.
 */
export function registerAcpServer(peer: Peer, opts: AcpServerOptions = {}): AcpServerHandle {
  const sessions = new Map<string, AcpSession>();
  let nextSessionSeq = 0;
  const makeSession: AcpSessionFactory =
    opts.createSession ??
    (async (o) => {
      // Lazy import so the ACP module has no load-time dependency on core's
      // session factory (and tests can inject a fake instead).
      const core = await import("@codepilot/core");
      return core.createSession(o);
    });

  /** Subscribe to a core session, forwarding live events as ACP session/update
   * notifications. Mirrors the native server's replay-skip: the initial
   * synchronous replay of history is dropped (the client already has it from
   * the new/load result), only post-subscribe events flow. */
  function attach(sessionId: string, session: Session): () => void {
    let replaying = true;
    const unsub = session.subscribe((e: Event) => {
      if (replaying) return;
      const update = toSessionUpdate(e);
      if (update) void peer.notify("session/update", { sessionId, update }).catch(() => {});
    });
    replaying = false;
    return unsub;
  }

  peer.onRequest<AcpInitializeParams, unknown>("initialize", async () => ({
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
    },
    authMethods: [],
  }));

  peer.onRequest<AcpNewSessionParams, unknown>("session/new", async (params) => {
    const cwd = params?.cwd ?? opts.defaultCwd ?? process.cwd();
    const session = await makeSession({
      cwd,
      onPermissionRequest: (req) => askPermissionViaAcp(peer, session.id, req),
      onAskUser: (req) => askUserViaAcp(peer, session.id, req),
    });
    const unsubscribe = attach(session.id, session);
    sessions.set(session.id, { session, unsubscribe });
    nextSessionSeq++;
    return { sessionId: session.id };
  });

  peer.onRequest<AcpLoadSessionParams, unknown>("session/load", async (params) => {
    const sessionId = params?.sessionId;
    if (!sessionId) throw new RpcError(ErrorCode.InvalidParams, "session/load requires sessionId");
    if (sessions.has(sessionId)) return {}; // already live
    const cwd = params?.cwd ?? opts.defaultCwd ?? process.cwd();
    const session = await makeSession({
      cwd,
      sessionId,
      onPermissionRequest: (req) => askPermissionViaAcp(peer, session.id, req),
      onAskUser: (req) => askUserViaAcp(peer, session.id, req),
    });
    // Replay the loaded transcript to the client as ACP updates (ACP load
    // semantics: the agent replays history as session/update notifications).
    for (const e of session.getHistory()) {
      const update = toSessionUpdate(e);
      if (update) void peer.notify("session/update", { sessionId: session.id, update }).catch(() => {});
    }
    const unsubscribe = attach(session.id, session);
    sessions.set(session.id, { session, unsubscribe });
    return {};
  });

  peer.onRequest<AcpPromptParams, unknown>("session/prompt", async (params) => {
    const sessionId = params?.sessionId;
    const live = sessionId ? sessions.get(sessionId) : undefined;
    if (!live) throw new RpcError(ErrorCode.InvalidParams, `unknown sessionId: ${sessionId ?? ""}`);
    const { text, images } = decodePrompt(params?.prompt);
    // Await the turn to completion so the ACP response carries a stopReason, as
    // the protocol expects: resolve when the session returns to idle.
    const stopReason = await runPromptToIdle(live.session, text, images);
    return { stopReason };
  });

  peer.onNotification<AcpCancelParams>("session/cancel", async (params) => {
    const live = params?.sessionId ? sessions.get(params.sessionId) : undefined;
    live?.session.cancel();
  });

  return {
    peer,
    async dispose() {
      for (const { session, unsubscribe } of sessions.values()) {
        try {
          unsubscribe();
        } catch {
          /* ignore */
        }
        await session.dispose().catch(() => undefined);
      }
      sessions.clear();
    },
  };
}

/**
 * Drive one prompt turn and resolve when the session goes idle, returning the
 * ACP stop reason. The core session streams via subscribe; we watch the status
 * stream for the terminal idle after a running/compacting phase.
 */
function runPromptToIdle(
  session: Session,
  text: string,
  images: ImageAttachment[],
): Promise<string> {
  return new Promise<string>((resolve) => {
    let sawRunning = false;
    let settled = false;
    const finish = (reason: string): void => {
      if (settled) return;
      settled = true;
      unsub();
      resolve(reason);
    };
    const unsub = session.subscribe((e: Event) => {
      if (e.type === "status") {
        if (e.status === "running" || e.status === "compacting") sawRunning = true;
        else if (e.status === "idle" && sawRunning) finish("end_turn");
      } else if (e.type === "error") {
        finish("refusal");
      }
    });
    void session
      .prompt(text, images.length ? images : undefined)
      .then((r) => {
        // Queued behind a busy turn: nothing to await here — the status stream
        // still resolves when the session next idles. A no-op start with no
        // running phase (e.g. empty prompt) resolves on the next idle.
        if (r === "queued" && !sawRunning) {
          // leave it to the status stream
        }
      })
      .catch(() => finish("refusal"));
  });
}

/**
 * Convenience: build an ACP server over process stdin/stdout and run until the
 * stream closes. Mirrors `startServer` for the native protocol.
 */
export async function startAcpServer(opts: AcpServerOptions = {}): Promise<AcpServerHandle> {
  const transport = opts.transport ?? new StdioTransport();
  const peer = new Peer({ transport, debug: false });
  const handle = registerAcpServer(peer, { ...opts, transport: undefined });
  void handle.peer.loopDone.catch(() => {});
  return { peer, dispose: handle.dispose };
}
