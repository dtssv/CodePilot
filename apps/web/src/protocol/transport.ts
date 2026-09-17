// Browser `RpcTransport` over the native WebSocket.
//
// `Peer` (from @codepilot/protocol/rpc) pulls lines with `readLine()`, while a
// WebSocket pushes messages at us — so this is a queue with at most one
// waiter, the same shape as the server-side transport. Inbound frames are
// split on newlines so a peer that batches several JSON documents into one
// frame still parses.

import type { RpcTransport } from "@codepilot/protocol/rpc";

export type ConnectionState = "connecting" | "open" | "closed";

export class BrowserWebSocketTransport implements RpcTransport {
  private readonly queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private ended = false;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return; // protocol is text-only
      this.push(ev.data);
    });
    socket.addEventListener("close", () => this.end());
    socket.addEventListener("error", () => this.end());
  }

  write(line: string): void {
    if (this.ended) throw new Error("websocket closed");
    this.socket.send(line.endsWith("\n") ? line.slice(0, -1) : line);
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
      this.socket.close(1000, "client closing");
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
    this.drain();
    if (this.waiter && this.queue.length === 0) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }
}

/** Resolve once the socket is open, or reject if it fails to connect. */
export function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onFail = (): void => {
      cleanup();
      // The browser deliberately hides *why* a handshake failed (status code
      // included), so the message can only point at the usual causes.
      reject(
        new Error(
          "could not open the WebSocket — check that `codepilot serve --web` is " +
            "running, that the token matches, and that this origin is allowed",
        ),
      );
    };
    const cleanup = (): void => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onFail);
      socket.removeEventListener("close", onFail);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onFail);
    socket.addEventListener("close", onFail);
  });
}
