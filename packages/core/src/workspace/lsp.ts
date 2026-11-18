// Minimal stdio LSP client: navigation (definition / references / hover) and
// push diagnostics (`textDocument/publishDiagnostics`) for post-edit checks.
//
// One server per (command, workspace root), spawned lazily and reused (Content-
// Length framed JSON-RPC). Fail-soft (returns "not available"); selection via `lsp.servers`.

import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import type { Diagnostic, DiagnosticsProvider } from "../tools/diagnostics.js";

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

/** TypeScript 7+ ships a native language server (`tsc --lsp --stdio`) and no
 * `tsserver.js`, which `typescript-language-server` needs. Returns that server
 * when `root` has such a TypeScript installed locally. */
export function nativeTypeScriptServer(root: string): LspServerConfig | null {
  const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (!existsSync(tsc)) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "node_modules", "typescript", "package.json"), "utf-8")) as {
      version?: string;
    };
    const major = Number((pkg.version ?? "").split(".")[0]);
    if (!(major >= 7)) return null;
  } catch {
    return null;
  }
  return { command: tsc, args: ["--lsp", "--stdio"], languages: DEFAULT_LSP_SERVERS[0]!.languages };
}

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

/** PATH for a server rooted at `root`: the project's `node_modules/.bin` first,
 * so a locally installed `typescript-language-server` is found. */
export function lspPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return [join(root, "node_modules", ".bin"), env.PATH ?? ""].filter(Boolean).join(delimiter);
}

/** Whether `command` resolves to an executable on PATH (or is an existing path). */
export function commandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isAbsolute(command) || command.includes("/")) return existsSync(command);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, command + ext))) return true;
  }
  return false;
}

const SEVERITY: Record<number, Diagnostic["severity"]> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** Convert one LSP `Diagnostic` (0-based) into the tool's 1-based shape. */
export function toDiagnostic(d: {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
  code?: string | number | { value: string | number };
}): Diagnostic {
  const code = typeof d.code === "object" && d.code !== null ? d.code.value : d.code;
  return {
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    endLine: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    severity: SEVERITY[d.severity ?? 1] ?? "error",
    message: d.message,
    ...(d.source ? { source: d.source } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

interface PublishedDiagnostics {
  /** Document version the server reported, when it supports versioning. */
  version?: number;
  /** Monotonic arrival counter, to tell "published after our sync" apart. */
  seq: number;
  items: Diagnostic[];
}

/** Quiet period after a publish before the result counts as settled: servers
 * like pyright and rust-analyzer publish a fast pass and then a fuller one. */
const DIAGNOSTICS_SETTLE_MS = 250;

/** One language-server process bound to a workspace root. */
class LspServer {
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private initialized: Promise<void> | null = null;
  /** Set when the process failed to spawn or died during startup; further
   * requests fail fast instead of respawning on every edit. */
  private broken: Error | null = null;
  private readonly published = new Map<string, PublishedDiagnostics>();
  private publishSeq = 0;
  private readonly publishWaiters = new Set<() => void>();
  /** Server advertised `diagnosticProvider` (LSP 3.17 pull diagnostics). */
  private pullDiagnostics = false;
  // uri → the last text+version we synced to the server. A Map (not a Set) so
  // we can detect that the file changed on disk since we opened it and push a
  // `didChange` — otherwise the server answers position requests against a
  // stale copy (wrong line/column) after the agent edits the file.
  private readonly openDocs = new Map<string, { version: number; text: string }>();

  constructor(
    private readonly config: LspServerConfig,
    private readonly rootPath: string,
  ) {}

  private spawnProc(): void {
    const proc = spawn(this.config.command, this.config.args ?? ["--stdio"], {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: lspPath(this.rootPath) },
    });
    this.proc = proc;
    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr!.on("data", () => {
      /* language servers are noisy on stderr; ignore */
    });
    // A server that failed to spawn (ENOENT) or died emits EPIPE on writes;
    // without a listener that would be an uncaught 'error' event.
    proc.stdin!.on("error", () => undefined);
    proc.on("error", (err) => {
      this.broken = err;
      this.failAll(err);
    });
    proc.on("exit", () => {
      this.failAll(new Error(`LSP server "${this.config.command}" exited`));
      this.proc = null;
      this.initialized = null;
      this.openDocs.clear();
      this.published.clear();
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
    if (msg.method === "textDocument/publishDiagnostics" && msg.id === undefined) {
      const p = msg.params as { uri?: string; version?: number; diagnostics?: unknown[] } | undefined;
      if (p?.uri && Array.isArray(p.diagnostics)) {
        const items: Diagnostic[] = [];
        for (const d of p.diagnostics) {
          try {
            items.push(toDiagnostic(d as Parameters<typeof toDiagnostic>[0]));
          } catch {
            /* skip malformed */
          }
        }
        this.published.set(p.uri, {
          ...(typeof p.version === "number" ? { version: p.version } : {}),
          seq: ++this.publishSeq,
          items,
        });
        for (const w of [...this.publishWaiters]) w();
      }
      return;
    }
    const id = msg.id;
    if (typeof id === "number" && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // Server-initiated request: answer the few we must, ignore notifications.
    // Ids may be strings (tsgo sends "ts1"); an unanswered request stalls it.
    if ((typeof id === "number" || typeof id === "string") && typeof msg.method === "string") {
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
    if (this.broken) return Promise.reject(this.broken);
    if (this.initialized) return this.initialized;
    if (!this.proc) this.spawnProc();
    const rootUri = pathToFileURL(this.rootPath).toString();
    this.initialized = (async () => {
      const init = (await this.request("initialize", {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "root" }],
        initializationOptions: this.config.initializationOptions,
        capabilities: {
          textDocument: {
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ["plaintext", "markdown"] },
            synchronization: { didOpen: true, didChange: true, didClose: true, didSave: true },
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: false },
          },
        },
      })) as { capabilities?: { diagnosticProvider?: unknown } } | null;
      this.pullDiagnostics = Boolean(init?.capabilities?.diagnosticProvider);
      this.notify("initialized", {});
    })();
    return this.initialized;
  }

  /** Open a document (or re-sync it if it changed on disk) so position
   * requests resolve against the CURRENT file. Servers like
   * typescript-language-server need the document open before they answer
   * position requests; and after the agent edits the file, the server's copy
   * must be updated (`didChange`) or navigation resolves stale line/columns. */
  private async openDoc(
    path: string,
    languageId: string,
  ): Promise<{ uri: string; version: number; synced: boolean }> {
    const uri = pathToFileURL(path).toString();
    const text = await readFile(path, "utf-8").catch(() => "");
    const prev = this.openDocs.get(uri);
    if (!prev) {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      this.openDocs.set(uri, { version: 1, text });
      return { uri, version: 1, synced: true };
    }
    if (prev.text !== text) {
      // Full-document sync: resend the whole text with an incremented version.
      const version = prev.version + 1;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
      // Some servers (e.g. rust-analyzer's check-on-save) only re-run their
      // checks on save; the agent's write already hit disk.
      this.notify("textDocument/didSave", { textDocument: { uri } });
      this.openDocs.set(uri, { version, text });
      return { uri, version, synced: true };
    }
    return { uri, version: prev.version, synced: false };
  }

  /**
   * Diagnostics for `path` as of its current on-disk content. Waits (up to
   * `timeoutMs`) for the server to publish for the synced version, then for a
   * short quiet period. Null when nothing fresh arrived in time.
   */
  async diagnostics(path: string, languageId: string, timeoutMs: number): Promise<Diagnostic[] | null> {
    await this.ensureInitialized();
    const seqBefore = this.publishSeq;
    const { uri, version, synced } = await this.openDoc(path, languageId);
    if (this.pullDiagnostics) return this.pull(uri, timeoutMs);
    const cached = this.published.get(uri);
    if (!synced && cached) return cached.items;
    const isFresh = (p: PublishedDiagnostics | undefined): p is PublishedDiagnostics =>
      p !== undefined && p.seq > seqBefore && (p.version === undefined || p.version >= version);
    return new Promise((resolveResult) => {
      let settle: ReturnType<typeof setTimeout> | undefined;
      const finish = (v: Diagnostic[] | null): void => {
        clearTimeout(deadline);
        clearTimeout(settle);
        this.publishWaiters.delete(check);
        resolveResult(v);
      };
      const check = (): void => {
        if (!isFresh(this.published.get(uri))) return;
        clearTimeout(settle);
        settle = setTimeout(() => finish(this.published.get(uri)?.items ?? null), DIAGNOSTICS_SETTLE_MS);
      };
      const deadline = setTimeout(() => {
        const p = this.published.get(uri);
        finish(isFresh(p) ? p.items : null);
      }, timeoutMs);
      this.publishWaiters.add(check);
      check();
    });
  }

  private async pull(uri: string, timeoutMs: number): Promise<Diagnostic[] | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), timeoutMs);
    });
    try {
      const res = (await Promise.race([
        this.request("textDocument/diagnostic", { textDocument: { uri } }),
        timeout,
      ])) as { kind?: string; items?: unknown[] } | null;
      if (!res || res.kind !== "full" || !Array.isArray(res.items)) return null;
      const items = res.items.map((d) => toDiagnostic(d as Parameters<typeof toDiagnostic>[0]));
      this.published.set(uri, { seq: ++this.publishSeq, items });
      return items;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every diagnostic this server has published so far, keyed by file path. */
  allPublished(): { path: string; diagnostics: Diagnostic[] }[] {
    const out: { path: string; diagnostics: Diagnostic[] }[] = [];
    for (const [uri, p] of this.published) {
      if (p.items.length === 0) continue;
      let path: string;
      try {
        path = fileURLToPath(uri);
      } catch {
        path = uri;
      }
      out.push({ path, diagnostics: p.items });
    }
    return out;
  }

  async navigate(
    kind: "definition" | "references" | "hover",
    path: string,
    languageId: string,
    pos: LspPosition,
  ): Promise<unknown> {
    await this.ensureInitialized();
    const { uri } = await this.openDoc(path, languageId);
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
      // A server that never answers `shutdown` must not hang session close.
      await Promise.race([
        this.request("shutdown", null).catch(() => undefined),
        new Promise((r) => setTimeout(r, 1000).unref()),
      ]);
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
    this.published.clear();
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
  private readonly usingDefaults: boolean;
  private readonly nativeTs = new Map<string, LspServerConfig | null>();

  constructor(configs?: LspServerConfig[]) {
    this.usingDefaults = !(configs && configs.length > 0);
    this.configs = this.usingDefaults ? DEFAULT_LSP_SERVERS : configs!;
  }

  /** The server config that handles this file's language, or null. With the
   * built-in defaults and a `root`, a project-local TypeScript 7+ replaces
   * `typescript-language-server`. */
  configFor(path: string, root?: string): { config: LspServerConfig; languageId: string } | null {
    const languageId = languageIdForPath(path);
    if (!languageId) return null;
    if (this.usingDefaults && root !== undefined) {
      if (!this.nativeTs.has(root)) this.nativeTs.set(root, nativeTypeScriptServer(root));
      const native = this.nativeTs.get(root);
      if (native?.languages.includes(languageId)) return { config: native, languageId };
    }
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
    const match = this.configFor(path, root);
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

  /**
   * Diagnostics for one file from its language server, waiting for a fresh
   * publish after syncing the current content. Null when no server handles
   * the language, the server is not installed, or it did not answer in time.
   */
  async diagnostics(root: string, path: string, timeoutMs: number): Promise<Diagnostic[] | null> {
    const match = this.configFor(path, root);
    if (!match || !commandOnPath(match.config.command, { ...process.env, PATH: lspPath(root) })) return null;
    try {
      return await this.serverFor(match.config, root).diagnostics(path, match.languageId, timeoutMs);
    } catch {
      return null;
    }
  }

  /** A DiagnosticsProvider over this manager, resolving relative paths against `root()`. */
  provider(root: () => string, timeoutMs: number): DiagnosticsProvider {
    return {
      forFile: (path) => this.diagnostics(root(), resolve(root(), path), timeoutMs),
      forWorkspace: async () => {
        const all = [...this.servers.values()].flatMap((s) => s.allPublished());
        return all.length > 0 ? all : null;
      },
    };
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.servers.values()].map((s) => s.stop().catch(() => undefined)));
    this.servers.clear();
  }
}
