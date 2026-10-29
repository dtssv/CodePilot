// MCP stdio transport: JSON-RPC 2.0 over newline-delimited JSON on a child
// process's stdout. The historical transport, used by most existing servers.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { BaseJsonRpcClient } from "./mcp-jsonrpc.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp-jsonrpc.js";
import type { McpStdioServerConfig } from "./mcp-types.js";

/** Prepend common user bin directories to PATH when they exist but are missing
 * (the GUI-launched-daemon case, where PATH is trimmed and `npx`/`uvx`/`node`
 * can't be found → MCP servers exit with code 127). Order preserves the
 * inherited PATH first, then appends any missing standard dirs. */
export function augmentedPath(current: string | undefined): string {
  const parts = (current ?? "").split(delimiter).filter(Boolean);
  const have = new Set(parts);
  const candidates = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    join(homedir(), ".local", "bin"),
    join(homedir(), ".nvm", "current", "bin"),
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".deno", "bin"),
    "/usr/bin",
    "/bin",
  ];
  for (const dir of candidates) {
    if (!have.has(dir) && existsSync(dir)) {
      parts.push(dir);
      have.add(dir);
    }
  }
  return parts.join(delimiter);
}

/** Spawn `command` with `args`, talk JSON-RPC over its stdio. */
export class McpStdioClient extends BaseJsonRpcClient {
  private proc: ChildProcess | null = null;
  private buffer = "";
  /** Set once a successful handshake has happened, so ensureConnected knows a
   * dropped connection is worth transparently respawning (vs a never-started
   * client, which must go through the explicit start()). */
  private everStarted = false;
  /** Guards against concurrent reconnect attempts. */
  private reconnecting: Promise<void> | null = null;

  constructor(
    public readonly serverName: string,
    private readonly config: McpStdioServerConfig
  ) {
    super();
  }

  /** Spawn the child and wire its stdio. Shared by start() and reconnect. */
  private spawnProc(): void {
    const command = this.config.command!;
    const proc = spawn(command, this.config.args ?? [], {
      env: {
        ...process.env,
        // MCP servers are commonly launched via `npx`/`uvx`/`node`. When the
        // daemon is started by a GUI app (the macOS desktop launches it via
        // Electron), the inherited PATH is the trimmed GUI environment
        // (/usr/bin:/bin:/usr/sbin:/sbin) and omits /usr/local/bin,
        // /opt/homebrew/bin, nvm, etc. — so `npx` isn't found and the server
        // exits with code 127. Augment PATH with the usual user bin dirs so
        // stdio servers resolve regardless of how the daemon was launched.
        PATH: augmentedPath(process.env.PATH),
        ...(this.config.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.buffer = "";
    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", (chunk: string) => {
      process.stderr.write(`[mcp:${this.serverName}] ${chunk}`);
    });
    // Listen for spawn-time errors (e.g. ENOENT). Without a handler Node
    // throws an uncaught exception; we need to surface the failure into
    // the pending map so the awaiting handshake rejects.
    proc.on("error", (err) => {
      this.failAllPending(err);
      this.proc = null;
    });
    proc.on("exit", (code) => {
      this.failAllPending(
        new Error(`MCP server ${this.serverName} exited (code ${code})`)
      );
      this.proc = null;
    });
  }

  async start(): Promise<void> {
    if (this.proc) return;
    if (!this.config.command) {
      throw new Error(
        `MCP stdio server ${this.serverName}: command is required (use type "http" or "sse" with a url for remote servers)`
      );
    }
    this.spawnProc();
    await this.handshakeAndDiscover();
    this.everStarted = true;
  }

  /** Transparently respawn + re-handshake a dropped server before a request.
   * Only after a prior successful start — a never-started client must use
   * start(). Concurrent callers share one reconnect. Best-effort: on failure
   * the subsequent sendFrame throws as before. */
  protected override async ensureConnected(): Promise<void> {
    if (this.proc || !this.everStarted || !this.config.command) return;
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = (async () => {
      process.stderr.write(`[mcp:${this.serverName}] connection lost — reconnecting\n`);
      this.spawnProc();
      await this.handshakeAndDiscover();
    })().finally(() => {
      this.reconnecting = null;
    });
    return this.reconnecting;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      this.proc.stdin!.end();
    } catch {
 /* ignore */
    }
    const proc = this.proc;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
 /* ignore */
        }
        resolve();
      }, 1000);
      proc.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
  }

  protected sendFrame(msg: JsonRpcRequest): void {
    if (!this.proc || !this.proc.stdin) {
      throw new Error(`MCP ${this.serverName} is not running`);
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  }
}
