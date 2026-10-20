// The CodePilot engine: either a private `codepilot serve` over stdio, or a
// shared local daemon (`serve --daemon`) reached over WebSocket.
//
// Default mode is `shared`: discover ~/.codepilot/serve.json, attach if live,
// otherwise spawn the bundled CLI (or PATH fallback). The extension does not
// speak the protocol itself — the chat webview owns the JSON-RPC client; this
// class only moves newline-delimited lines between the transport and the
// webview. `tapServerLine` peeks at the relayed traffic for status / diffs.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";

import type { CodepilotSettings } from "./config.js";
import type { Event, UsageInfo } from "./types.js";

export interface EngineEvents {
  line: (line: string) => void;
  stderr: (text: string) => void;
  exit: (detail: string) => void;
}

export declare interface Engine {
  on<E extends keyof EngineEvents>(event: E, listener: EngineEvents[E]): this;
  off<E extends keyof EngineEvents>(event: E, listener: EngineEvents[E]): this;
  emit<E extends keyof EngineEvents>(event: E, ...args: Parameters<EngineEvents[E]>): boolean;
}

export type Spawner = typeof spawn;

interface ServeInfoLite {
  url: string;
  token: string;
  pid: number;
  host: string;
  port: number;
}

export class Engine extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ws: WebSocket | null = null;
  private buffer = "";
  private writeQueue: string[] = [];
  private starting = false;
  private generation = 0;

  constructor(
    private readonly settings: () => CodepilotSettings,
    private readonly cwd: () => string,
    /** Bundled `resources/codepilot-cli.cjs` inside the extension, if present. */
    private readonly bundledCliPath: string | undefined = undefined,
    private readonly spawner: Spawner = spawn,
  ) {
    super();
  }

  get running(): boolean {
    return this.proc !== null || this.ws !== null || this.starting;
  }

  /** Spawn / attach if not already running. Throws only for sync stdio failures. */
  start(): void {
    if (this.proc || this.ws || this.starting) return;
    const mode = this.settings().engineMode ?? "shared";
    if (mode === "stdio") {
      this.startStdio();
      return;
    }
    void this.startShared();
  }

  write(line: string): void {
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    if (this.proc) {
      this.proc.stdin.write(payload);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload.endsWith("\n") ? payload.slice(0, -1) : payload);
      return;
    }
    if (this.starting || this.ws) {
      this.writeQueue.push(payload.endsWith("\n") ? payload.slice(0, -1) : payload);
      return;
    }
    throw new Error("engine is not running");
  }

  stop(): void {
    this.generation += 1;
    this.starting = false;
    this.writeQueue = [];
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.stdin.end();
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
    this.emit("exit", "engine stopped");
  }

  private startStdio(): void {
    const { cmd, args } = resolveLaunchCommand(this.settings(), this.bundledCliPath, "stdio");
    const proc = this.spawner(cmd, args, {
      cwd: this.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: engineEnv(),
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;
    this.buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    const done = (detail: string): void => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.emit("exit", detail);
    };
    proc.on("error", (err) => done(`could not start \`${cmd}\`: ${err.message}`));
    proc.on("exit", (code, signal) =>
      done(`engine exited (code=${code ?? "?"}${signal ? `, ${signal}` : ""})`),
    );
  }

  private async startShared(): Promise<void> {
    const gen = ++this.generation;
    this.starting = true;
    try {
      let info = await readLiveServeInfoLocal();
      if (!info) {
        const { cmd, args } = resolveLaunchCommand(this.settings(), this.bundledCliPath, "shared");
        const child = this.spawner(cmd, args, {
          cwd: this.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
          env: engineEnv(),
          detached: true,
        });
        try {
          child.unref();
        } catch {
          /* ignore */
        }
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => this.emit("stderr", chunk));
        info = await waitForLiveServeInfoLocal(15_000);
        if (!info) {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          throw new Error(
            `daemon did not publish ~/.codepilot/serve.json after \`${cmd} ${args.join(" ")}\``,
          );
        }
      }
      if (gen !== this.generation) return;
      await this.attachWs(info, gen);
    } catch (err) {
      if (gen !== this.generation) return;
      this.starting = false;
      this.emit("exit", err instanceof Error ? err.message : String(err));
    }
  }

  private attachWs(info: ServeInfoLite, gen: number): Promise<void> {
    const url = serveInfoWsUrlLocal(info);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on("open", () => {
        if (gen !== this.generation) {
          ws.close();
          reject(new Error("engine superseded"));
          return;
        }
        this.starting = false;
        for (const line of this.writeQueue.splice(0)) {
          try {
            ws.send(line);
          } catch {
            /* ignore */
          }
        }
        resolve();
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const text = typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8");
        for (const line of text.split("\n")) {
          if (line.trim()) this.emit("line", line.trim());
        }
      });
      ws.on("error", (err) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.starting = false;
        reject(err);
        this.emit("exit", `websocket error: ${err.message}`);
      });
      ws.on("close", () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.starting = false;
        this.emit("exit", "engine websocket closed");
      });
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.emit("line", line);
    }
  }
}

export function resolveLaunchCommand(
  s: CodepilotSettings,
  bundledCliPath?: string,
  mode: "stdio" | "shared" = "stdio",
): { cmd: string; args: string[] } {
  const daemonArgs = mode === "shared" ? ["serve", "--daemon", "--port", "18765"] : ["serve"];
  const cli =
    (s.cliPath && s.cliPath.trim()) ||
    (bundledCliPath && existsSync(bundledCliPath) ? bundledCliPath : "");
  if (cli) {
    return { cmd: s.nodePath || "node", args: [cli, ...daemonArgs] };
  }
  return { cmd: s.serverPath || "codepilot", args: daemonArgs };
}

function engineEnv(): Record<string, string> {
  const drop = new Set(["VSCODE_NLS_CONFIG", "VSCODE_NODE_CACHED_DATA_DIR", "VSCODE_PORTABLE"]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v != null && !drop.has(k)) env[k] = v;
  }
  env.CODEPILOT_CLIENT = "vscode";
  env.CODEPILOT_CLIENT_VERSION = "2.0.0";
  env.CODEPILOT_SESSION_ID = randomUUID();
  return env;
}

export interface TapHandlers {
  onEvent?(sessionId: string, event: Event): void;
  onUsage?(usage: UsageInfo): void;
}

/**
 * Observe server → client notifications in relayed traffic. Never throws:
 * a line it cannot parse is simply not interesting to it.
 */
export function tapServerLine(line: string, handlers: TapHandlers): void {
  if (!line.includes('"method"')) return;
  let msg: { method?: unknown; params?: unknown; id?: unknown };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return;
  }
  if (msg.id !== undefined) return; // a request, not a notification
  if (msg.method === "event") {
    const p = msg.params as { sessionId?: string; event?: Event } | undefined;
    if (p?.event) handlers.onEvent?.(p.sessionId ?? "", p.event);
  } else if (msg.method === "session/usage") {
    const p = msg.params as { usage?: UsageInfo } | undefined;
    if (p?.usage) handlers.onUsage?.(p.usage);
  }
}

/* ---- lockfile helpers (duplicated lightly so the extension host stays lean) ---- */

function serveInfoPaths(): string[] {
  const dir = join(homedir(), ".codepilot");
  return [join(dir, "serve.json"), join(dir, "server.json")];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLiveServeInfoLocal(): Promise<ServeInfoLite | null> {
  const { readFile, unlink } = await import("node:fs/promises");
  for (const path of serveInfoPaths()) {
    let info: ServeInfoLite;
    try {
      info = JSON.parse(await readFile(path, "utf-8")) as ServeInfoLite;
    } catch {
      continue;
    }
    if (!info?.url || typeof info.pid !== "number") continue;
    const loopback =
      info.host === "127.0.0.1" || info.host === "localhost" || info.host === "::1";
    if (!loopback) continue;
    if (!pidAlive(info.pid)) {
      for (const p of serveInfoPaths()) {
        try {
          await unlink(p);
        } catch {
          /* ignore */
        }
      }
      return null;
    }
    return info;
  }
  return null;
}

async function waitForLiveServeInfoLocal(timeoutMs: number): Promise<ServeInfoLite | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await readLiveServeInfoLocal();
    if (info) return info;
    await new Promise((r) => setTimeout(r, 100));
  }
  return readLiveServeInfoLocal();
}

function serveInfoWsUrlLocal(info: ServeInfoLite): string {
  const base = info.url.replace(/\/$/, "");
  if (!info.token) return base;
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(info.token)}`;
}
