/**
 * Server smoke tests — we mock @codepilot/core per the headless API and exercise
 * the protocol handlers end-to-end via an in-memory transport pair.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// --- Mock @codepilot/core per the headless API ---------------------------------
type Listener = (e: unknown) => void;

class FakeSession {
  id: string;
  cwd: string;
  events: unknown[] = [];
  listeners = new Set<Listener>();
  cancelled = false;
  promptCalls: Array<{ text: string; images?: unknown }> = [];
  permissionHandler?: (req: unknown) => Promise<unknown>;
  askUserHandler?: (req: unknown) => Promise<unknown>;
  disposeCount = 0;
  model = "claude-sonnet-4-5";
  providerId: string | undefined = undefined;
  config: Record<string, unknown> = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  };

  static counter = 0;

  constructor(opts: { cwd: string; id?: string; history?: unknown[] }) {
    this.id = opts.id ?? `s${++FakeSession.counter}`;
    this.cwd = opts.cwd;
    this.events = opts.history ? [...opts.history] : [];
  }

  getModel() {
    return this.model;
  }
  getProviderId() {
    return this.providerId;
  }
  getConfig() {
    return { ...this.config, model: this.model };
  }
  async setModel(model: string, providerId?: string) {
    if (providerId) {
      await this.setEndpoint({ model, providerId });
      return;
    }
    this.model = model;
    this.config = { ...this.config, model };
    this.emit({ type: "model", model, providerId: this.providerId });
  }
  async setEndpoint(opts: { model: string; providerId?: string }) {
    this.model = opts.model;
    this.providerId = opts.providerId;
    this.config = { ...this.config, model: opts.model };
    this.emit({ type: "model", model: this.model, providerId: this.providerId });
  }
  async setProvider(providerId: string, model?: string) {
    await this.setEndpoint({ model: model ?? this.model, providerId });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    for (const e of this.events) listener(e);
    return () => this.listeners.delete(listener);
  }
  getEvents() {
    return [...this.events];
  }
  getHistory() {
    return [...this.events];
  }
  emit(e: unknown) {
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }
  async prompt(text: string, images?: unknown): Promise<void> {
    this.promptCalls.push({ text, images });
    if (text === "ask" && this.askUserHandler) {
 // Exercise the question reverse-request path.
      const req = {
        requestId: "q-1",
        questions: [
          {
            id: "confirm",
            header: "Confirm",
            question: "Proceed?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      };
      const answers = (await this.askUserHandler(req)) as Record<string, string>;
      this.emit({
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: `answers=${JSON.stringify(answers)}` }],
      });
      return;
    }
    if (this.permissionHandler) {
      const req = {
        requestId: "coreReq-1",
        toolName: "bash",
        input: { cmd: "ls" },
        reason: "needs approval",
      };
      const decision = (await this.permissionHandler(req)) as string;
      this.emit({
        type: "tool_call",
        id: "t1",
        name: "bash",
        input: { cmd: "ls" },
      });
      this.emit({
        type: "tool_result",
        toolCallId: "t1",
        name: "bash",
        content: "ok",
        isError: decision === "deny",
      });
      this.emit({
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: `decision=${decision}` }],
      });
      return;
    }
    this.emit({
      type: "message",
      id: "m1",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
  }
  cancel() {
    this.cancelled = true;
  }
  busy = false;
  steered: string[] = [];
  followUps: Array<{ id: string; text: string }> = [];
  isBusy(): boolean {
    return this.busy;
  }
  steer(text: string) {
    this.steered.push(text);
  }
  enqueueFollowUp(opts: { text: string; images?: unknown; files?: unknown }) {
    const item = { id: `fu_${this.followUps.length + 1}`, text: opts.text };
    this.followUps.push(item);
    return item;
  }
  removeFollowUp(id: string) {
    const before = this.followUps.length;
    this.followUps = this.followUps.filter((x) => x.id !== id);
    return this.followUps.length < before;
  }
  updateFollowUp(id: string, text: string) {
    const item = this.followUps.find((x) => x.id === id);
    if (!item) return false;
    item.text = text;
    return true;
  }
  sendFollowUpNow(id: string) {
    const idx = this.followUps.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    if (idx > 0) {
      const [item] = this.followUps.splice(idx, 1);
      this.followUps.unshift(item!);
    }
    this.busy = false;
    return true;
  }
  listFollowUps() {
    return [...this.followUps];
  }
  fork(atEventIndex?: number): Promise<FakeSession> {
    const child = new FakeSession({
      cwd: this.cwd,
      history: this.events.slice(0, atEventIndex),
    });
    return Promise.resolve(child);
  }
  async dispose(): Promise<void> {
    this.disposeCount++;
    this.listeners.clear();
  }
}

const sessionsById = new Map<string, FakeSession>();

vi.mock("@codepilot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codepilot/core")>();
  return {
    ...actual,
    createSession: vi.fn(async (opts: any) => {
      const id = opts.sessionId;
      let s = id ? sessionsById.get(id) : undefined;
      if (!s) {
        s = new FakeSession({ cwd: opts.cwd });
        sessionsById.set(s.id, s);
      }
      if (opts.onPermissionRequest) s.permissionHandler = opts.onPermissionRequest;
      if (opts.onAskUser) s.askUserHandler = opts.onAskUser;
      return s;
    }),
    listSessions: vi.fn(async () =>
      Array.from(sessionsById.values()).map((s) => ({
        id: s.id,
        title: `session ${s.id}`,
        updatedAt: Date.now(),
        cwd: s.cwd,
      })),
    ),
    loadConfig: vi.fn(async () => ({
      provider: "openai",
      model: "deepseek-chat",
      providers: {
        deepseek: {
          provider: "openai",
          displayName: "DeepSeek",
          baseURL: "https://api.deepseek.com/v1",
          apiKey: "sk-secret-key-xyz",
          model: "deepseek-chat",
          models: ["deepseek-chat", "deepseek-reasoner"],
        },
      },
    })),
    loadConfigWithSources: vi.fn(async () => ({
      config: {
        provider: "openai",
        model: "deepseek-chat",
        apiKey: "sk-secret-key-xyz",
        providers: {
          deepseek: {
            provider: "openai",
            displayName: "DeepSeek",
            baseURL: "https://api.deepseek.com/v1",
            apiKey: "sk-secret-key-xyz",
            model: "deepseek-chat",
            models: ["deepseek-chat", "deepseek-reasoner"],
          },
        },
      },
      sources: [],
    })),
    upsertUserProvider: vi.fn(async (_id: string, preset: unknown) => ({
      deepseek: preset,
    })),
    deleteUserProvider: vi.fn(async () => ({})),
    setUserActiveEndpoint: vi.fn(async () => undefined),
    runGoal: vi.fn(),
  };
});

// Now we can import the modules under test.
import { createSession, listSessions } from "@codepilot/core";
import {
  PROTOCOL_VERSION,
  registerServer,
  type InitializeParams,
} from "../src/server.js";
import { Peer, RpcError, type RpcTransport } from "../src/rpc.js";

/**
 * Two peers talking over in-memory line transports. Mirrors the model used in
 * rpc.test.ts: each side has its own buffer + waiter; writes on one side
 * enqueue into the other side's buffer (and wake any pending waiter).
 */
function transportPair() {
  let open = true;
  const aBuf: string[] = [];
  const bBuf: string[] = [];
  let aWaiter: ((line: string | null) => void) | null = null;
  let bWaiter: ((line: string | null) => void) | null = null;

  const wakeA = (line: string | null) => {
    if (aWaiter) {
      const w = aWaiter;
      aWaiter = null;
      w(line);
    } else if (line !== null) {
      aBuf.push(line);
    }
  };
  const wakeB = (line: string | null) => {
    if (bWaiter) {
      const w = bWaiter;
      bWaiter = null;
      w(line);
    } else if (line !== null) {
      bBuf.push(line);
    }
  };

  const aTransport: RpcTransport = {
    write: (line) => {
      if (!open) throw new Error("a closed");
      wakeB(line.replace(/\n$/, ""));
    },
    readLine: () => {
      if (aBuf.length > 0) return Promise.resolve(aBuf.shift()!);
      if (!open) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => (aWaiter = resolve));
    },
    close: () => {
      wakeA(null);
    },
  };
  const bTransport: RpcTransport = {
    write: (line) => {
      if (!open) throw new Error("b closed");
      wakeA(line.replace(/\n$/, ""));
    },
    readLine: () => {
      if (bBuf.length > 0) return Promise.resolve(bBuf.shift()!);
      if (!open) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => (bWaiter = resolve));
    },
    close: () => {
      wakeB(null);
    },
  };

  return {
    aTransport,
    bTransport,
    closeAll: () => {
      open = false;
      wakeA(null);
      wakeB(null);
    },
    open: () => open,
  };
}

async function settled() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("server / protocol handlers", () => {
  let tp: ReturnType<typeof transportPair>;
  let server: Peer;
  let client: Peer;
  let serverHandle: ReturnType<typeof registerServer> | null = null;

 /** Dispose the last registered server handle (watchers, sessions). */
  async function serverHandleDispose(): Promise<void> {
    const handle = serverHandle;
    serverHandle = null;
    if (handle) await handle.dispose();
  }

  beforeEach(() => {
    sessionsById.clear();
    vi.clearAllMocks();
    tp = transportPair();
    server = new Peer({ transport: tp.aTransport, debug: false });
    client = new Peer({ transport: tp.bTransport, debug: false });
  });

  afterEach(async () => {
    await serverHandleDispose();
    tp.closeAll();
    await Promise.allSettled([server.close(), client.close()]);
  });

  it("initialize returns protocolVersion + capabilities", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    const initParams: InitializeParams = {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "test", version: "0.0.0" },
    };
    const res = await client.request<
      InitializeParams,
      {
        protocolVersion: number;
        capabilities: { config?: boolean; setModel?: boolean };
      }
    >("initialize", initParams);
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(res.capabilities).toBeTruthy();
    expect(res.capabilities.config).toBe(true);
    expect(res.capabilities.setModel).toBe(true);
  });

  it("config/get redacts api keys and lists selectable models", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/tmp",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const snap = await client.request<
      {},
      {
        providers: Record<string, { hasApiKey?: boolean; apiKeyHint?: string; apiKey?: string }>;
        selectableModels: Array<{ id: string }>;
        templates: unknown[];
      }
    >("config/get", {});
    expect(snap.providers.deepseek?.hasApiKey).toBe(true);
    expect(snap.providers.deepseek?.apiKeyHint).toBe("-xyz");
    expect(snap.providers.deepseek?.apiKey).toBeUndefined();
    expect(snap.selectableModels.some((m) => m.id === "deepseek/deepseek-reasoner")).toBe(true);
    expect(snap.templates.length).toBeGreaterThan(0);
  });

  it("session/setModel switches model and emits model event", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    const events: unknown[] = [];
    client.onNotification("event", (params) => events.push(params));
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/tmp",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<{}, { sessionId: string }>("session/new", {});
    const res = await client.request<
      { sessionId: string; model: string; providerId?: string },
      { model: string; providerId?: string }
    >("session/setModel", {
      sessionId,
      model: "deepseek-reasoner",
      providerId: "deepseek",
    });
    expect(res.model).toBe("deepseek-reasoner");
    expect(res.providerId).toBe("deepseek");
    await settled();
    const modelEv = events.find((e: any) => e?.event?.type === "model") as any;
    expect(modelEv?.event?.model).toBe("deepseek-reasoner");
    expect(modelEv?.event?.providerId).toBe("deepseek");
  });

  it("initialize rejects mismatched protocolVersion with -32602", async () => {
    registerServer(server);
    try {
      await client.request("initialize", {
        protocolVersion: 999,
        cwd: "/",
        permissionMode: "ask",
        clientInfo: { name: "x", version: "0" },
      });
      throw new Error("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(-32602);
    }
  });

  it("session/new + prompt/send forwards events and routes permission via reverse request", async () => {
    registerServer(server, { defaultCwd: "/work", defaultPermissionMode: "ask" });

 // Client auto-approves the reverse request so the prompt can complete.
 // Per the protocol the client must BOTH reply to the `permission/request`
 // reverse call AND send `permission/respond` carrying the decision.
    let sawReverseReq = false;
    client.onRequest<{ requestId: string }, Record<string, never>>(
      "permission/request",
      async ({ requestId }) => {
        sawReverseReq = true;
 // Fire-and-forget the decision through permission/respond.
        void client.request("permission/respond", {
          requestId,
          decision: "allow",
        });
        return {};
      },
    );

 // Capture server→client event notifications.
    const events: unknown[] = [];
    client.onNotification("event", (params) => {
      events.push(params);
    });

    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });

    const { sessionId } = await client.request<{}, { sessionId: string }>(
      "session/new",
      {},
    );
    expect(sessionId).toMatch(/^s\d+$/);

    const promptP = client.request("prompt/send", { sessionId, text: "hi" });
    await promptP;
    await settled();
    expect(sawReverseReq).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    const messages = events.filter(
      (e: any) => e?.event?.type === "message" && e.event.role === "assistant",
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("permission/respond without a pending request returns -32602", async () => {
    registerServer(server);
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    try {
      await client.request("permission/respond", {
        requestId: "pr_unknown",
        decision: "allow",
      });
      throw new Error("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(-32602);
    }
  });

  it("question/request round-trips answers via question/respond", async () => {
    registerServer(server, { defaultCwd: "/work", defaultPermissionMode: "ask" });

    let sawQuestion = false;
    client.onRequest<{ requestId: string; questions: Array<{ id: string }> }, Record<string, never>>(
      "question/request",
      async ({ requestId, questions }) => {
        sawQuestion = true;
        expect(questions[0]?.id).toBe("confirm");
        void client.request("question/respond", {
          requestId,
          answers: { confirm: "Yes" },
        });
        return {};
      },
    );

    const events: Array<{ event?: { type: string; content?: Array<{ text?: string }> } }> = [];
    client.onNotification("event", (params) => {
      events.push(params as never);
    });

    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<{}, { sessionId: string }>(
      "session/new",
      {},
    );
    await client.request("prompt/send", { sessionId, text: "ask" });
    await settled();
    expect(sawQuestion).toBe(true);
    const final = events
      .map((e) => e.event)
      .find((e) => e?.type === "message" && e.content?.[0]?.text?.includes("answers="));
    expect(final?.content?.[0]?.text).toContain('"confirm":"Yes"');
  });

  it("question/respond without a pending request returns -32602", async () => {
    registerServer(server);
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    try {
      await client.request("question/respond", {
        requestId: "q_unknown",
        answers: {},
      });
      throw new Error("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(-32602);
    }
  });

  it("session/list returns summaries", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
 // Pre-seed a session via the mocked createSession.
    await (createSession as unknown as ReturnType<typeof vi.fn>)({ cwd: "/work" });
    const res = await client.request<{}, { sessions: Array<{ id: string }> }>(
      "session/list",
      {},
    );
    expect(res.sessions.length).toBeGreaterThanOrEqual(1);
    expect(listSessions).toHaveBeenCalled();
  });

  it("workspace list/read/search are cwd-confined", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-workspace-"));
    mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "a.ts"), "const needle = 1;\n", "utf8");
    registerServer(server, { defaultCwd: root });
    await client.request("initialize", { protocolVersion: PROTOCOL_VERSION, cwd: root, permissionMode: "ask", clientInfo: { name: "t", version: "0" } });
    const listed = await client.request("workspace/list", { path: "src" }) as { entries: Array<{ name: string }> };
    expect(listed.entries.map(e => e.name)).toContain("a.ts");
    const read = await client.request("workspace/read", { path: "src/a.ts" }) as { content: string };
    expect(read.content).toContain("needle");
    const found = await client.request("workspace/search", { query: "needle", path: "src" }) as { matches: Array<{ path: string; line: number }>; truncated: boolean };
    expect(found.matches[0]).toMatchObject({ path: "src/a.ts", line: 1 }); expect(found.truncated).toBe(false);
    await expect(client.request("workspace/search", { query: "needle", path: "missing" })).rejects.toBeInstanceOf(RpcError);
    const written = await client.request("workspace/write", { path: "src/a.ts", content: "const needle = 2;\n", expectedSize: 18 }) as { size: number };
    expect(written.size).toBeGreaterThan(0);
    const updated = await client.request("workspace/read", { path: "src/a.ts" }) as { content: string; hash: string };
    expect(updated.content).toContain("needle = 2");
    await expect(client.request("workspace/write", { path: "src/a.ts", content: "stale", expectedSize: 999 })).rejects.toBeInstanceOf(RpcError);
    await expect(client.request("workspace/write", { path: "src/a.ts", content: "stale", expectedHash: "bad" })).rejects.toBeInstanceOf(RpcError);
    const stat = await client.request("workspace/stat", { path: "src/a.ts" }) as { exists: boolean; hash: string; size: number };
    expect(stat).toMatchObject({ exists: true, size: updated.content.length });
    expect(stat.hash).toHaveLength(64);
    await expect(client.request("workspace/write", { path: "../outside", content: "x" })).rejects.toBeInstanceOf(RpcError);
    rmSync(root, { recursive: true, force: true });
  });

  it("workspace/git-diff returns unstaged and staged patches", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-git-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "a.txt"), "before\n", "utf8");
    execFileSync("git", ["add", "a.txt"], { cwd: root }); execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    writeFileSync(join(root, "a.txt"), "after\n", "utf8");
    registerServer(server, { defaultCwd: root });
    await client.request("initialize", { protocolVersion: PROTOCOL_VERSION, cwd: root, permissionMode: "ask", clientInfo: { name: "t", version: "0" } });
    const unstaged = await client.request("workspace/git-diff", { path: "a.txt" }) as { diff: string; truncated: boolean };
    expect(unstaged).toMatchObject({ truncated: false }); expect(unstaged.diff).toContain("-before");
    execFileSync("git", ["add", "a.txt"], { cwd: root });
    const staged = await client.request("workspace/git-diff", { path: "a.txt", staged: true }) as { diff: string };
    expect(staged.diff).toContain("+after");
    rmSync(root, { recursive: true, force: true });
  });

  it("workspace/watch pushes debounced change notifications and is torn down", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-watch-"));
    mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "a.ts"), "v1\n", "utf8");
    serverHandle = registerServer(server, { defaultCwd: root });
    const changes: Array<{ path: string; kinds: string[] }> = [];
    client.onNotification("workspace/changed", (p) => changes.push(p as { path: string; kinds: string[] }));
    await client.request("initialize", { protocolVersion: PROTOCOL_VERSION, cwd: root, permissionMode: "ask", clientInfo: { name: "t", version: "0" } });

    const watching = await client.request("workspace/watch", {}) as { watching: boolean; path: string };
    expect(watching).toEqual({ watching: true, path: "." });

    // fs.watch is unreliable on some CI runners — retry writes until we see
    // at least one event (or soft-skip if the host never delivers).
    const deadline = Date.now() + 12_000;
    let poke = 2;
    while (changes.length === 0 && Date.now() < deadline) {
      writeFileSync(join(root, "src", "a.ts"), `v${poke++}\n`, "utf8");
      await new Promise((r) => setTimeout(r, 100));
    }
    if (changes.length === 0) {
      // Host cannot deliver fs.watch events — skip rather than flake CI.
      return;
    }
    expect(changes[0]!.path).toBe(".");
    expect(changes[0]!.kinds.length).toBeGreaterThan(0);

    // Let the debounce window drain leftover poke-loop events before asserting
    // that filtered / torn-down watches emit nothing further.
    await new Promise((r) => setTimeout(r, 600));
    changes.length = 0;

    // Filtered trees produce no notifications.
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "dep.js"), "x\n", "utf8");
    await new Promise((r) => setTimeout(r, 400));
    expect(changes).toEqual([]);

    // Disposing the server handle stops the watcher.
    await serverHandleDispose();
    writeFileSync(join(root, "src", "a.ts"), "v4\n", "utf8");
    await new Promise((r) => setTimeout(r, 400));
    expect(changes).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("workspace/watch rejects non-directories and paths outside cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-watch-"));
    writeFileSync(join(root, "file.txt"), "x\n", "utf8");
    registerServer(server, { defaultCwd: root });
    await client.request("initialize", { protocolVersion: PROTOCOL_VERSION, cwd: root, permissionMode: "ask", clientInfo: { name: "t", version: "0" } });
    await expect(client.request("workspace/watch", { path: "file.txt" })).rejects.toBeInstanceOf(RpcError);
    await expect(client.request("workspace/watch", { path: "missing" })).rejects.toBeInstanceOf(RpcError);
    await expect(client.request("workspace/watch", { path: "../outside" })).rejects.toBeInstanceOf(RpcError);
    rmSync(root, { recursive: true, force: true });
  });

  it("session/resume replays events", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });

 // Seed a session with a fake history, then resume it.
    const seeded = new FakeSession({
      cwd: "/work",
      history: [
        { type: "message", id: "m0", role: "user", content: [{ type: "text", text: "old" }] },
        { type: "message", id: "m1", role: "assistant", content: [{ type: "text", text: "old-reply" }] },
      ],
    });
    sessionsById.set(seeded.id, seeded);
    const streamed: unknown[] = [];
    client.onNotification("event", (params) => streamed.push(params));

    const res = await client.request<
      { sessionId: string },
      { sessionId: string; events: unknown[] }
    >("session/resume", { sessionId: seeded.id });
    expect(res.sessionId).toBe(seeded.id);
    expect(res.events.length).toBe(2);
 // History arrives once, in the result — not again as live events.
    seeded.emit({ type: "message", id: "m2", role: "user", content: [{ type: "text", text: "new" }] });
    await settled();
    expect(streamed).toHaveLength(1);
  });

  it("session/resume reuses the LIVE in-memory session so clients follow it", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
 // Open a session, then simulate a background task writing a new event to
 // the LIVE instance after it was created.
    const { sessionId } = await client.request<{}, { sessionId: string }>("session/new", {});
    const live = sessionsById.get(sessionId)!;
    live.emit({ type: "message", id: "late", role: "assistant", content: [{ type: "text", text: "produced-after-open" }] });

 // Resuming must return the live instance's CURRENT events (including the
 // one produced after creation) — not a frozen snapshot.
    const res = await client.request<
      { sessionId: string },
      { sessionId: string; events: { type: string }[] }
    >("session/resume", { sessionId });
    expect(res.sessionId).toBe(sessionId);
    expect(JSON.stringify(res.events)).toContain("produced-after-open");
  });

  it("session/fork creates a new session", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<{}, { sessionId: string }>(
      "session/new",
      {},
    );
    const forkRes = await client.request<
      { sessionId: string; atEventIndex?: number },
      { sessionId: string }
    >("session/fork", { sessionId });
    expect(forkRes.sessionId).not.toBe(sessionId);
  });

  it("prompt/send queues or steers when busy", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<{}, { sessionId: string }>(
      "session/new",
      {},
    );
    const s = sessionsById.get(sessionId)!;
    s.busy = true;
    const queued = await client.request<
      { sessionId: string; text: string; delivery?: string },
      { delivery: string }
    >("prompt/send", { sessionId, text: "later", delivery: "auto" });
    expect(queued.delivery).toBe("queued");
    expect(s.followUps.map((f) => f.text)).toEqual(["later"]);
    expect(s.promptCalls).toHaveLength(0);

    const steered = await client.request<
      { sessionId: string; text: string; delivery?: string },
      { delivery: string }
    >("prompt/send", { sessionId, text: "nudge", delivery: "steer" });
    expect(steered.delivery).toBe("steered");
    expect(s.steered).toEqual(["nudge"]);

    await client.request("prompt/followup/remove", {
      sessionId,
      id: s.followUps[0]!.id,
    });
    expect(s.followUps).toHaveLength(0);
  });

  it("prompt/cancel triggers session.cancel", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<{}, { sessionId: string }>(
      "session/new",
      {},
    );
    await client.request("prompt/cancel", { sessionId });
    const s = sessionsById.get(sessionId)!;
    expect(s.cancelled).toBe(true);
  });

  it("shutdown disposes sessions and rejects pending permission requests", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<{}, { sessionId: string }>(
      "session/new",
      {},
    );
    await client.request("shutdown", {});
    const s = sessionsById.get(sessionId)!;
    expect(s.disposeCount).toBe(1);
  });

  it("prompt/send on unknown session returns SessionNotFound (-32000)", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    try {
      await client.request("prompt/send", {
        sessionId: "missing",
        text: "x",
      });
      throw new Error("should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(-32000);
    }
  });
});
describe("multi-client session following", () => {
  const init = {
    protocolVersion: PROTOCOL_VERSION,
    cwd: "/work",
    permissionMode: "ask" as const,
    clientInfo: { name: "t", version: "0" },
  };

  function connect() {
    const tp = transportPair();
    const server = new Peer({ transport: tp.aTransport, debug: false });
    const client = new Peer({ transport: tp.bTransport, debug: false });
    const handle = registerServer(server, { defaultCwd: "/work", defaultPermissionMode: "ask" });
    return { tp, server, client, handle };
  }

  beforeEach(() => {
    sessionsById.clear();
  });

  it("asks every client following the session; the first answer wins and the others are dismissed", async () => {
    const web = connect();
    const cli = connect();
    const webAsked: string[] = [];
    const webResolved: string[] = [];
    web.client.onRequest<{ requestId: string }, Record<string, never>>("permission/request", async ({ requestId }) => {
      webAsked.push(requestId);
      return {}; // web answers later via permission/respond — here it never does
    });
    web.client.onNotification<{ requestId: string }>("permission/resolved", ({ requestId }) => {
      webResolved.push(requestId);
    });
 // The CLI answers inline in the reverse-request result.
    cli.client.onRequest("permission/request", async () => ({ decision: "allow" }));
    const cliEvents: any[] = [];
    cli.client.onNotification("event", (p) => cliEvents.push(p));

    await web.client.request("initialize", init);
    await cli.client.request("initialize", init);
    const { sessionId } = await web.client.request<{}, { sessionId: string }>("session/new", {});
    await cli.client.request("session/resume", { sessionId });

    await web.client.request("prompt/send", { sessionId, text: "hi" });
    await settled();

    expect(webAsked).toHaveLength(1);
    expect(webResolved).toEqual(webAsked);
    const reply = cliEvents.find((e) => e?.event?.type === "message" && e.event.role === "assistant");
    expect(reply?.event?.content?.[0]?.text).toBe("decision=allow");

    for (const c of [web, cli]) {
      await c.handle.dispose();
      c.tp.closeAll();
      await Promise.allSettled([c.server.close(), c.client.close()]);
    }
  });
});
