// NDJSON JSON-RPC client over stdio.
//
// Spawns `codepilot serve` (or `node <cliPath>`) and speaks the headless
// protocol defined in docs/PROTOCOL.md. The client itself knows nothing about
// the chat UI; it just emits events and accepts method calls.

import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import type { CodepilotSettings } from "./config.js";
import type {
  Event,
  InitializeParams,
  InitializeResult,
  JsonRpcError,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcSuccess,
  PermissionDecision,
  PermissionRequestParams,
  PermissionRespondParams,
  PromptCancelParams,
  PromptSendParams,
  ServerEvent,
  SessionNewParams,
  SessionResumeParams,
  SessionUsageNotification,
} from "./types.js";

export type ConnectionState = "disconnected" | "connecting" | "ready" | "error";

export interface ClientEvents {
  state: (state: ConnectionState, detail?: string) => void;
  log: (line: string) => void;
  event: (sessionId: string, ev: Event) => void;
  usage: (n: SessionUsageNotification) => void;
  permissionRequest: (params: PermissionRequestParams) => void;
  /** Low-level protocol notification we don't model explicitly. */
  rawNotification: (method: string, params: unknown) => void;
  /** Server-initiated JSON-RPC request we don't have a handler for. */
  rawRequest: (method: string, params: unknown, respond: (result?: unknown, error?: { code: number; message: string }) => void) => void;
}

export declare interface CodePilotClient {
  on<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]): this;
  off<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]): this;
  emit<E extends keyof ClientEvents>(event: E, ...args: Parameters<ClientEvents[E]>): boolean;
}

const REQUEST_TIMEOUT_MS = 60_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class CodePilotClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private state: ConnectionState = "disconnected";
  private settings: CodepilotSettings;
  private serverCapabilities: InitializeResult["capabilities"] | null = null;
  /** Session IDs we know about (so we can warn on events for unknown ones). */
  private knownSessions = new Set<string>();

  constructor(settings: CodepilotSettings) {
    super();
    this.settings = settings;
  }

  /* ---------------- lifecycle ---------------- */

  async start(): Promise<void> {
    if (this.state === "ready" || this.state === "connecting") return;
    this.setState("connecting");
    const { cmd, args } = resolveLaunchCommand(this.settings);
    this.log(`spawning: ${cmd} ${args.join(" ")}`);

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...vscodeEnv() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`spawn failed: ${msg}`);
      this.setState("error", msg);
      throw err;
    }

    this.proc = proc;
    this.buffer = "";

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this.onStdout(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => this.onStderr(chunk));
    proc.on("error", (err) => this.fail(`process error: ${err.message}`));
    proc.on("exit", (code, signal) => {
      this.log(`process exited (code=${code}, signal=${signal})`);
      this.setState("error", `process exited (code=${code})`);
      this.proc = null;
      this.rejectAllPending(`process exited (code=${code})`);
    });

    try {
      const init: InitializeParams = {
        protocolVersion: this.settings.protocolVersion,
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        permissionMode: this.settings.permissionMode,
        clientInfo: { name: "codepilot-vscode", version: "2.0.0" },
      };
      const result = (await this.request<InitializeResult>("initialize", init)) as InitializeResult;
      this.serverCapabilities = result.capabilities;
      this.setState("ready");
      this.log(`connected (protocol v${result.protocolVersion})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.fail(`initialize failed: ${msg}`);
      void this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      // best-effort graceful shutdown
      await Promise.race([
        this.request("shutdown", {}),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch {
      // ignore — we're going to kill the process anyway
    }
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.setState("disconnected");
  }

  dispose(): void {
    void this.stop();
    this.removeAllListeners();
  }

  /* ---------------- session ops ---------------- */

  async newSession(params: SessionNewParams = {}): Promise<string> {
    const cwd = params.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const model = params.model ?? (this.settings.model || undefined);
    const sysExtra = params.systemPromptExtra ?? (this.settings.systemPromptExtra || undefined);
    const { sessionId } = await this.request<{ sessionId: string }>("session/new", {
      cwd,
      model,
      systemPromptExtra: sysExtra,
    });
    this.knownSessions.add(sessionId);
    return sessionId;
  }

  async resumeSession(sessionId: string): Promise<{ sessionId: string; events: Event[] }> {
    const result = await this.request<{ sessionId: string; events: Event[] }>("session/resume", {
      sessionId,
    } satisfies SessionResumeParams);
    this.knownSessions.add(result.sessionId);
    return result;
  }

  async sendPrompt(params: PromptSendParams): Promise<void> {
    await this.request("prompt/send", params);
  }

  async cancelPrompt(sessionId: string): Promise<void> {
    await this.request("prompt/cancel", { sessionId } satisfies PromptCancelParams);
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    await this.request("permission/respond", {
      requestId,
      decision,
    } satisfies PermissionRespondParams);
  }

  capabilities(): InitializeResult["capabilities"] | null {
    return this.serverCapabilities;
  }

  hasSession(id: string): boolean {
    return this.knownSessions.has(id);
  }

  /* ---------------- transport ---------------- */

  private request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (!this.proc || this.state !== "ready") {
      return Promise.reject(new Error(`client not ready (state=${this.state})`));
    }
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => resolve(v as R),
        reject,
        timer,
        method,
      });
      this.writeMessage(msg);
    });
  }

  private writeMessage(msg: JsonRpcMessage): void {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.fail(`write failed: ${m}`);
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) this.log(`[stderr] ${line}`);
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.log(`non-JSON line from server: ${line.slice(0, 200)}`);
      return;
    }

    // Responses
    if ("id" in msg && (msg as { id?: unknown }).id !== undefined && ("result" in msg || "error" in msg)) {
      const id = (msg as JsonRpcSuccess | JsonRpcError).id;
      if (id === null) return; // server parse error: no request to resolve
      const pending = this.pending.get(id);
      if (!pending) {
        // response for unknown id — drop
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if ("error" in msg) {
        pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server-initiated request (permission/request)
    if ("id" in msg && "method" in msg) {
      const req = msg as JsonRpcRequest;
      this.handleServerRequest(req);
      return;
    }

    // Notification
    if ("method" in msg) {
      this.handleServerNotification(msg.method, (msg as { params?: unknown }).params);
      return;
    }

    this.log(`unrecognized message: ${line.slice(0, 200)}`);
  }

  private handleServerRequest(req: JsonRpcRequest): void {
    const id = req.id;
    const respond = (result?: unknown, error?: { code: number; message: string }) => {
      if (error) {
        this.writeMessage({ jsonrpc: "2.0", id, error: { code: error.code, message: error.message } });
      } else {
        this.writeMessage({ jsonrpc: "2.0", id, result: result ?? null });
      }
    };
    if (req.method === "permission/request") {
      const params = req.params as PermissionRequestParams;
      this.emit("permissionRequest", params);
      return;
    }
    this.emit("rawRequest", req.method, req.params, respond);
  }

  private handleServerNotification(method: string, params: unknown): void {
    if (method === "event") {
      const p = params as ServerEvent;
      this.emit("event", p.sessionId, p.event);
      return;
    }
    if (method === "session/usage") {
      this.emit("usage", params as SessionUsageNotification);
      return;
    }
    this.emit("rawNotification", method, params);
  }

  private fail(reason: string): void {
    this.log(`error: ${reason}`);
    this.setState("error", reason);
    this.rejectAllPending(reason);
  }

  private rejectAllPending(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private setState(s: ConnectionState, detail?: string): void {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s, detail);
  }

  private log(line: string): void {
    this.emit("log", line);
  }
}

/* ---------------- helpers ---------------- */

function resolveLaunchCommand(s: CodepilotSettings): { cmd: string; args: string[] } {
  // Precedence: explicit cliPath => `node <cliPath>`; else `s.serverPath serve`.
  if (s.cliPath && s.cliPath.trim()) {
    return { cmd: s.nodePath || "node", args: [s.cliPath, "serve"] };
  }
  return { cmd: s.serverPath || "codepilot", args: ["serve"] };
}

function vscodeEnv(): Record<string, string> {
  // Pick out a few environment variables that codepilot likely cares about;
  // pass everything else through. Strip VSCode-specific noisy vars.
  const drop = new Set(["VSCODE_NLS_CONFIG", "VSCODE_NODE_CACHED_DATA_DIR", "VSCODE_PORTABLE"]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (drop.has(k)) continue;
    env[k] = v;
  }
  env.CODEPILOT_CLIENT = "vscode";
  env.CODEPILOT_CLIENT_VERSION = "2.0.0";
  env.CODEPILOT_SESSION_ID = randomUUID();
  return env;
}