// MCP stdio transport: JSON-RPC 2.0 over newline-delimited JSON on a child
// process's stdout. The historical transport, used by most existing servers.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { BaseJsonRpcClient } from "./mcp-jsonrpc.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp-jsonrpc.js";
import type { McpStdioServerConfig, McpTransportContext } from "./mcp-types.js";
import { resolveSandbox, shellQuote, wrapCommand } from "../sandbox/sandbox.js";

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

/** Parent variables every stdio server gets: process basics, locale, temp
 * dirs, proxy and CA settings. Matched case-insensitively (Windows). */
const BASELINE_ENV = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ", "TMPDIR", "TMP", "TEMP",
  "__CF_USER_TEXT_ENCODING", "NVM_DIR", "NVM_BIN",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "USERNAME", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
  "PROGRAMFILES(X86)", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
]);
const BASELINE_PREFIXES = ["LC_", "XDG_"];

/**
 * Environment for a stdio MCP server: the full parent environment plus the
 * explicit `env` map. With `inheritEnv: false` only the baseline allowlist and
 * the variables named in `envPassthrough` are inherited, so provider API keys
 * and tokens stay out of the server unless asked for by name.
 */
export function mcpChildEnv(
  config: Pick<McpStdioServerConfig, "env" | "envPassthrough" | "inheritEnv">,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (config.inheritEnv !== false) {
    const env: NodeJS.ProcessEnv = { ...parent };
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = augmentedPath(parent[pathKey]);
    return { ...env, ...(config.env ?? {}) };
  }
  const passthrough = new Set((config.envPassthrough ?? []).map((n) => n.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    const key = k.toUpperCase();
    if (BASELINE_ENV.has(key) || passthrough.has(key) || BASELINE_PREFIXES.some((p) => key.startsWith(p))) {
      env[k] = v;
    }
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = augmentedPath(parent[pathKey]);
  return { ...env, ...(config.env ?? {}) };
}

/** Package-manager and browser caches that `npx`/`uvx`/`bunx`-launched servers
 * write to on startup; writable inside the MCP sandbox. */
function mcpCacheDirs(): string[] {
  const h = homedir();
  return [
    join(h, ".npm"),
    join(h, ".cache"),
    join(h, ".bun"),
    join(h, ".yarn"),
    join(h, ".pnpm-store"),
    join(h, ".local", "share", "pnpm"),
    join(h, ".local", "share", "uv"),
    join(h, ".local", "state"),
    join(h, ".deno"),
    join(h, "Library", "Caches"),
    join(h, "Library", "pnpm"),
  ];
}

export interface McpSpawnSpec {
  file: string;
  args: string[];
  /** Sandbox backend the server runs under, or null when unsandboxed. */
  sandbox: string | null;
}

/**
 * How to launch a stdio server. Servers run unsandboxed by default; one opted
 * in (`sandbox: true` / `{ writablePaths }`, or every server via `mcpSandbox`)
 * runs inside the OS sandbox unless the session sandbox is off or no backend
 * can enforce it. Network stays open (servers talk to their APIs); writes are
 * confined to the workspace, temp and package caches; credential paths are
 * unreadable. Windows is skipped: the WSL jail cannot run a Windows executable.
 */
export function mcpSpawnSpec(config: McpStdioServerConfig, ctx?: McpTransportContext): McpSpawnSpec {
  const plain: McpSpawnSpec = { file: config.command!, args: config.args ?? [], sandbox: null };
  const sb = ctx?.sandbox;
  if (!ctx || !sb || !mcpWantsSandbox(config, ctx) || process.platform === "win32") return plain;
  const extra = (typeof config.sandbox === "object" ? (config.sandbox.writablePaths ?? []) : []).map((p) =>
    p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p,
  );
  const policy = resolveSandbox(
    {
      ...sb,
      mode: "workspace-write",
      network: true,
      fallback: "allow-unsandboxed",
      writablePaths: [...(sb.writablePaths ?? []), ...mcpCacheDirs(), ...extra],
    },
    ctx.cwd,
  );
  const line = ["exec", ...[config.command!, ...(config.args ?? [])].map(shellQuote)].join(" ");
  const wrapped = wrapCommand(line, policy);
  if (!wrapped.sandboxed) return plain;
  return {
    file: wrapped.shell ?? "/bin/sh",
    args: [...(wrapped.shellArgs ?? ["-c"]), wrapped.command],
    sandbox: wrapped.backend,
  };
}

/** Whether `mcpSpawnSpec` may sandbox this server (pool keys must then include
 * the cwd and sandbox config the policy is derived from). */
export function mcpWantsSandbox(config: McpStdioServerConfig, ctx?: McpTransportContext): boolean {
  if (!ctx?.sandbox || ctx.sandbox.mode === "off" || !config.command) return false;
  if (config.sandbox === false) return false;
  return config.sandbox !== undefined || ctx.mcpSandbox === true;
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
    private readonly config: McpStdioServerConfig,
    private readonly ctx?: McpTransportContext,
  ) {
    super();
  }

  /** Spawn the child and wire its stdio. Shared by start() and reconnect. */
  private spawnProc(): void {
    const spec = mcpSpawnSpec(this.config, this.ctx);
    const proc = spawn(spec.file, spec.args, {
      env: mcpChildEnv(this.config),
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
