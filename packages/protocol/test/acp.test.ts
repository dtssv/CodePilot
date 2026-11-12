// ACP (Agent Client Protocol) stdio adapter.
//
// The adapter speaks baseline ACP over a Peer and maps onto a core Session via
// an injected factory. These tests drive it with a fake ACP client over an
// in-memory transport pair and a fake Session that scripts core events, so no
// real model/provider is needed. We assert: initialize capabilities, session/new
// returns an id, session/prompt streams agent_message_chunk / tool_call updates
// and resolves with a stop reason at idle, a permission request becomes an ACP
// session/request_permission reverse call, session/cancel cancels, and
// session/load replays history.

import { afterEach, describe, expect, it } from "vitest";
import { Peer, type RpcTransport } from "../src/rpc.js";
import { registerAcpServer, ACP_PROTOCOL_VERSION } from "../src/acp.js";

type Listener = (e: unknown) => void;

/** A fake core Session scripting a canned turn: one tool call + a text chunk,
 * optionally a permission request, then idle. */
class FakeSession {
  id: string;
  cwd: string;
  listeners = new Set<Listener>();
  history: unknown[];
  cancelled = false;
  permissionHandler?: (req: unknown) => Promise<unknown>;
  disposed = 0;
  script: "text" | "tool" | "permission" | "error";

  constructor(opts: {
    cwd: string;
    id?: string;
    history?: unknown[];
    permissionHandler?: (req: unknown) => Promise<unknown>;
    script?: "text" | "tool" | "permission" | "error";
  }) {
    this.id = opts.id ?? `acp_${Math.random().toString(36).slice(2, 8)}`;
    this.cwd = opts.cwd;
    this.history = opts.history ?? [];
    this.permissionHandler = opts.permissionHandler;
    this.script = opts.script ?? "tool";
  }

  subscribe(listener: Listener): () => void {
    // Replay history synchronously (the adapter drops this during its own
    // attach via a replaying flag).
    for (const e of this.history) listener(e);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getHistory(): unknown[] {
    return this.history;
  }

  private emit(e: unknown): void {
    for (const l of [...this.listeners]) l(e);
  }

  async prompt(text: string): Promise<"started" | "queued"> {
    // Drive the scripted turn on a microtask so the caller's status-stream
    // subscription (set up in runPromptToIdle) is already attached.
    void Promise.resolve().then(async () => {
      this.emit({ type: "status", status: "running" });
      if (this.script === "error") {
        this.emit({ type: "error", message: "boom", recoverable: false });
        return;
      }
      if (this.script === "tool" || this.script === "permission") {
        this.emit({ type: "tool_call", id: "tc1", name: "read_file", input: { path: "x" } });
        if (this.script === "permission" && this.permissionHandler) {
          await this.permissionHandler({
            requestId: "p1",
            toolName: "write_file",
            input: { path: "y" },
            reason: "write outside",
          });
        }
        this.emit({ type: "tool_result", toolCallId: "tc1", name: "read_file", content: "file body" });
      }
      this.emit({ type: "message_delta", messageId: "m1", delta: { type: "text", text: `echo: ${text}` } });
      this.emit({ type: "status", status: "idle" });
    });
    return "started";
  }

  cancel(): void {
    this.cancelled = true;
    this.emit({ type: "status", status: "idle" });
  }

  async dispose(): Promise<void> {
    this.disposed++;
  }
}

function transportPair() {
  let open = true;
  const aBuf: string[] = [];
  const bBuf: string[] = [];
  let aWaiter: ((line: string | null) => void) | null = null;
  let bWaiter: ((line: string | null) => void) | null = null;
  const wakeA = (line: string | null) => {
    if (aWaiter) { const w = aWaiter; aWaiter = null; w(line); }
    else if (line !== null) aBuf.push(line);
  };
  const wakeB = (line: string | null) => {
    if (bWaiter) { const w = bWaiter; bWaiter = null; w(line); }
    else if (line !== null) bBuf.push(line);
  };
  const aTransport: RpcTransport = {
    write: (line) => { if (!open) throw new Error("a closed"); wakeB(line.replace(/\n$/, "")); },
    readLine: () => {
      if (aBuf.length > 0) return Promise.resolve(aBuf.shift()!);
      if (!open) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => (aWaiter = resolve));
    },
    close: () => wakeA(null),
  };
  const bTransport: RpcTransport = {
    write: (line) => { if (!open) throw new Error("b closed"); wakeA(line.replace(/\n$/, "")); },
    readLine: () => {
      if (bBuf.length > 0) return Promise.resolve(bBuf.shift()!);
      if (!open) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => (bWaiter = resolve));
    },
    close: () => wakeB(null),
  };
  return {
    aTransport,
    bTransport,
    closeAll: () => { open = false; wakeA(null); wakeB(null); },
  };
}

describe("ACP stdio adapter", () => {
  let tp: ReturnType<typeof transportPair>;
  let server: Peer;
  let client: Peer;
  let handle: ReturnType<typeof registerAcpServer>;
  let created: FakeSession[] = [];

  function setup(scriptOrFactory?: FakeSession["script"]) {
    tp = transportPair();
    server = new Peer({ transport: tp.aTransport });
    client = new Peer({ transport: tp.bTransport });
    created = [];
    handle = registerAcpServer(server, {
      defaultCwd: "/work",
      createSession: async (o) => {
        const s = new FakeSession({
          cwd: o.cwd,
          id: o.sessionId,
          script: scriptOrFactory,
          permissionHandler: o.onPermissionRequest as never,
        });
        created.push(s);
        return s as never;
      },
    });
  }

  afterEach(async () => {
    await handle?.dispose().catch(() => {});
    tp?.closeAll();
    await Promise.allSettled([server?.close(), client?.close()]);
  });

  it("initialize returns the protocol version and agent capabilities", async () => {
    setup();
    const res = await client.request<unknown, { protocolVersion: number; agentCapabilities: { loadSession: boolean } }>(
      "initialize",
      { protocolVersion: ACP_PROTOCOL_VERSION, clientInfo: { name: "t", version: "0" } },
    );
    expect(res.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(res.agentCapabilities.loadSession).toBe(true);
  });

  it("session/new creates a session and returns its id", async () => {
    setup();
    const res = await client.request<unknown, { sessionId: string }>("session/new", { cwd: "/proj" });
    expect(typeof res.sessionId).toBe("string");
    expect(created).toHaveLength(1);
    expect(created[0]!.cwd).toBe("/proj");
  });

  it("session/prompt streams updates and resolves with a stop reason at idle", async () => {
    setup("tool");
    const updates: Array<{ update: { sessionUpdate: string; [k: string]: unknown } }> = [];
    client.onNotification("session/update", (p) => updates.push(p as never));
    const { sessionId } = await client.request<unknown, { sessionId: string }>("session/new", {});
    const res = await client.request<unknown, { stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi there" }],
    });
    expect(res.stopReason).toBe("end_turn");
    const kinds = updates.map((u) => u.update.sessionUpdate);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
    expect(kinds).toContain("agent_message_chunk");
    const chunk = updates.find((u) => u.update.sessionUpdate === "agent_message_chunk")!;
    expect(JSON.stringify(chunk.update)).toContain("echo: hi there");
  });

  it("a core permission request becomes an ACP session/request_permission reverse call", async () => {
    setup("permission");
    let sawPermission = false;
    client.onRequest("session/request_permission", async (p: { options: Array<{ optionId: string }> }) => {
      sawPermission = true;
      expect(p.options.some((o) => o.optionId === "allow_once")).toBe(true);
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    });
    const { sessionId } = await client.request<unknown, { sessionId: string }>("session/new", {});
    const res = await client.request<unknown, { stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "do it" }],
    });
    expect(sawPermission).toBe(true);
    expect(res.stopReason).toBe("end_turn");
  });

  it("session/prompt on an unknown session id errors", async () => {
    setup();
    await expect(
      client.request("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "x" }] }),
    ).rejects.toThrow();
  });

  it("session/cancel cancels the live session", async () => {
    setup("tool");
    const { sessionId } = await client.request<unknown, { sessionId: string }>("session/new", {});
    await client.notify("session/cancel", { sessionId });
    await new Promise((r) => setImmediate(r));
    expect(created[0]!.cancelled).toBe(true);
  });

  it("an errored turn resolves with a refusal stop reason", async () => {
    setup("error");
    const { sessionId } = await client.request<unknown, { sessionId: string }>("session/new", {});
    const res = await client.request<unknown, { stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "x" }],
    });
    expect(res.stopReason).toBe("refusal");
  });

  it("session/load replays history as session/update notifications", async () => {
    tp = transportPair();
    server = new Peer({ transport: tp.aTransport });
    client = new Peer({ transport: tp.bTransport });
    created = [];
    handle = registerAcpServer(server, {
      defaultCwd: "/work",
      createSession: async (o) => {
        const s = new FakeSession({
          cwd: o.cwd,
          id: o.sessionId,
          history: [
            { type: "message", role: "assistant", id: "m1", content: [{ type: "text", text: "prior answer" }] },
            { type: "plan", steps: [{ id: "s1", title: "step one", status: "completed" }] },
          ],
        });
        created.push(s);
        return s as never;
      },
    });
    const updates: Array<{ update: { sessionUpdate: string } }> = [];
    client.onNotification("session/update", (p) => updates.push(p as never));
    await client.request("session/load", { sessionId: "acp_existing", cwd: "/proj" });
    await new Promise((r) => setImmediate(r));
    const kinds = updates.map((u) => u.update.sessionUpdate);
    expect(kinds).toContain("agent_message_chunk");
    expect(kinds).toContain("plan");
  });

  it("dispose tears down every live session", async () => {
    setup();
    await client.request("session/new", {});
    await client.request("session/new", {});
    expect(created).toHaveLength(2);
    await handle.dispose();
    expect(created.every((s) => s.disposed === 1)).toBe(true);
  });
});
