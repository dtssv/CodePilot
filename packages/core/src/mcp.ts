// Minimal MCP stdio client (JSON-RPC 2.0 over newline-delimited JSON).
// Implements the lifecycle methods we need: initialize, tools/list, tools/call.
// Tools discovered from MCP servers are exposed under the `mcp__<server>__<tool>`
// naming scheme to avoid collisions with built-in tools.
//
// This is a focused, working subset of the MCP spec — enough to plug an MCP
// server into the tool registry. SSE transport and other capabilities are not
// implemented; the surface is documented inline for future expansion.

import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfig } from "./types.js";

export interface McpToolDescriptor {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpInvokeRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpInvokeResult {
  content: string;
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

export class McpStdioClient {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly serverName: string;
  private serverInfo: { name: string; version?: string } | null = null;
  private tools: McpToolDescriptor[] = [];

  constructor(
    serverName: string,
    private readonly config: McpServerConfig
  ) {
    this.serverName = serverName;
  }

  /** Start the subprocess and complete MCP `initialize` handshake. */
  async start(): Promise<void> {
    if (this.proc) return;
    const proc = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", (chunk: string) => {
      // MCP servers log to stderr; surface as warning.
      process.stderr.write(`[mcp:${this.serverName}] ${chunk}`);
    });
    proc.on("exit", (code) => {
      this.failAllPending(
        new Error(`MCP server ${this.serverName} exited (code ${code})`)
      );
      this.proc = null;
    });

    const init = (await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codepilot", version: "2.0.0" },
    })) as { serverInfo?: { name: string; version?: string } };
    if (init.serverInfo) this.serverInfo = init.serverInfo;

    // Send notifications/initialized (no response expected).
    this.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    } as unknown as JsonRpcRequest);

    await this.refreshTools();
  }

  listTools(): McpToolDescriptor[] {
    return this.tools.slice();
  }

  async invoke(req: McpInvokeRequest): Promise<McpInvokeResult> {
    const result = (await this.request("tools/call", {
      name: req.name,
      arguments: req.arguments ?? {},
    })) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      isError?: boolean;
    };
    if (!result || !Array.isArray(result.content)) {
      return { content: "(empty MCP response)", isError: true };
    }
    const text = result.content
      .map((c) => (c.type === "text" ? c.text ?? "" : JSON.stringify(c)))
      .join("\n");
    return { content: text, isError: result.isError };
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

  private async refreshTools(): Promise<void> {
    const res = (await this.request("tools/list", {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    if (!res.tools) {
      this.tools = [];
      return;
    }
    this.tools = res.tools.map((t) => ({
      server: this.serverName,
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  private send(msg: JsonRpcRequest): void {
    if (!this.proc || !this.proc.stdin) {
      throw new Error(`MCP ${this.serverName} is not running`);
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send(msg);
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
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
      if (msg.id === undefined || msg.id === null) {
        // notification — ignore for now (we don't subscribe to resources/list etc.)
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}

/** Manager owning one client per configured MCP server. */
export class McpManager {
  private readonly clients = new Map<string, McpStdioClient>();

  constructor(private readonly configs: Record<string, McpServerConfig> = {}) {}

  async startAll(): Promise<void> {
    await Promise.all(
      Object.entries(this.configs).map(async ([name, cfg]) => {
        const c = new McpStdioClient(name, cfg);
        try {
          await c.start();
          this.clients.set(name, c);
        } catch (err) {
          process.stderr.write(
            `[mcp] failed to start ${name}: ${(err as Error).message}\n`
          );
        }
      })
    );
  }

  listAllTools(): McpToolDescriptor[] {
    const out: McpToolDescriptor[] = [];
    for (const c of this.clients.values()) out.push(...c.listTools());
    return out;
  }

  async invoke(
    server: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<McpInvokeResult> {
    const c = this.clients.get(server);
    if (!c) throw new Error(`unknown MCP server: ${server}`);
    return c.invoke({ name, arguments: args });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
    this.clients.clear();
  }
}

/** Build the canonical `mcp__<server>__<tool>` name. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Parse an `mcp__<server>__<tool>` name back into its parts. */
export function parseMcpToolName(
  name: string
): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const idx = rest.indexOf("__");
  if (idx < 0) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}
