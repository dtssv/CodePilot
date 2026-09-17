/**
 * WebSocket transport for the headless protocol (ROADMAP-NEXT §4.3 Phase 1).
 *
 * Same JSON-RPC 2.0 protocol as stdio (docs/PROTOCOL.md) — only the byte
 * carrier differs, so browsers can talk to a local CodePilot without a
 * subprocess. Each connection gets its own `Peer` + server registration, so
 * two browser tabs are two independent clients with independent session maps;
 * a reconnecting tab recovers its state with `session/resume`.
 *
 * ## Security
 *
 * This opens a network port in front of an agent that can run shell commands.
 * Anything that can complete the handshake can run code as the user, so the
 * defaults are deliberately restrictive:
 *
 *  - **Loopback only.** Binds `127.0.0.1` unless `host` says otherwise.
 *  - **Bearer token.** A random token is generated when none is supplied and
 *    every upgrade must present it (`?token=` or `Authorization: Bearer`).
 *    Compared in constant time. `auth: "none"` disables this and is only for
 *    tests and trusted-network setups.
 *  - **Origin allowlist.** WebSocket upgrades are NOT subject to CORS: any
 *    web page can open a socket to localhost. Without an origin check, a page
 *    the user visits could drive their agent (a token in the URL of a page
 *    they opened would be enough). Requests carrying no `Origin` (non-browser
 *    clients) pass; a browser origin must be on the allowlist.
 *
 * Rejections happen during the HTTP upgrade with a real status code (401 /
 * 403), so a misconfigured client gets a diagnosable failure instead of an
 * opaque socket close.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { Peer, type RpcTransport } from "./rpc.js";
import { registerServer, type ServerHandle, type ServerOptions } from "./server.js";

/**
 * `RpcTransport` over a single WebSocket.
 *
 * The wire contract stays NDJSON-shaped: `Peer` writes one JSON document per
 * `write()` (with a trailing newline, which we strip — WebSocket already
 * frames messages). Inbound messages are split on newlines so a client that
 * batches several documents into one frame still works.
 */
export class WebSocketTransport implements RpcTransport {
  private readonly queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private ended = false;

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data: unknown, isBinary?: boolean) => {
      // Binary frames are not part of the protocol; ignoring them keeps a
      // stray frame from desynchronising the JSON-RPC stream.
      if (isBinary) return;
      this.push(toText(data));
    });
    socket.on("close", () => this.end());
    socket.on("error", () => this.end());
  }

  write(line: string): void {
    if (this.ended) throw new Error("websocket transport closed");
    const payload = line.endsWith("\n") ? line.slice(0, -1) : line;
    this.socket.send(payload);
  }

  readLine(): Promise<string | null> {
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.ended) return Promise.resolve(null);
    if (this.waiter) return Promise.reject(new Error("readLine re-entered"));
    return new Promise<string | null>((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    if (this.ended) return;
    this.end();
    try {
      this.socket.close(1000, "server closing");
    } catch {
      /* already gone */
    }
  }

  private push(text: string): void {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      this.queue.push(line);
    }
    this.drain();
  }

  private drain(): void {
    if (!this.waiter) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    const w = this.waiter;
    this.waiter = null;
    w(next);
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    // Deliver anything already buffered first; the waiter only learns about
    // EOF once the queue is empty.
    this.drain();
    if (this.waiter && this.queue.length === 0) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }
}

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface WebSocketServerOptions extends ServerOptions {
  /** Port to listen on. 0 picks a free one (read it back from the handle). */
  port?: number;
  /** Interface to bind. Default `127.0.0.1` — see the security notes above. */
  host?: string;
  /**
   * Shared secret every upgrade must present, as `?token=<t>` or
   * `Authorization: Bearer <t>`. Generated randomly when omitted. Set
   * `auth: "none"` to disable the check entirely (tests / trusted networks).
   */
  token?: string;
  auth?: "token" | "none";
  /**
   * Extra browser origins allowed to connect, e.g. a Vite dev server on
   * `http://localhost:5173`. `http://localhost:<port>` and
   * `http://127.0.0.1:<port>` are always allowed. Use `"*"` to accept any
   * origin — that removes the only defence against a malicious page driving
   * this agent, so pair it with `auth: "token"` and a token that never
   * reaches a browser you do not control.
   */
  allowedOrigins?: string[];
  /** Ping interval in ms for dropping dead sockets. Default 30_000; 0 disables. */
  heartbeatMs?: number;
  /**
   * Refuse connections beyond this many concurrent clients. Each client can
   * start its own agent loops, so this is a resource bound, not politeness.
   * Default 16.
   */
  maxConnections?: number;
  /** Called whenever a client connects or disconnects (for CLI logging). */
  onConnection?: (info: { count: number; remote?: string }) => void;
  /**
   * Optional directory of static assets to serve over plain HTTP GET —
   * the built web SPA (`apps/web/dist`) for the `codepilot serve --web`
   * deployment mode (ROADMAP-NEXT §4.3 Phase 4). When unset, GET requests
   * get a 426 telling the client to upgrade. When set, requests are served
   * from this directory with an SPA fallback (unknown extensionless paths
   * resolve to `index.html`). Path traversal outside the root is rejected.
   * Static GETs are NOT token-gated (the SPA itself is not sensitive — the
   * token gates the WebSocket handshake, which is what can run commands).
   */
  staticRoot?: string;
}

export interface WebSocketServerHandle {
  /** The bound port (useful when `port: 0` was requested). */
  readonly port: number;
  readonly host: string;
  /** The token clients must present, or undefined when auth is disabled. */
  readonly token?: string;
  /** `ws://host:port` plus the token query when auth is enabled. */
  readonly url: string;
  /** Number of live client connections. */
  connectionCount(): number;
  /** Stop listening and tear down every connection's sessions. */
  close(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 16;

/**
 * Start an HTTP server that accepts WebSocket upgrades and — when
 * `staticRoot` is set — serves the built web SPA over plain GET. The
 * upgrade path is not significant (the advertised URL uses `/rpc`); what
 * gates a connection is the origin + token check in {@link checkUpgrade}.
 */
export async function startWebSocketServer(
  opts: WebSocketServerOptions = {},
): Promise<WebSocketServerHandle> {
  const host = opts.host ?? DEFAULT_HOST;
  const authMode = opts.auth ?? "token";
  const token =
    authMode === "none" ? undefined : opts.token ?? randomBytes(24).toString("hex");
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  const staticRoot = opts.staticRoot ? resolve(opts.staticRoot) : undefined;

  const http = createServer((req, res) => {
    if (staticRoot && (req.method === "GET" || req.method === "HEAD")) {
      void serveStatic(staticRoot, req, res);
      return;
    }
    // This server speaks WebSocket only; a plain GET is a misconfigured
    // client (or someone poking the port) and gets told so.
    res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
    res.end("This endpoint requires a WebSocket upgrade (CodePilot protocol).\n");
  });
  const wss = new WebSocketServer({ noServer: true });

  const connections = new Set<{ socket: WebSocket; handle: ServerHandle; alive: boolean }>();

  http.on("upgrade", (req, socket, head) => {
    const port = boundPort(http);
    const verdict = checkUpgrade(req, {
      token,
      allowedOrigins: opts.allowedOrigins,
      port,
      atCapacity: connections.size >= maxConnections,
    });
    if (!verdict.ok) {
      rejectUpgrade(socket, verdict.status, verdict.reason);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      acceptConnection(ws, req);
    });
  });

  function acceptConnection(ws: WebSocket, req: IncomingMessage): void {
    const transport = new WebSocketTransport(ws);
    const peer = new Peer({ transport, debug: false });
    const handle = registerServer(peer, opts);
    void peer.loopDone.catch(() => {});
    const entry = { socket: ws, handle, alive: true };
    connections.add(entry);
    opts.onConnection?.({ count: connections.size, remote: req.socket.remoteAddress ?? undefined });

    ws.on("pong", () => {
      entry.alive = true;
    });
    const cleanup = (): void => {
      if (!connections.delete(entry)) return;
      // A browser tab can vanish without a close frame, leaving sessions
      // running with no listener — dispose them here, not only on `shutdown`.
      void handle.dispose().catch(() => {});
      void peer.close().catch(() => {});
      opts.onConnection?.({ count: connections.size, remote: req.socket.remoteAddress ?? undefined });
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const entry of connections) {
            if (!entry.alive) {
              // Missed the previous round trip: terminate (not close) so a
              // half-open socket cannot hold sessions open indefinitely.
              entry.socket.terminate();
              continue;
            }
            entry.alive = false;
            try {
              entry.socket.ping();
            } catch {
              entry.socket.terminate();
            }
          }
        }, heartbeatMs)
      : null;
  heartbeat?.unref();

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 0, host, () => {
      http.removeListener("error", reject);
      resolve();
    });
  });

  const port = boundPort(http);
  const url = `ws://${host}:${port}/rpc${token ? `?token=${token}` : ""}`;

  return {
    port,
    host,
    token,
    url,
    connectionCount: () => connections.size,
    close: async () => {
      if (heartbeat) clearInterval(heartbeat);
      const entries = [...connections];
      connections.clear();
      for (const e of entries) {
        await e.handle.dispose().catch(() => {});
        await e.handle.close().catch(() => {});
        e.socket.terminate();
      }
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function boundPort(server: Server): number {
  const addr = server.address();
  return typeof addr === "object" && addr !== null ? addr.port : 0;
}

interface UpgradeCheck {
  token?: string;
  allowedOrigins?: string[];
  port: number;
  atCapacity: boolean;
}

export type UpgradeVerdict =
  | { ok: true }
  | { ok: false; status: number; reason: string };

/**
 * Decide whether an upgrade request may become a client. Exported for tests —
 * each rejection here is a security boundary, not a nicety.
 */
export function checkUpgrade(
  req: IncomingMessage,
  check: UpgradeCheck,
): UpgradeVerdict {
  if (check.atCapacity) {
    return { ok: false, status: 503, reason: "too many connections" };
  }
  if (!originAllowed(req.headers.origin, check.allowedOrigins, check.port)) {
    return {
      ok: false,
      status: 403,
      reason: `origin not allowed: ${String(req.headers.origin)}`,
    };
  }
  if (check.token !== undefined && !tokenMatches(req, check.token)) {
    return { ok: false, status: 401, reason: "missing or invalid token" };
  }
  return { ok: true };
}

/**
 * A browser always sends `Origin`; other clients (TUI, curl, tests) do not.
 * We therefore only police the value when it is present: an absent Origin
 * cannot come from a web page, and blocking it would break every non-browser
 * client for no gain.
 */
export function originAllowed(
  origin: string | undefined,
  allowed: string[] | undefined,
  port: number,
): boolean {
  if (origin === undefined || origin === "" || origin === "null") return true;
  if (allowed?.includes("*")) return true;
  const defaults = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ];
  return defaults.includes(origin) || (allowed?.includes(origin) ?? false);
}

function tokenMatches(req: IncomingMessage, expected: string): boolean {
  const presented = presentedToken(req);
  if (presented === undefined) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual requires equal lengths. Checking length first leaks only
  // the token's length, which is fixed and public anyway.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function presentedToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  // Browsers cannot set headers on a WebSocket handshake, so the query
  // parameter is the only option for the web UI.
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token") ?? undefined;
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const text = `${status} ${reason}`;
  socket.write(
    `HTTP/1.1 ${text}\r\n` +
      `content-type: text/plain; charset=utf-8\r\n` +
      `content-length: ${Buffer.byteLength(reason + "\n")}\r\n` +
      `connection: close\r\n\r\n${reason}\n`,
  );
  socket.destroy();
}

// ---------------------------------------------------------------------------
// Static SPA hosting (codepilot serve --web, ROADMAP-NEXT §4.3 Phase 4)
// ---------------------------------------------------------------------------

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Serve a static file from `root`, with an SPA fallback: unknown paths that
 * carry no file extension resolve to `index.html` so client-side routing
 * works. Path traversal outside `root` is rejected with 403; missing files
 * (that DO have an extension) get 404. Everything is resolved through
 * `normalize` + a root prefix check, never raw concatenation.
 */
async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  const candidate = normalize(join(root, pathname));
  // Containment check: the normalized path must stay inside the root.
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden\n");
    return;
  }
  const send = async (filePath: string): Promise<boolean> => {
    try {
      const body = await readFile(filePath);
      const type = STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] ??
        "application/octet-stream";
      res.writeHead(200, {
        "content-type": type,
        "content-length": body.length,
        // Fingerprinted assets (Vite hashes) may be cached forever; the
        // entry HTML must always revalidate so new deploys show up.
        "cache-control": filePath.endsWith(".html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
      return true;
    } catch {
      return false;
    }
  };
  if (await send(candidate)) return;
  // SPA fallback: extensionless paths are client-side routes.
  if (!extname(pathname)) {
    if (await send(join(root, "index.html"))) return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found\n");
}
