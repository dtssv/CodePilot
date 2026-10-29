// Minimal stdio LSP client for navigation (go-to-definition / find-references
// / hover). This gives the agent precise symbol navigation in large repos
// instead of guessing with grep.
//
// Scope, deliberately small:
// - One language server process per (server command, workspace root), spawned
//   lazily on first use and reused. Content-Length framed JSON-RPC over stdio
//   (the LSP wire format — NOT the NDJSON that MCP uses).
// - We `initialize` + `initialized`, then for each query open the target file
//   with `textDocument/didOpen` (servers like typescript-language-server need
//   the document open before they answer position requests) and issue the
//   navigation request.
// - Best-effort and fail-soft: if no server is configured for the file's
//   language, or the binary isn't installed, the caller returns a clear
//   "not available" message instead of throwing.
//
// Server selection is config-driven (`lsp.servers`): the host maps a language
// id (derived from the file extension) to a spawn command. We ship sensible
// built-in defaults for TypeScript/JavaScript so it works out of the box when
// `typescript-language-server` is resolvable.

import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export interface LspServerConfig {
  /** Command to spawn (e.g. "typescript-language-server" or "npx"). */
  command: string;
  /** Arguments (e.g. ["--stdio"] or ["--no-install","typescript-language-server","--stdio"]). */
  args?: string[];
  /** Language ids this server handles (e.g. ["typescript","javascript"]). */
  languages: string[];
  /** Server-specific `initializationOptions` passed verbatim to `initialize`
   * (e.g. `{ tsserver: { path } }` to pin a TypeScript install). */
  initializationOptions?: Record<string, unknown>;
}

/** Map a file path to an LSP languageId. Extend as servers are added. */
export function languageIdForPath(path: string): string | null {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    default:
      return null;
  }
}

/** Built-in server defaults, used when the user configures none. Covers the
 * common languages (TS/JS, Python, Go, Rust) via their standard language
 * servers; a server that isn't installed simply fails to spawn and that
 * language's diagnostics/navigation degrade gracefully. Override or extend
 * via `lsp.servers` config. */
export const DEFAULT_LSP_SERVERS: LspServerConfig[] = [
  {
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
  },
  {
    command: "pyright-langserver",
    args: ["--stdio"],
    languages: ["python"],
  },
  {
    command: "gopls",
    args: [],
    languages: ["go"],
  },
  {
    command: "rust-analyzer",
    args: [],
    languages: ["rust"],
  },
];

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** A 0-based LSP position. */
export interface LspPosition {
  line: number;
  character: number;
}

/** A resolved navigation location (1-based for human/agent display). */
export interface LspLocation {
  path: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

/** One language-server process bound to a workspace root. */
class LspServer {
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private initialized: Promise<void> | null = null;
  private readonly openDocs = new Set<string>();

  constructor(
    private readonly config: LspServerConfig,
    private readonly rootPath: string,
  ) {}

  private spawnProc(): void {
    const proc = spawn(this.config.command, this.config.args ?? ["--stdio"], {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr!.on("data", () => {
      /* language servers are noisy on stderr; ignore */
    });
    proc.on("error", (err) => this.failAll(err));
    proc.on("exit", () => {
      this.failAll(new Error(`LSP server "${this.config.command}" exited`));
      this.proc = null;
      this.initialized = null;
      this.openDocs.clear();
    });
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Content-Length framed read loop. */
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Unparseable header — drop up to the separator and resync.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return; // wait for more
      const body = this.buffer.subarray(bodyStart, bodyStart + len).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + len);
      try {
        this.onMessage(JSON.parse(body) as Record<string, unknown>);
      } catch {
        /* skip malformed */
      }
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id === "number" && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // Server-initiated request: answer the few we must, ignore notifications.
    if (typeof id === "number" && typeof msg.method === "string") {
      // Reply with a null result so the server doesn't block (e.g.
      // workspace/configuration, client/registerCapability).
      this.sendRaw({ jsonrpc: "2.0", id, result: null });
    }
  }

  private sendRaw(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin) return;
    const body = JSON.stringify(msg);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialized) return this.initialized;
    if (!this.proc) this.spawnProc();
    const rootUri = pathToFileURL(this.rootPath).toString();
    this.initialized = (async () => {
      await this.request("initialize", {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "root" }],
        initializationOptions: this.config.initializationOptions,
        capabilities: {
          textDocument: {
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ["plaintext", "markdown"] },
            synchronization: { didOpen: true, didClose: true },
          },
        },
      });
      this.notify("initialized", {});
    })();
    return this.initialized;
  }

  /** Open a document so position requests resolve (idempotent per uri). */
  private async openDoc(path: string, languageId: string): Promise<string> {
    const uri = pathToFileURL(path).toString();
    if (this.openDocs.has(uri)) return uri;
    const text = await readFile(path, "utf-8").catch(() => "");
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.openDocs.add(uri);
    return uri;
  }

  async navigate(
    kind: "definition" | "references" | "hover",
    path: string,
    languageId: string,
    pos: LspPosition,
  ): Promise<unknown> {
    await this.ensureInitialized();
    const uri = await this.openDoc(path, languageId);
    const base = { textDocument: { uri }, position: pos };
    const method =
      kind === "definition"
        ? "textDocument/definition"
        : kind === "references"
          ? "textDocument/references"
          : "textDocument/hover";
    const params =
      kind === "references" ? { ...base, context: { includeDeclaration: true } } : base;
    return this.request(method, params);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.request("shutdown", null).catch(() => undefined);
      this.notify("exit", null);
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.initialized = null;
    this.openDocs.clear();
  }
}

/** Convert an LSP Location / LocationLink / Hover result into flat locations. */
export function parseLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    // Location { uri, range } or LocationLink { targetUri, targetRange }.
    const uri = (o.uri ?? o.targetUri) as string | undefined;
    const range = (o.range ?? o.targetRange) as { start?: LspPosition } | undefined;
    if (!uri || !range?.start) continue;
    let p: string;
    try {
      p = fileURLToPath(uri);
    } catch {
      p = uri;
    }
    out.push({ path: p, line: range.start.line + 1, column: range.start.character + 1 });
  }
  return out;
}

/** Manages language-server processes, one per (command, root). */
export class LspManager {
  private readonly servers = new Map<string, LspServer>();
  private readonly configs: LspServerConfig[];

  constructor(configs?: LspServerConfig[]) {
    this.configs = configs && configs.length > 0 ? configs : DEFAULT_LSP_SERVERS;
  }

  /** The server config that handles this file's language, or null. */
  configFor(path: string): { config: LspServerConfig; languageId: string } | null {
    const languageId = languageIdForPath(path);
    if (!languageId) return null;
    const config = this.configs.find((c) => c.languages.includes(languageId));
    return config ? { config, languageId } : null;
  }

  private serverFor(config: LspServerConfig, root: string): LspServer {
    const key = `${config.command} ${(config.args ?? []).join(" ")}::${root}`;
    let s = this.servers.get(key);
    if (!s) {
      s = new LspServer(config, root);
      this.servers.set(key, s);
    }
    return s;
  }

  async navigate(
    kind: "definition" | "references" | "hover",
    root: string,
    path: string,
    pos: LspPosition,
  ): Promise<{ ok: true; result: unknown; languageId: string } | { ok: false; reason: string }> {
    const match = this.configFor(path);
    if (!match) {
      return { ok: false, reason: `no LSP server configured for ${extname(path) || "this file type"}` };
    }
    try {
      const server = this.serverFor(match.config, root);
      const result = await server.navigate(kind, path, match.languageId, pos);
      return { ok: true, result, languageId: match.languageId };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.servers.values()].map((s) => s.stop().catch(() => undefined)));
    this.servers.clear();
  }
}
