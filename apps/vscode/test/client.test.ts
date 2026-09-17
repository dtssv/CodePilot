import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { CodepilotSettings } from "../src/config.js";

// Mock child_process before importing the client — the client spawns the
// `codepilot serve` subprocess, which we replace with an in-memory fake.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { CodePilotClient } from "../src/client.js";

/* ---------------- fake subprocess ---------------- */

class FakeStdin extends EventEmitter {
  lines: Array<Record<string, unknown>> = [];
  private buf = "";

  write(chunk: string): boolean {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.lines.push(JSON.parse(line));
    }
    return true;
  }
}

class FakeReadable extends EventEmitter {
  setEncoding(_enc: string): this {
    return this;
  }

  /** Emit a chunk the way a flowing stdout stream would. */
  feed(chunk: string): void {
    queueMicrotask(() => this.emit("data", chunk));
  }
}

/**
 * In-memory stand-in for ChildProcessWithoutNullStreams. The test drives the
 * server side by feeding NDJSON lines into `stdout` and inspects what the
 * client wrote via `written()`.
 */
class FakeProcess extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  killedWith: string[] = [];

  kill(signal: string): boolean {
    this.killedWith.push(signal);
    return true;
  }

  emitExit(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal);
  }

  /** All JSON-RPC messages the client has written so far. */
  written(): Array<Record<string, unknown>> {
    return this.stdin.lines;
  }

  /** Push one NDJSON line from the "server" into the client. */
  send(msg: unknown): void {
    this.stdout.feed(JSON.stringify(msg) + "\n");
  }

  /** Push raw bytes (e.g. non-JSON garbage) from the server. */
  sendRaw(line: string): void {
    this.stdout.feed(line + "\n");
  }

  /** Push a partial chunk (no newline) into stdout. */
  sendChunk(chunk: string): void {
    this.stdout.feed(chunk);
  }

  /** Respond to a pending client request. */
  respond(id: number | string, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  /** Respond with a JSON-RPC error. */
  respondError(id: number | string, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

const tick = () => new Promise((r) => setImmediate(r));

const spawnMock = vi.mocked(spawn);

function makeSettings(overrides: Partial<CodepilotSettings> = {}): CodepilotSettings {
  return {
    serverPath: "codepilot",
    cliPath: "",
    nodePath: "node",
    permissionMode: "ask",
    model: "",
    provider: "",
    systemPromptExtra: "",
    autoApprove: [],
    showDiff: true,
    protocolVersion: 1,
    agentMode: "agent",
    ...overrides,
  };
}

/**
 * Start a client against a fresh fake process and complete the `initialize`
 * handshake. Returns the connected client and the process.
 */
async function connect(
  settings: CodepilotSettings = makeSettings(),
): Promise<{ client: CodePilotClient; proc: FakeProcess }> {
  const proc = new FakeProcess();
  spawnMock.mockReturnValueOnce(proc as never);
  const client = new CodePilotClient(settings);
  const started = client.start();
  await tick();
  const initReq = proc.written().find((m) => m.method === "initialize");
  expect(initReq).toBeDefined();
  proc.respond(initReq!.id as number, {
    protocolVersion: 1,
    capabilities: { tools: ["read_file"], providers: ["anthropic"], modes: ["chat", "plan", "agent"] },
  });
  await started;
  return { client, proc };
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------------- lifecycle ---------------- */

describe("lifecycle", () => {
  it("spawns the server and transitions disconnected → connecting → ready", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc as never);
    const client = new CodePilotClient(makeSettings());

    const states: string[] = [];
    client.on("state", (s) => states.push(s));

    const started = client.start();
    expect(spawnMock).toHaveBeenCalledWith(
      "codepilot",
      ["serve"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    await tick();
    proc.respond(1, { protocolVersion: 1, capabilities: { tools: [], providers: [] } });
    await started;

    expect(states).toEqual(["connecting", "ready"]);
    expect(client.capabilities()).toEqual({ tools: [], providers: [] });
  });

  it("sends initialize params with cwd from the workspace folder", async () => {
    (vscode as unknown as { __setWorkspaceFolders(f: unknown): void }).__setWorkspaceFolders([
      { uri: { fsPath: "/ws/project" } },
    ]);
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc as never);
    const client = new CodePilotClient(makeSettings({ permissionMode: "auto-edit" }));
    const started = client.start();
    await tick();

    const init = proc.written()[0] as { method: string; params: Record<string, unknown> };
    expect(init.method).toBe("initialize");
    expect(init.params.cwd).toBe("/ws/project");
    expect(init.params.permissionMode).toBe("auto-edit");
    expect(init.params.protocolVersion).toBe(1);
    expect((init.params.clientInfo as { name: string }).name).toBe("codepilot-vscode");

    proc.respond(1, { protocolVersion: 1, capabilities: { tools: [], providers: [] } });
    await started;
  });

  it("falls back to process.cwd() when no workspace folder is open", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc as never);
    const client = new CodePilotClient(makeSettings());
    const started = client.start();
    await tick();
    const init = proc.written()[0] as { params: { cwd: string } };
    expect(init.params.cwd).toBe(process.cwd());
    proc.respond(1, { protocolVersion: 1, capabilities: { tools: [], providers: [] } });
    await started;
  });

  it("launches via `node <cliPath> serve` when cliPath is set", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc as never);
    const client = new CodePilotClient(
      makeSettings({ cliPath: "/opt/codepilot/cli.js", nodePath: "/usr/bin/node" }),
    );
    const started = client.start();
    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/opt/codepilot/cli.js", "serve"],
      expect.anything(),
    );
    await tick();
    proc.respond(1, { protocolVersion: 1, capabilities: { tools: [], providers: [] } });
    await started;
  });

  it("passes client env vars to the spawned process", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc as never);
    const client = new CodePilotClient(makeSettings());
    const started = client.start();
    const env = (spawnMock.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env.CODEPILOT_CLIENT).toBe("vscode");
    expect(env.CODEPILOT_CLIENT_VERSION).toBe("2.0.0");
    expect(env.CODEPILOT_SESSION_ID).toBeTruthy();
    await tick();
    proc.respond(1, { protocolVersion: 1, capabilities: { tools: [], providers: [] } });
    await started;
  });

  it("is a no-op when start() is called while connecting or ready", async () => {
    const { client } = await connect();
    await client.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("reports spawn failures as an error state and rethrows", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("ENOENT: codepilot not found");
    });
    const client = new CodePilotClient(makeSettings());
    const states: string[] = [];
    client.on("state", (s) => states.push(s));
    await expect(client.start()).rejects.toThrow("ENOENT");
    expect(states).toEqual(["connecting", "error"]);
  });

  it("fails and stops when initialize gets an error response", async () => {
    const proc = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc as never);
    const client = new CodePilotClient(makeSettings());
    const states: string[] = [];
    client.on("state", (s) => states.push(s));
    const started = client.start();
    await tick();
    proc.respondError(1, -32600, "unsupported protocol");
    await expect(started).rejects.toThrow("unsupported protocol (code -32600)");
    expect(states).toContain("error");
  });

  it("stop() sends shutdown, kills the process, and goes disconnected", async () => {
    const { client, proc } = await connect();
    const states: string[] = [];
    client.on("state", (s) => states.push(s));

    const stopped = client.stop();
    await tick();
    const shutdown = proc.written().find((m) => m.method === "shutdown");
    expect(shutdown).toBeDefined();
    proc.respond(shutdown!.id as number, {});
    await stopped;

    expect(proc.killedWith).toEqual(["SIGTERM"]);
    expect(states).toEqual(["disconnected"]);
  });

  it("transitions to error and rejects pending requests when the process exits", async () => {
    const { client, proc } = await connect();
    const states: string[] = [];
    client.on("state", (s) => states.push(s));

    const pending = client.sendPrompt({ sessionId: "s1", text: "hi" });
    const assertion = expect(pending).rejects.toThrow("process exited (code=1)");
    proc.emitExit(1);
    await assertion;
    expect(states).toEqual(["error"]);
  });
});

/* ---------------- session ops ---------------- */

describe("session ops", () => {
  it("newSession sends session/new and tracks the returned session id", async () => {
    const { client, proc } = await connect(makeSettings({ model: "m1", agentMode: "plan" }));
    const p = client.newSession();
    await tick();
    const req = proc.written().find((m) => m.method === "session/new") as {
      id: number;
      params: Record<string, unknown>;
    };
    expect(req.params).toEqual({
      cwd: process.cwd(),
      model: "m1",
      systemPromptExtra: undefined,
      agentMode: "plan",
    });
    proc.respond(req.id, { sessionId: "sess_42" });
    await expect(p).resolves.toBe("sess_42");
    expect(client.hasSession("sess_42")).toBe(true);
    expect(client.hasSession("nope")).toBe(false);
  });

  it("resumeSession sends session/resume and tracks the session id", async () => {
    const { client, proc } = await connect();
    const events = [{ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }];
    const p = client.resumeSession("sess_old");
    await tick();
    const req = proc.written().find((m) => m.method === "session/resume") as { id: number };
    proc.respond(req.id, { sessionId: "sess_old", events });
    await expect(p).resolves.toEqual({ sessionId: "sess_old", events });
    expect(client.hasSession("sess_old")).toBe(true);
  });

  it("rejects requests made before the client is ready", async () => {
    const client = new CodePilotClient(makeSettings());
    await expect(client.sendPrompt({ sessionId: "s", text: "x" })).rejects.toThrow(
      "client not ready (state=disconnected)",
    );
  });

  it("rejects with the server error message and code", async () => {
    const { client, proc } = await connect();
    const p = client.cancelPrompt("sess_x");
    await tick();
    const req = proc.written().find((m) => m.method === "prompt/cancel") as { id: number };
    proc.respondError(req.id, -32000, "no such session");
    await expect(p).rejects.toThrow("no such session (code -32000)");
  });

  it("times out requests that never get a response", async () => {
    // Connect with REAL timers first — `connect()` relies on `setImmediate`
    // (via `tick()`), which fake timers would freeze and hang the test.
    const { client } = await connect();
    vi.useFakeTimers();
    try {
      const p = client.setMode("sess_x", "plan");
      const assertion = expect(p).rejects.toThrow(
        "session/setMode timed out after 60000ms",
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ---------------- server-initiated traffic ---------------- */

describe("server-initiated traffic", () => {
  it("emits `event` for event notifications", async () => {
    const { client, proc } = await connect();
    const seen: Array<{ sessionId: string; type: string }> = [];
    client.on("event", (sessionId, ev) => seen.push({ sessionId, type: ev.type }));
    proc.send({
      jsonrpc: "2.0",
      method: "event",
      params: { sessionId: "s1", event: { type: "status", status: "running" } },
    });
    await tick();
    expect(seen).toEqual([{ sessionId: "s1", type: "status" }]);
  });

  it("emits `usage` for session/usage notifications", async () => {
    const { client, proc } = await connect();
    const seen: unknown[] = [];
    client.on("usage", (n) => seen.push(n));
    proc.send({
      jsonrpc: "2.0",
      method: "session/usage",
      params: { sessionId: "s1", usage: { input: 10, output: 4 } },
    });
    await tick();
    expect(seen).toEqual([{ sessionId: "s1", usage: { input: 10, output: 4 } }]);
  });

  it("emits `rawNotification` for unmodeled notifications", async () => {
    const { client, proc } = await connect();
    const seen: unknown[] = [];
    client.on("rawNotification", (method, params) => seen.push([method, params]));
    proc.send({ jsonrpc: "2.0", method: "some/future", params: { a: 1 } });
    await tick();
    expect(seen).toEqual([["some/future", { a: 1 }]]);
  });

  it("acks permission/request immediately and emits permissionRequest", async () => {
    const { client, proc } = await connect();
    const seen: unknown[] = [];
    client.on("permissionRequest", (p) => seen.push(p));
    proc.send({
      jsonrpc: "2.0",
      id: "srv-1",
      method: "permission/request",
      params: { sessionId: "s1", requestId: "r1", toolName: "write_file", input: {}, reason: "edit" },
    });
    await tick();

    const ack = proc.written().find((m) => m.id === "srv-1");
    expect(ack).toEqual({ jsonrpc: "2.0", id: "srv-1", result: {} });
    expect(seen).toEqual([
      { sessionId: "s1", requestId: "r1", toolName: "write_file", input: {}, reason: "edit" },
    ]);
  });

  it("acks question/request immediately and emits questionRequest", async () => {
    const { client, proc } = await connect();
    const seen: unknown[] = [];
    client.on("questionRequest", (p) => seen.push(p));
    proc.send({
      jsonrpc: "2.0",
      id: "srv-2",
      method: "question/request",
      params: { sessionId: "s1", requestId: "q1", questions: [{ id: "q", question: "Proceed?" }] },
    });
    await tick();

    const ack = proc.written().find((m) => m.id === "srv-2");
    expect(ack).toEqual({ jsonrpc: "2.0", id: "srv-2", result: {} });
    expect(seen).toEqual([
      { sessionId: "s1", requestId: "q1", questions: [{ id: "q", question: "Proceed?" }] },
    ]);
  });

  it("forwards unknown server requests to rawRequest with a respond callback", async () => {
    const { client, proc } = await connect();
    const seen: unknown[] = [];
    client.on("rawRequest", (method, params, respond) => {
      seen.push([method, params]);
      respond({ ok: true });
    });
    proc.send({ jsonrpc: "2.0", id: 99, method: "custom/call", params: { x: 1 } });
    await tick();

    expect(seen).toEqual([["custom/call", { x: 1 }]]);
    const resp = proc.written().find((m) => m.id === 99);
    expect(resp).toEqual({ jsonrpc: "2.0", id: 99, result: { ok: true } });
  });

  it("respondPermission and respondQuestion send the right methods", async () => {
    const { client, proc } = await connect();
    const p1 = client.respondPermission("r1", "always");
    await tick();
    let req = proc.written().find((m) => m.method === "permission/respond") as {
      id: number;
      params: unknown;
    };
    expect(req.params).toEqual({ requestId: "r1", decision: "always" });
    proc.respond(req.id, {});
    await p1;

    const p2 = client.respondQuestion("q1", { q: "yes" });
    await tick();
    req = proc.written().find((m) => m.method === "question/respond") as {
      id: number;
      params: unknown;
    };
    expect(req.params).toEqual({ requestId: "q1", answers: { q: "yes" } });
    proc.respond(req.id, {});
    await p2;
  });

  it("logs non-JSON lines instead of crashing", async () => {
    const { client, proc } = await connect();
    const logs: string[] = [];
    client.on("log", (l) => logs.push(l));
    proc.sendRaw("this is not json");
    await tick();
    expect(logs.some((l) => l.includes("non-JSON line"))).toBe(true);
  });

  it("drops responses for unknown request ids", async () => {
    const { client, proc } = await connect();
    const logs: string[] = [];
    client.on("log", (l) => logs.push(l));
    // Should be silently ignored (no throw, no log).
    proc.send({ jsonrpc: "2.0", id: 12345, result: {} });
    await tick();
  });

  it("logs stderr output from the server", async () => {
    const { client, proc } = await connect();
    const logs: string[] = [];
    client.on("log", (l) => logs.push(l));
    proc.stderr.feed("warn: something happened\n");
    await tick();
    expect(logs).toContain("[stderr] warn: something happened");
  });

  it("handles messages split across stdout chunks", async () => {
    const { client, proc } = await connect();
    const seen: string[] = [];
    client.on("event", (_s, ev) => seen.push(ev.type));
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { sessionId: "s1", event: { type: "status", status: "idle" } },
    });
    proc.sendChunk(line.slice(0, 10));
    proc.sendChunk(line.slice(10) + "\n");
    await tick();
    expect(seen).toEqual(["status"]);
  });
});
