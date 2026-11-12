// Codex app-server protocol backend for harness_bridge.
// Drives the Codex app-server (JSON-RPC over stdio) to run one turn and return
// the agent's final message, instead of scraping `codex exec` stdout.
// Lifecycle: initialize → initialized → newConversation → sendUserTurn →
// read notifications until turn completes → collect final agent text.
// Server-initiated approval requests are answered conservatively (decline).
// OPT-IN via config `harnessBridge.allowProtocol`; CLI backend is the fallback.

import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

export interface CodexProtocolOptions {
  /** Launch argv for the app-server. Default `["codex", "app-server"]`. */
  command?: string[];
  cwd: string;
  /** Child process environment (callers scrub secrets before passing). */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock budget for the whole turn. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CodexProtocolResult {
  /** The agent's final message text (concatenated deltas / final item). */
  finalText: string;
  /** Safe, non-model-facing diagnostics (never the child's raw stderr). */
  diagnostics: string[];
  timedOut: boolean;
  /** True when the turn finished cleanly; false on error/timeout. */
  ok: boolean;
}

/** Minimal JSON-RPC-ish message shape on the wire. */
interface WireMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Drive one turn through the Codex app-server and return the final agent text.
 * Pure transport: the caller owns policy (opt-in gate, sandbox, secret scrub).
 */
export async function runCodexAppServerTurn(
  prompt: string,
  opts: CodexProtocolOptions,
): Promise<CodexProtocolResult> {
  const argv = opts.command && opts.command.length > 0 ? opts.command : ["codex", "app-server"];
  const [bin, ...args] = argv;
  const diagnostics: string[] = [];

  let child: ChildProcess;
  try {
    child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return {
      finalText: "",
      diagnostics: [`failed to launch app-server: ${(err as Error).message}`],
      timedOut: false,
      ok: false,
    };
  }

  return await new Promise<CodexProtocolResult>((resolve) => {
    let settled = false;
    let nextId = 1;
    let timedOut = false;
    // Streaming deltas, and a fallback full text from a completed message item.
    const deltas: string[] = [];
    let completedText = "";
    let sawFinalItem = false;

    const send = (msg: WireMessage): void => {
      try {
        child.stdin?.write(JSON.stringify(msg) + "\n");
      } catch {
        /* child may have exited; the close/error path settles */
      }
    };
    const request = (method: string, params: unknown): number => {
      const id = nextId++;
      send({ id, method, params });
      return id;
    };
    const notify = (method: string, params?: unknown): void => {
      send({ method, params });
    };

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // Prefer streamed deltas; fall back to a completed message's full text.
      const finalText = (deltas.length > 0 ? deltas.join("") : completedText).trim();
      resolve({
        finalText,
        diagnostics,
        timedOut,
        ok: ok && !timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      diagnostics.push(`app-server turn timed out after ${opts.timeoutMs}ms`);
      finish(false);
    }, opts.timeoutMs);
    timer.unref?.();

    const onAbort = (): void => {
      diagnostics.push("app-server turn aborted");
      finish(false);
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    let initializeId = -1;
    let newConversationId = -1;

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      let msg: WireMessage;
      try {
        msg = JSON.parse(text) as WireMessage;
      } catch {
        return; // non-JSON line (e.g. a stray log) — ignore
      }

      // Server → client request (approval / permission): answer conservatively
      // so the turn proceeds unattended without granting broad privileges.
      if (msg.id !== undefined && typeof msg.method === "string") {
        answerServerRequest(msg, send);
        return;
      }

      // Response to one of our requests.
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        if (msg.error) {
          diagnostics.push(`app-server error on request ${String(msg.id)}: ${msg.error.message ?? "unknown"}`);
          // A hard error on initialize/newConversation is fatal.
          if (msg.id === initializeId || msg.id === newConversationId) {
            finish(false);
          }
          return;
        }
        if (msg.id === initializeId) {
          // Handshake done → announce initialized, then open a conversation.
          notify("initialized");
          newConversationId = request("newConversation", { cwd: opts.cwd });
          return;
        }
        if (msg.id === newConversationId) {
          const conversationId = extractConversationId(msg.result);
          if (!conversationId) {
            diagnostics.push("app-server did not return a conversationId");
            finish(false);
            return;
          }
          // Start the turn. sendUserTurn carries the prompt as a single text item.
          request("sendUserTurn", {
            conversationId,
            items: [{ type: "text", text: prompt }],
          });
          return;
        }
        return;
      }

      // Server → client notification: stream turn progress.
      if (typeof msg.method === "string") {
        handleNotification(msg.method, msg.params, {
          pushDelta: (t) => deltas.push(t),
          setCompletedText: (t) => {
            sawFinalItem = true;
            completedText = t;
          },
          complete: () => finish(true),
        });
      }
    });

    child.stderr?.on("data", () => {
      // Child stderr is diagnostics/log output and is deliberately NOT surfaced
      // to the model; we keep only a generic note if the turn fails.
    });
    child.on("error", (err) => {
      diagnostics.push(`app-server process error: ${err.message}`);
      finish(false);
    });
    child.on("close", () => {
      // If the process closed after we collected a final item, treat as success;
      // otherwise it closed early.
      if (!settled) {
        if (sawFinalItem || deltas.length > 0) finish(true);
        else {
          diagnostics.push("app-server exited before producing a final answer");
          finish(false);
        }
      }
    });

    // Kick off the handshake.
    initializeId = request("initialize", {
      clientInfo: { name: "codepilot", version: "1" },
      capabilities: {},
    });
  });
}

/** Pull the conversation/thread id out of a newConversation result, tolerating
 * the `conversationId` / `threadId` / `thread.id` shapes across versions. */
function extractConversationId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.conversationId === "string") return r.conversationId;
  if (typeof r.threadId === "string") return r.threadId;
  const thread = r.thread as Record<string, unknown> | undefined;
  if (thread && typeof thread.id === "string") return thread.id;
  return null;
}

/** Answer a server-initiated approval/permission request conservatively. We
 * decline execution/patch approvals (an unattended bridge turn must not grant
 * broad side effects) but still respond so the server is never left hanging. */
function answerServerRequest(msg: WireMessage, send: (m: WireMessage) => void): void {
  const method = msg.method ?? "";
  let result: unknown = { decision: "decline" };
  // Some surfaces expect a specific field name; keep both shapes harmless.
  if (/approval|permission|exec|patch/i.test(method)) {
    result = { decision: "decline" };
  } else {
    result = {};
  }
  send({ id: msg.id, result });
}

/** Translate a turn notification into the three things the driver cares about:
 * streaming agent-message deltas, a completed message's full text (fallback),
 * and turn completion. Method names are matched loosely so minor version drift
 * doesn't silently drop the answer. */
function handleNotification(
  method: string,
  params: unknown,
  sink: {
    pushDelta: (t: string) => void;
    setCompletedText: (t: string) => void;
    complete: () => void;
  },
): void {
  const p = (params ?? {}) as Record<string, unknown>;

  // Streaming assistant text delta.
  if (/agentmessage\/delta$/i.test(method)) {
    const delta = typeof p.delta === "string" ? p.delta : typeof p.text === "string" ? p.text : "";
    if (delta) sink.pushDelta(delta);
    return;
  }

  // A completed item that is an assistant message carries the full text; keep
  // it as the fallback for when no deltas were streamed.
  if (/item\/completed$/i.test(method)) {
    const item = (p.item ?? p) as Record<string, unknown>;
    const itemType = typeof item.type === "string" ? item.type : "";
    if (/agentmessage|assistant|message/i.test(itemType)) {
      const nested = item.message as Record<string, unknown> | undefined;
      const text =
        typeof item.text === "string"
          ? item.text
          : typeof nested?.text === "string"
            ? (nested.text as string)
            : "";
      if (text) sink.setCompletedText(text);
    }
    return;
  }

  // Turn finished → resolve.
  if (/turn\/(completed|failed|aborted)$/i.test(method)) {
    sink.complete();
    return;
  }
}
