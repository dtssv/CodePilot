// The CodePilot engine process (`codepilot serve`, JSON-RPC over stdio).
//
// The extension does not speak the protocol itself: the chat webview runs the
// shared web UI, which owns the JSON-RPC client. This class only spawns the
// process and moves newline-delimited lines between its stdio and the
// webview. `tapServerLine` peeks at the relayed traffic for the few things
// the extension host still does natively (status bar, busy context, diffs).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

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

export class Engine extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";

  constructor(
    private readonly settings: () => CodepilotSettings,
    private readonly cwd: () => string,
    private readonly spawner: Spawner = spawn,
  ) {
    super();
  }

  get running(): boolean {
    return this.proc !== null;
  }

 /** Spawn the process if it is not running. Throws if spawning fails. */
  start(): void {
    if (this.proc) return;
    const { cmd, args } = resolveLaunchCommand(this.settings());
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
    proc.on("exit", (code, signal) => done(`engine exited (code=${code ?? "?"}${signal ? `, ${signal}` : ""})`));
  }

  write(line: string): void {
    if (!this.proc) throw new Error("engine is not running");
    this.proc.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  }

  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try {
      proc.stdin.end();
      proc.kill();
    } catch {
 /* already gone */
    }
    this.emit("exit", "engine stopped");
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

export function resolveLaunchCommand(s: CodepilotSettings): { cmd: string; args: string[] } {
 // Precedence: explicit cliPath => `node <cliPath>`; else `s.serverPath serve`.
  if (s.cliPath && s.cliPath.trim()) {
    return { cmd: s.nodePath || "node", args: [s.cliPath, "serve"] };
  }
  return { cmd: s.serverPath || "codepilot", args: ["serve"] };
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
