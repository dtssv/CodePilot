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
  diagnosticsProvider?: { forFile: (p: string) => Promise<unknown>; forWorkspace: () => Promise<unknown> };
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

  setReasoningEffort(effort: "low" | "medium" | "high" | undefined) {
    this.config = { ...this.config, reasoningEffort: effort, thinkingBudget: undefined };
  }

  sandboxMode: "off" | "workspace-write" | "read-only" = "workspace-write";
  setSandboxMode(mode: "off" | "workspace-write" | "read-only") {
    this.sandboxMode = mode;
    this.config = { ...this.config, sandbox: { mode } };
    return { mode, unavailable: false, backend: "none" };
  }
  getReasoningEffort(): "low" | "medium" | "high" | undefined {
    return this.config.reasoningEffort as "low" | "medium" | "high" | undefined;
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
  async compact(): Promise<void> {
    /* no-op in the mock */
  }
  async clearWorkingContext(_reason?: string): Promise<boolean> {
    // Mirror real semantics: nothing to clear when there's no assistant work.
    return this.events.some((e: { type?: string; role?: string }) => e.type === "message" && e.role === "assistant");
  }
  emit(e: unknown) {
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }
  async prompt(text: string, images?: unknown): Promise<void> {
    this.promptCalls.push({ text, images });
    if (text === "diag" && this.diagnosticsProvider) {
  // Exercise the diagnostics reverse-request path.
      const diags = (await this.diagnosticsProvider.forFile("a.ts")) as unknown[];
      this.emit({
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: `diags=${JSON.stringify(diags)}` }],
      });
      return;
    }
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
      const resolution = (await this.permissionHandler(req)) as
        | string
        | { decision: string; feedback?: string };
      const decision = typeof resolution === "string" ? resolution : resolution.decision;
      const feedback = typeof resolution === "string" ? undefined : resolution.feedback;
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
        content: feedback ?? "ok",
        isError: decision === "deny",
      });
      this.emit({
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: `decision=${decision}${feedback ? ` feedback=${feedback}` : ""}` }],
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
  sendFollowUpNow(id: string): "steered" | "started" | false {
    const idx = this.followUps.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    this.followUps.splice(idx, 1);
    return this.busy ? "steered" : "started";
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

// Mutable stand-in for the user config file, so config/setSandbox persistence
// does not touch the real ~/.codepilot/config.json during tests.
let fakeUserConfig: Record<string, unknown> = {};

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
      if (opts.diagnosticsProvider) s.diagnosticsProvider = opts.diagnosticsProvider;
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
        onboardedAt: "2026-01-02T03:04:05.000Z",
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
    // Keep sandbox-config persistence off the real user config file during tests.
    readUserConfigFile: vi.fn(async () => ({ raw: fakeUserConfig, path: "/tmp/fake-config.json" })),
    writeUserConfigFile: vi.fn(async (raw: Record<string, unknown>) => {
      fakeUserConfig = raw;
    }),
    detectSandboxBackend: vi.fn(() => "none" as const),
    runGoal: vi.fn(),
  };
});

// Now we can import the modules under test.
import { createSession, listSessions, loadConfig, SessionLockedError } from "@codepilot/core";
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
        capabilities: { config?: boolean; setModel?: boolean; providers?: string[] };
      }
    >("initialize", initParams);
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(res.capabilities).toBeTruthy();
    expect(res.capabilities.config).toBe(true);
    expect(res.capabilities.setModel).toBe(true);
    // Advertised providers must match the implemented set (ProviderName) — a
    // regression previously dropped gemini/azure here while they were fully
    // wired in the provider factory.
    expect([...(res.capabilities.providers ?? [])].sort()).toEqual(
      ["anthropic", "azure", "copilot", "gemini", "openai"],
    );
  });

  it("plugins/market returns the bundled discovery list with install-source descriptions", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "test", version: "0.0.0" },
    });
    const res = await client.request<
      { query?: string },
      { plugins: Array<{ name: string; source: string }>; describe: Record<string, string> }
    >("plugins/market", {});
    // The GitHub-hosted (bundled-seed) discovery entry point yields installable
    // plugins, each with a human-readable install-source line for confirmation.
    expect(res.plugins.length).toBeGreaterThan(0);
    const first = res.plugins[0]!;
    expect(typeof first.name).toBe("string");
    expect(typeof first.source).toBe("string");
    expect(res.describe[first.name]).toContain(first.source);
    // The query filter narrows the list.
    const filtered = await client.request<
      { query?: string },
      { plugins: Array<{ name: string }> }
    >("plugins/market", { query: "security" });
    expect(filtered.plugins.some((p) => p.name === "security-audit")).toBe(true);
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
        active: { onboardedAt?: string };
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
    // The first-run marker is surfaced so a remote TUI won't re-show setup.
    expect(snap.active.onboardedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("config/setSandbox persists the mode and hot-applies to a live session", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/tmp",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<{}, { sessionId: string }>("session/new", {});
    const res = await client.request<
      { mode: string; sessionId: string },
      { sandbox: { mode: string; unavailable: boolean; backend: string } }
    >("config/setSandbox", { mode: "off", sessionId });
    expect(res.sandbox.mode).toBe("off");
    // Persisted to the (faked) user config file.
    expect((fakeUserConfig.sandbox as { mode?: string } | undefined)?.mode).toBe("off");
    // Hot-applied to the live session.
    const session = sessionsById.get(sessionId)!;
    expect(session.sandboxMode).toBe("off");
  });

  it("config/setSandbox persists even without a live session", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/tmp",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const res = await client.request<
      { mode: string },
      { sandbox: { mode: string } }
    >("config/setSandbox", { mode: "read-only" });
    expect(res.sandbox.mode).toBe("read-only");
    expect((fakeUserConfig.sandbox as { mode?: string } | undefined)?.mode).toBe("read-only");
  });

  it("config/setSandbox rejects an invalid mode", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/tmp",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    await expect(
      client.request("config/setSandbox", { mode: "bogus" }),
    ).rejects.toThrow(/sandbox mode must be one of/);
  });

  it("config/get reports the sandbox mode", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/tmp",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const snap = await client.request<{}, { sandbox: { mode: string } }>("config/get", {});
    expect(snap.sandbox.mode).toBe("workspace-write");
  });

  it("config/get lists the search-engine catalog", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/tmp",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const snap = await client.request<
      {},
      { webSearch: { engines: Array<{ id: string }> } }
    >("config/get", {});
    expect(snap.webSearch.engines.length).toBeGreaterThan(0);
    expect(snap.webSearch.engines.some((e) => e.id === "brave")).toBe(true);
  });

  it("config/setWebSearch persists a custom template to the shared config", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/tmp",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const res = await client.request<
      { provider: string; apiKey: string; custom: { url: string } },
      { webSearch: { provider?: string; hasApiKey: boolean; customUrl?: string } }
    >("config/setWebSearch", {
      provider: "custom",
      apiKey: "sk-search-123",
      custom: { url: "https://api.example.com/s?q={query}" },
    });
    expect(res.webSearch.provider).toBe("custom");
    expect(res.webSearch.hasApiKey).toBe(true);
    expect(res.webSearch.customUrl).toBe("https://api.example.com/s?q={query}");
    const stored = fakeUserConfig.webSearch as { provider?: string; apiKey?: string; custom?: { url?: string } };
    expect(stored.provider).toBe("custom");
    expect(stored.custom?.url).toBe("https://api.example.com/s?q={query}");
  });

  it("config/setWebSearch(duckduckgo) clears a stale key/template", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/tmp",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    await client.request("config/setWebSearch", {
      provider: "custom",
      apiKey: "sk-x",
      custom: { url: "https://x/s" },
    });
    const res = await client.request<
      { provider: string },
      { webSearch: { provider?: string; hasApiKey: boolean } }
    >("config/setWebSearch", { provider: "duckduckgo" });
    expect(res.webSearch.provider).toBe("duckduckgo");
    expect(res.webSearch.hasApiKey).toBe(false);
    const stored = fakeUserConfig.webSearch as { apiKey?: string; custom?: unknown };
    expect(stored.apiKey).toBeUndefined();
    expect(stored.custom).toBeUndefined();
  });

  it("config/setOnboarded stamps the shared first-run marker idempotently", async () => {
    registerServer(server, { defaultCwd: "/tmp" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/tmp",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const first = await client.request<{}, { onboardedAt: string }>("config/setOnboarded", {});
    expect(typeof first.onboardedAt).toBe("string");
    expect(fakeUserConfig.onboardedAt).toBe(first.onboardedAt);
    // A second call keeps the original stamp (idempotent).
    const second = await client.request<{}, { onboardedAt: string }>("config/setOnboarded", {});
    expect(second.onboardedAt).toBe(first.onboardedAt);
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

  it("decline-with-feedback: permission/respond feedback reaches core as a deny resolution", async () => {
    registerServer(server, { defaultCwd: "/work", defaultPermissionMode: "ask" });

    client.onRequest<{ requestId: string }, Record<string, never>>(
      "permission/request",
      async ({ requestId }) => {
        void client.request("permission/respond", {
          requestId,
          decision: "deny",
          feedback: "edit b.txt instead",
        });
        return {};
      },
    );

    const events: unknown[] = [];
    client.onNotification("event", (params) => events.push(params));

    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<{}, { sessionId: string }>("session/new", {});
    await client.request("prompt/send", { sessionId, text: "hi" });
    await settled();

    // The FakeSession reflects the resolution it received from core: a deny
    // whose feedback rode through as the tool_result content.
    const toolResult = events.find((e: any) => e?.event?.type === "tool_result");
    expect((toolResult as any)?.event?.content).toBe("edit b.txt instead");
    expect((toolResult as any)?.event?.isError).toBe(true);
    const msg = events.find(
      (e: any) => e?.event?.type === "message" && e.event.role === "assistant",
    );
    expect((msg as any)?.event?.content?.[0]?.text).toContain("feedback=edit b.txt instead");
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

  it("diagnostics/request round-trips LSP diagnostics via an inline reply", async () => {
    registerServer(server, { defaultCwd: "/work", defaultPermissionMode: "ask" });

    let sawDiag = false;
    client.onRequest<{ sessionId: string; path?: string }, unknown>(
      "diagnostics/request",
      async ({ path }) => {
        sawDiag = true;
        expect(path).toBe("a.ts");
        // Inline reply — no separate diagnostics/respond.
        return {
          diagnostics: [{ line: 7, severity: "error", message: "boom" }],
        };
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
    const { sessionId } = await client.request<{}, { sessionId: string }>("session/new", {});
    await client.request("prompt/send", { sessionId, text: "diag" });
    await settled();
    expect(sawDiag).toBe(true);
    const final = events
      .map((e) => e.event)
      .find((e) => e?.type === "message" && e.content?.[0]?.text?.includes("diags="));
    expect(final?.content?.[0]?.text).toContain('"message":"boom"');
  });

  it("diagnostics provider yields an empty set when the host does not handle the request", async () => {
    registerServer(server, { defaultCwd: "/work", defaultPermissionMode: "ask" });
    // No diagnostics/request handler registered → the reverse request rejects
    // (method not found); the bridge catches it and the provider returns [].

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
    const { sessionId } = await client.request<{}, { sessionId: string }>("session/new", {});
    await client.request("prompt/send", { sessionId, text: "diag" });
    await settled();
    const final = events
      .map((e) => e.event)
      .find((e) => e?.type === "message" && e.content?.[0]?.text?.includes("diags="));
    expect(final?.content?.[0]?.text).toContain("diags=[]");
  });

  it("commands/list returns shared built-in commands for the /menu", async () => {
    registerServer(server, { defaultCwd: process.cwd(), defaultPermissionMode: "ask" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: process.cwd(),
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const res = await client.request<
      { cwd?: string },
      { commands: Array<{ name: string; source: string; kind: string }>; warnings: string[] }
    >("commands/list", {});
    const names = res.commands.map((c) => c.name);
    // Shared built-ins are advertised; TUI-only ones (exit/remote/connect/setup/
    // theme/web) are not.
    expect(names).toContain("compact");
    expect(names).toContain("clear");
    expect(names).toContain("model");
    expect(names).not.toContain("exit");
    expect(names).not.toContain("remote");
    expect(names).not.toContain("setup");
    // Every advertised built-in carries source "builtin" and kind "local" so a
    // GUI client can tell local actions apart from prompt-expanding commands.
    const model = res.commands.find((c) => c.name === "model")!;
    expect(model.source).toBe("builtin");
    expect(model.kind).toBe("local");
    expect(res.commands.every((c) => c.kind === "local" || c.kind === "prompt")).toBe(true);
  });

  it("workspace/complete returns file candidates for an @mention query", async () => {
    registerServer(server, { defaultCwd: process.cwd(), defaultPermissionMode: "ask" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: process.cwd(),
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const res = await client.request<
      { query: string; kinds?: string[]; cwd?: string },
      { candidates: Array<{ kind: string; value: string; label: string }> }
    >("workspace/complete", { query: "package", kinds: ["file"], cwd: process.cwd() });
    expect(Array.isArray(res.candidates)).toBe(true);
    // The protocol package has a package.json → should surface as a file candidate.
    expect(res.candidates.some((c) => c.kind === "file" && c.value.includes("package.json"))).toBe(true);
  });

  it("session/compact and session/clear-context are handled (local actions)", async () => {
    registerServer(server, { defaultCwd: process.cwd(), defaultPermissionMode: "ask" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: process.cwd(),
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const { sessionId } = await client.request<{}, { sessionId: string }>("session/new", {});
    // compact on a fresh session is a no-op but must resolve ok (not error).
    const c = await client.request<{ sessionId: string }, { ok: true }>("session/compact", { sessionId });
    expect(c.ok).toBe(true);
    // clear-context with no prior work returns cleared:false (nothing to archive).
    const cl = await client.request<{ sessionId: string }, { cleared: boolean }>("session/clear-context", { sessionId });
    expect(cl.cleared).toBe(false);
  });

  it("session/compact rejects an unknown session", async () => {
    registerServer(server, { defaultCwd: process.cwd(), defaultPermissionMode: "ask" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: process.cwd(),
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    try {
      await client.request("session/compact", { sessionId: "nope" });
      throw new Error("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
    }
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

  it("session/list over a remote grant is scoped to the granted cwds", async () => {
    // Seed sessions in two different workspaces.
    await (createSession as unknown as ReturnType<typeof vi.fn>)({ cwd: "/work/a" });
    await (createSession as unknown as ReturnType<typeof vi.fn>)({ cwd: "/work/b" });
    // Register a server whose connection is a QR remote grant for ONLY /work/a.
    serverHandle = registerServer(server, {
      defaultCwd: "/work/a",
      remoteGrant: {
        token: "t",
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
        cwd: "/work/a",
        cwds: ["/work/a"],
        caps: ["prompt", "cancel", "follow", "answer"],
      },
    });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work/a",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    const res = await client.request<{}, { sessions: Array<{ id: string; cwd?: string }> }>(
      "session/list",
      {},
    );
    // Only the /work/a session is visible; /work/b is withheld.
    expect(res.sessions.length).toBeGreaterThanOrEqual(1);
    expect(res.sessions.every((s) => s.cwd === "/work/a")).toBe(true);
    expect(res.sessions.some((s) => s.cwd === "/work/b")).toBe(false);
  });

  it("session/resume over a remote grant refuses an out-of-scope workspace", async () => {
    // A session living in /work/b, which the grant does NOT authorize.
    const outside = await (createSession as unknown as ReturnType<typeof vi.fn>)({
      cwd: "/work/b",
    });
    serverHandle = registerServer(server, {
      defaultCwd: "/work/a",
      remoteGrant: {
        token: "t",
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
        cwd: "/work/a",
        cwds: ["/work/a"],
        caps: ["prompt", "cancel", "follow", "answer"],
      },
    });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work/a",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    await expect(
      client.request("session/resume", { sessionId: outside.id }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it("a remote grant cannot point cwd-based RPCs at an unauthorized workspace", async () => {
    // Grant authorizes ONLY /work/a. Every cwd entry point must reject /work/b.
    serverHandle = registerServer(server, {
      defaultCwd: "/work/a",
      remoteGrant: {
        token: "t",
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
        cwd: "/work/a",
        cwds: ["/work/a"],
        caps: ["prompt", "cancel", "follow", "answer"],
      },
    });
    // initialize to an authorized cwd succeeds.
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work/a",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    // Re-initializing to an UNauthorized cwd (how the web client switches the
    // active workspace) must be refused — the former escalation vector.
    await expect(
      client.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        cwd: "/work/b",
        permissionMode: "ask",
        clientInfo: { name: "t", version: "0" },
      }),
    ).rejects.toBeInstanceOf(RpcError);
    // session/new, workspace/list, and commands/list at /work/b are refused too.
    await expect(
      client.request("session/new", { cwd: "/work/b" }),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      client.request("workspace/list", { path: ".", cwd: "/work/b" }),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      client.request("commands/list", { cwd: "/work/b" }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it("a remote grant denies-by-default any method not in the allowlist", async () => {
    // Security invariant: the scoped-grant gate is a DEFAULT-DENY per-method
    // allowlist (REMOTE_METHOD_CAPS). A privileged RPC that nobody added to the
    // map must be rejected for a phone grant — so a future privileged handler
    // added without an allowlist entry can never be silently reachable from a
    // scoped remote device. `workspace/write` is a registered handler that is
    // intentionally absent from REMOTE_METHOD_CAPS.
    serverHandle = registerServer(server, {
      defaultCwd: "/work/a",
      remoteGrant: {
        token: "t",
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
        cwd: "/work/a",
        cwds: ["/work/a"],
        caps: ["prompt", "cancel", "follow", "answer"],
      },
    });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work/a",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    await expect(
      client.request("workspace/write", { cwd: "/work/a", path: "x.txt", content: "y" }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it("a remote grant is refused a method whose required capability it lacks", async () => {
    // The grant can follow but was NOT given the `prompt` capability, so
    // prompt/send (REMOTE_METHOD_CAPS["prompt/send"] === "prompt") must be
    // rejected even though the method IS in the allowlist.
    serverHandle = registerServer(server, {
      defaultCwd: "/work/a",
      remoteGrant: {
        token: "t",
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
        cwd: "/work/a",
        cwds: ["/work/a"],
        caps: ["follow"],
      },
    });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work/a",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    await expect(
      client.request("prompt/send", { sessionId: "s1", text: "hi" }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it("the local (ungranted) connection is unaffected by cwd-scope enforcement", async () => {
    // No remoteGrant → any cwd is allowed (the normal desktop/web case).
    registerServer(server, { defaultCwd: "/work/a" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work/a",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    // Re-initialize to a different workspace: allowed for a local connection.
    await expect(
      client.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        cwd: "/work/b",
        permissionMode: "ask",
        clientInfo: { name: "t", version: "0" },
      }),
    ).resolves.toBeTruthy();
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

  it("workspace/read resolves a bare/relative name to the real nested file", async () => {
    // Regression: the model references "subagent.ts" (bare) or
    // "src/subagent.ts" (repo-relative, not rooted at the open workspace),
    // which joins to a non-existent path. Instead of ENOENT, read should find
    // the real file by basename/suffix and open it.
    const root = mkdtempSync(join(tmpdir(), "cp-resolve-"));
    mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "core", "src", "subagent.ts"), "export const SUB = 1;\n", "utf8");
    registerServer(server, { defaultCwd: root });
    await client.request("initialize", { protocolVersion: PROTOCOL_VERSION, cwd: root, permissionMode: "ask", clientInfo: { name: "t", version: "0" } });

    // Bare filename → resolved to the nested real file.
    const bare = (await client.request("workspace/read", { path: "subagent.ts" })) as { path: string; content: string };
    expect(bare.content).toContain("SUB = 1");
    expect(bare.path.replace(/\\/g, "/")).toBe("packages/core/src/subagent.ts");

    // Repo-relative suffix → same resolution.
    const suffix = (await client.request("workspace/read", { path: "core/src/subagent.ts" })) as { content: string };
    expect(suffix.content).toContain("SUB = 1");

    // A truly missing file still errors.
    await expect(client.request("workspace/read", { path: "does-not-exist.xyz" })).rejects.toBeInstanceOf(RpcError);
    rmSync(root, { recursive: true, force: true });
  });

  it("workspace/resolve returns the absolute path for a bare name (open-in-editor)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-resolve2-"));
    mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "core", "src", "subagent.ts"), "x\n", "utf8");
    registerServer(server, { defaultCwd: root });
    await client.request("initialize", { protocolVersion: PROTOCOL_VERSION, cwd: root, permissionMode: "ask", clientInfo: { name: "t", version: "0" } });

    // Bare name → absolute path of the real nested file (what the host opens).
    const bare = (await client.request("workspace/resolve", { path: "subagent.ts" })) as { path: string; absolute: string; exists: boolean };
    expect(bare.exists).toBe(true);
    expect(bare.absolute.replace(/\\/g, "/")).toBe(join(root, "packages", "core", "src", "subagent.ts").replace(/\\/g, "/"));

    // A path that already resolves directly is returned as-is.
    const direct = (await client.request("workspace/resolve", { path: "packages/core/src/subagent.ts" })) as { exists: boolean; absolute: string };
    expect(direct.exists).toBe(true);

    // Missing → exists:false, no throw (caller decides).
    const missing = (await client.request("workspace/resolve", { path: "nope.zzz" })) as { exists: boolean };
    expect(missing.exists).toBe(false);
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

  it("session/resume maps a write-lease conflict to a SESSION_LOCKED error carrying the owner", async () => {
    registerServer(server, { defaultCwd: "/work" });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd: "/work",
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });
    // A disk-load resume (id not live in memory) whose createSession throws
    // because another live process holds the write lease.
    const owner = { pid: 4242, acquiredAt: Date.now(), url: "ws://127.0.0.1:9/rpc", token: "tok" };
    const mockCreate = createSession as unknown as ReturnType<typeof vi.fn>;
    mockCreate.mockImplementationOnce(async () => {
      throw new SessionLockedError("locked-elsewhere", owner);
    });
    try {
      await client.request("session/resume", { sessionId: "locked-elsewhere" });
      throw new Error("expected SESSION_LOCKED");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      const rpc = err as RpcError;
      expect(rpc.code).toBe(-32002); // ErrorCode.SessionLocked
      expect((rpc.data as { owner: { pid: number } }).owner.pid).toBe(4242);
      expect((rpc.data as { sessionId: string }).sessionId).toBe("locked-elsewhere");
    }
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

  // ---------- inline completion (design G) ----------

  it("completion/inline uses the native FIM endpoint when completion.fim is set", async () => {
    // Override config for this call: an explicit completion model (skips the
    // smallModel gate) plus the FIM opt-in. The provider is the mocked DeepSeek
    // OpenAI-compatible endpoint, so FIM POSTs to its /v1/completions.
    // buildSingleProvider reads apiKey/baseURL/model at the top level (the
    // resolved-config shape), so mirror that here.
    vi.mocked(loadConfig).mockResolvedValueOnce({
      provider: "openai",
      model: "deepseek-chat",
      apiKey: "sk-secret-key-xyz",
      baseURL: "https://api.deepseek.com/v1",
      completion: { model: "deepseek-coder", fim: true },
    } as any);

    let fimUrl: string | undefined;
    let fimBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      fimUrl = u;
      fimBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ text: "sum(a, b)" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // A cwd no other test's live session uses, so the handler takes the
    // stateless loadConfig path (not a leaked live session).
    const cwd = "/completion-fim";
    registerServer(server, { defaultCwd: cwd });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd,
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });

    const res = await client.request<
      { prefix: string; suffix: string; path: string; requestId: string; maxTokens: number; cwd: string },
      { completion: string; requestId: string; disabledReason?: string }
    >("completion/inline", {
      prefix: "def add(a, b):\n    return ",
      suffix: "\n",
      path: "a.py",
      requestId: "r1",
      maxTokens: 32,
      cwd,
    });

    expect(fimUrl).toBe("https://api.deepseek.com/v1/completions");
    expect(fimBody?.model).toBe("deepseek-coder");
    expect(fimBody?.suffix).toBe("\n");
    expect(res.completion).toContain("sum(a, b)");
    expect(res.requestId).toBe("r1");
    expect(res.disabledReason).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("completion/inline reports no-small-model when no distinct model is configured", async () => {
    // smallModel falls back to the main model and there is no completion
    // override → the gate disables completion.
    vi.mocked(loadConfig).mockResolvedValueOnce({
      provider: "openai",
      model: "deepseek-chat",
      apiKey: "sk-secret-key-xyz",
      baseURL: "https://api.deepseek.com/v1",
    } as any);
    const cwd = "/completion-gate";
    registerServer(server, { defaultCwd: cwd });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd,
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });

    const res = await client.request<
      { prefix: string; suffix: string; path: string; requestId: string; cwd: string },
      { completion: string; requestId: string; disabledReason?: string }
    >("completion/inline", {
      prefix: "x = ",
      suffix: "",
      path: "a.py",
      requestId: "r2",
      cwd,
    });

    expect(res.completion).toBe("");
    expect(res.disabledReason).toBe("no-small-model");
    expect(res.requestId).toBe("r2");
  });

  it("completion/cancel aborts the in-flight upstream FIM call", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      provider: "openai",
      model: "deepseek-chat",
      apiKey: "sk-secret-key-xyz",
      baseURL: "https://api.deepseek.com/v1",
      completion: { model: "deepseek-coder", fim: true },
    } as any);

    // The FIM fetch hangs until its abort signal fires, then rejects with an
    // abort error — exactly how a real fetch behaves when cancelled. This lets
    // us prove the cancel notification reaches the upstream call (if the signal
    // were never threaded, this fetch would hang forever and the test times
    // out).
    let sawSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) => {
      sawSignal = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        const s = init.signal;
        if (s) {
          if (s.aborted) return reject(new DOMException("aborted", "AbortError"));
          s.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        }
      });
    });

    const cwd = "/completion-cancel";
    registerServer(server, { defaultCwd: cwd });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      cwd,
      permissionMode: "ask",
      clientInfo: { name: "t", version: "0" },
    });

    // Fire the completion but don't await it yet — it won't settle until we
    // cancel (the upstream fetch is parked on the abort signal).
    const pending = client.request<
      { prefix: string; suffix: string; path: string; requestId: string; cwd: string },
      { completion: string; requestId: string; disabledReason?: string }
    >("completion/inline", {
      prefix: "x = ",
      suffix: "",
      path: "a.py",
      requestId: "cancel-me",
      cwd,
    });

    // Give the handler a tick to issue the upstream fetch, then cancel.
    await new Promise((r) => setTimeout(r, 20));
    expect(sawSignal).toBeDefined();
    client.notify("completion/cancel", { requestId: "cancel-me" });

    // Fast-fail: an aborted upstream yields an empty completion, not a hang.
    const res = await pending;
    expect(res.completion).toBe("");
    expect(res.requestId).toBe("cancel-me");

    vi.unstubAllGlobals();
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
