// MCP stdio transport: JSON-RPC 2.0 over newline-delimited JSON on a child
// process's stdout. The historical transport, used by most existing servers.

import { spawn, type ChildProcess } from "node:child_process";
import { BaseJsonRpcClient } from "./mcp-jsonrpc.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp-jsonrpc.js";
import type { McpStdioServerConfig } from "./mcp-types.js";

/** Spawn `command` with `args`, talk JSON-RPC over its stdio. */
export class McpStdioClient extends BaseJsonRpcClient {
  private proc: ChildProcess | null = null;
  private buffer = "";

  constructor(
    public readonly serverName: string,
    private readonly config: McpStdioServerConfig
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.proc) return;
    if (!this.config.command) {
      throw new Error(
        `MCP stdio server ${this.serverName}: command is required (use type "http" or "sse" with a url for remote servers)`
      );
    }
    const command = this.config.command;
    const proc = spawn(command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
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
    await this.handshakeAndDiscover();
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
