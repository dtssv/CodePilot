/**
 * Minimal JSON-RPC 2.0 over NDJSON transport.
 *
 * The transport is line-based: each message is exactly one line of UTF-8 JSON
 * terminated by `\n`. We intentionally do not parse framed batches here —
 * CodePilot's headless protocol (see docs/PROTOCOL.md) sends one message per
 * line and keeps things simple.
 *
 * Design notes:
 *  - `Peer` represents one side of the conversation (client or server).
 *  - Each peer exposes `request`, `notify`, `onRequest`, `onNotification`.
 *  - Outgoing writes go through `transport.write(line)`; incoming lines come
 *    from `transport.readLine()`.
 *  - Server→client *requests* (e.g. `permission/request`) are correlated with
 *    the client's `permission/respond` reply via the request `id`.
 *  - Pending request promises reject on transport end or peer-initiated cancel.
 */

export type JsonRpcId = number | string;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  /** `null` per JSON-RPC 2.0 §5.1 when the id can't be determined (e.g. parse error). */
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcError;

export const JSON_RPC_VERSION = "2.0" as const;

// Standard JSON-RPC error codes (https://www.jsonrpc.org/specification).
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Application-defined range: -32000 to -32099
  ProtocolVersionMismatch: -32602, // reused (PROTOCOL.md says -32602)
  SessionNotFound: -32000,
  PermissionDenied: -32001,
} as const;

/** Structured error thrown / sent over the wire. */
export class RpcError extends Error {
  override readonly name = "RpcError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
  toWire(id: JsonRpcId | null): JsonRpcError {
    return {
      jsonrpc: JSON_RPC_VERSION,
      id,
      error: { code: this.code, message: this.message, data: this.data },
    };
  }
}

/** Abstraction over the byte stream — swappable for tests. */
export interface RpcTransport {
  /** Write exactly one NDJSON line (no trailing newline expected in `line`). */
  write(line: string): Promise<void> | void;
  /**
   * Read the next NDJSON line, or `null` when the remote end closed cleanly.
   * Implementations should skip empty lines and strip the trailing `\n`.
   */
  readLine(): Promise<string | null> | string | null;
  /** Optional close hook for graceful shutdown. */
  close?(): Promise<void> | void;
}

/** Handler for a remote request (the peer is asking us to do something). */
export type RequestHandler<P = unknown, R = unknown> = (
  params: P,
  ctx: RequestContext,
) => Promise<R> | R;

export interface RequestContext {
  /** The JSON-RPC id of the incoming request (handy for permission flows). */
  readonly id: JsonRpcId;
}

/** Handler for an inbound notification (no reply expected). */
export type NotificationHandler<P = unknown> = (
  params: P,
  ctx: RequestContext,
) => Promise<void> | void;

export interface PeerOptions {
  transport: RpcTransport;
  /**
   * Whether to log wire errors to stderr. Defaults to true. Disable in tests.
   */
  debug?: boolean;
  /** Custom logger; defaults to `console.error`. */
  logger?: (msg: string, err?: unknown) => void;
}

/**
 * A JSON-RPC 2.0 peer. Build two of them around the same transport pair (or a
 * loopback mock) for tests, or wrap `process.stdin` / `process.stdout` for the
 * real CLI.
 */
export class Peer {
  private readonly transport: RpcTransport;
  private readonly debug: boolean;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly requestHandlers = new Map<
    string,
    RequestHandler<unknown, unknown>
  >();
  private readonly notificationHandlers = new Map<
    string,
    NotificationHandler<unknown>
  >();
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private nextId = 1;
  private closed = false;
  /** Public so tests can await the loop's termination. */
  readonly loopDone: Promise<void>;

  constructor(opts: PeerOptions) {
    this.transport = opts.transport;
    this.debug = opts.debug ?? false;
    this.log =
      opts.logger ??
      ((msg, err) => {
        if (this.debug) console.error(`[rpc] ${msg}`, err ?? "");
      });
    this.loopDone = this.runLoop();
  }

  /** Register a remote-call handler. Replaces any previous one for the method. */
  onRequest<P, R>(method: string, handler: RequestHandler<P, R>): void {
    this.requestHandlers.set(method, handler as RequestHandler<unknown, unknown>);
  }

  /** Register a notification handler. */
  onNotification<P>(method: string, handler: NotificationHandler<P>): void {
    this.notificationHandlers.set(
      method,
      handler as NotificationHandler<unknown>,
    );
  }

  /** Remove a previously registered handler (mainly for tests). */
  off(method: string): void {
    this.requestHandlers.delete(method);
    this.notificationHandlers.delete(method);
  }

  /** Send a request, await the response. */
  async request<P, R>(method: string, params?: P): Promise<R> {
    const id = this.allocId();
    const wire: JsonRpcRequest<P> = {
      jsonrpc: JSON_RPC_VERSION,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const promise = new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as R),
        reject,
      });
    });
    await this.sendWire(wire);
    return promise;
  }

  /** Send a one-way notification (no response expected). */
  async notify<P>(method: string, params?: P): Promise<void> {
    const wire: JsonRpcNotification<P> = {
      jsonrpc: JSON_RPC_VERSION,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.sendWire(wire);
  }

  /** Reject every pending request and stop the read loop. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const err = new RpcError(ErrorCode.InternalError, "peer closed");
    for (const [, pending] of this.pending) pending.reject(err);
    this.pending.clear();
    await this.transport.close?.();
    await this.loopDone.catch(() => {
      /* swallow — already settled */
    });
  }

  // ----- internals -----

  private allocId(): JsonRpcId {
    // Avoid clashing with `null` reserved for "unknown id" error replies.
    return this.nextId++;
  }

  private async sendWire(msg: JsonRpcMessage): Promise<void> {
    try {
      await this.transport.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.log("write failed", err);
      throw err;
    }
  }

  private async runLoop(): Promise<void> {
    try {
      while (!this.closed) {
        let line: string | null;
        try {
          const raw = await this.transport.readLine();
          line = raw;
        } catch (err) {
          this.log("read failed", err);
          // Fatal read error — emit a parse error for any pending ids? We
          // don't know which ids; just close gracefully.
          this.closed = true;
          const e = new RpcError(ErrorCode.InternalError, "transport read failed");
          for (const [, p] of this.pending) p.reject(e);
          this.pending.clear();
          return;
        }
        if (line === null) {
          // Remote closed.
          this.closed = true;
          const e = new RpcError(ErrorCode.InternalError, "peer disconnected");
          for (const [, p] of this.pending) p.reject(e);
          this.pending.clear();
          return;
        }
        if (line === "") continue; // tolerate stray empty lines
        await this.handleLine(line);
      }
    } catch (err) {
      this.log("loop crashed", err);
    }
  }

  private async handleLine(line: string): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // Parse error → reply with id:null per JSON-RPC 2.0.
      await this.sendWire(
        new RpcError(
          ErrorCode.ParseError,
          "Parse error",
          { line: line.length > 200 ? line.slice(0, 200) + "…" : line },
        ).toWire(null),
      );
      return;
    }
    if (!msg || typeof msg !== "object" || (msg as { jsonrpc?: unknown }).jsonrpc !== JSON_RPC_VERSION) {
      await this.sendWire(
        new RpcError(ErrorCode.InvalidRequest, "Invalid Request").toWire(null),
      );
      return;
    }
    // Response → resolve a pending request.
    if ("result" in msg || "error" in msg) {
      const id = (msg as JsonRpcSuccess | JsonRpcError).id;
      if (id === null) return; // error reply for unknown request — nothing to do
      const pending = this.pending.get(id);
      if (!pending) return; // late response, ignore
      this.pending.delete(id);
      if ("error" in msg) {
        const e = msg.error;
        pending.reject(new RpcError(e.code, e.message, e.data));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    // Request or notification (must have `method`).
    const m = msg as JsonRpcRequest | JsonRpcNotification;
    if (typeof m.method !== "string") {
      const id = "id" in m ? (m.id as JsonRpcId) : null;
      await this.sendWire(
        new RpcError(ErrorCode.InvalidRequest, "Invalid Request").toWire(id),
      );
      return;
    }
    const ctx: RequestContext = {
      id: ("id" in m ? (m.id as JsonRpcId) : 0) as JsonRpcId,
    };
    if ("id" in m && m.id !== undefined) {
      // Incoming request → we must reply.
      const handler = this.requestHandlers.get(m.method);
      if (!handler) {
        await this.sendWire(
          new RpcError(
            ErrorCode.MethodNotFound,
            `Method not found: ${m.method}`,
          ).toWire(m.id),
        );
        return;
      }
      try {
        const result = await handler(m.params, ctx);
        await this.sendWire({
          jsonrpc: JSON_RPC_VERSION,
          id: m.id,
          result,
        });
      } catch (err) {
        const wire = err instanceof RpcError
          ? err.toWire(m.id)
          : new RpcError(
              ErrorCode.InternalError,
              err instanceof Error ? err.message : String(err),
            ).toWire(m.id);
        await this.sendWire(wire);
      }
      return;
    }
    // Notification — no reply.
    const handler = this.notificationHandlers.get(m.method);
    if (!handler) {
      this.log(`no notification handler for ${m.method}`);
      return;
    }
    try {
      await handler(m.params, ctx);
    } catch (err) {
      this.log(`notification ${m.method} threw`, err);
    }
  }
}

/** Stdline transport around `process.stdin` / `process.stdout`. */
export class StdioTransport implements RpcTransport {
  private closed = false;
  /** Input hit EOF — buffered lines are still drained before readLine reports null. */
  private inputEnded = false;
  private buffer = "";
  private waiter: ((line: string | null) => void) | null = null;
  private readonly onData: (chunk: Buffer | string) => void;
  private readonly onEnd: () => void;

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {
    input.setEncoding?.("utf8");
    this.onData = (chunk) => this.handleChunk(chunk);
    this.onEnd = () => this.handleClose();
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("close", this.onEnd);
  }

  write(line: string): void {
    if (this.closed) throw new Error("transport closed");
    this.output.write(line);
  }

  readLine(): Promise<string | null> {
    // Drain any complete line already in the buffer — even after close, so a
    // final piped batch of lines is fully processed before EOF is reported.
    const nl = this.buffer.indexOf("\n");
    if (nl >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      return Promise.resolve(line);
    }
    if (this.closed || this.inputEnded) return Promise.resolve(null);
    if (this.waiter) {
      return Promise.reject(new Error("readLine re-entered"));
    }
    return new Promise<string | null>((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.input.removeListener("close", this.onEnd);
    if (this.waiter) {
      this.waiter(null);
      this.waiter = null;
    }
  }

  private handleChunk(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const nl = this.buffer.indexOf("\n");
    if (nl < 0) return;
    const line = this.buffer.slice(0, nl);
    this.buffer = this.buffer.slice(nl + 1);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(line);
    } else {
      // Push back into buffer for the next readLine() call. The waiter slot
      // can only hold one pending line at a time, but the SDK contract is
      // one-line-at-a-time and that's enforced by the caller.
      this.buffer = line + "\n" + this.buffer;
    }
  }

  private handleClose(): void {
    // Mark EOF but keep the transport writable: the peer may still be
    // dispatching buffered lines whose responses must go out (one-shot pipes).
    this.inputEnded = true;
    const w = this.waiter;
    this.waiter = null;
    if (w) w(null);
  }
}