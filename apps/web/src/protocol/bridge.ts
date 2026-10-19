// Host bridge: lets the same UI run inside an IDE webview.
//
// In VSCode and IntelliJ the page has no socket to a server. Instead the
// extension/plugin spawns `codepilot serve` (JSON-RPC over stdio) and relays
// raw protocol lines through the webview message channel:
//
// UI → host { type: "rpc", line } one JSON-RPC document
// { type: "ready" } UI mounted, send host/init
// { type: "restart" } respawn the engine
// { type: "openFile", path, line? }
// host → UI { type: "rpc", line }
// { type: "host/init", cwd, theme?, locale?, surface? }
// { type: "host/engine", state: "starting" | "ready" | "stopped", error? }
// { type: "host/theme", theme }
// { type: "host/prompt", text, send? }
// { type: "host/command", name: "new" | "cancel" | "mode", mode? }
//
// VSCode exposes `acquireVsCodeApi`; IntelliJ (JCEF) injects
// `window.__codepilotHostPost(json)` after load and calls
// `window.__codepilotReceive(json)` to deliver. Messages to the IDE are
// queued until its channel exists, because JCEF injects after first paint.
// A host that serves the page itself can preset `window.__codepilotHost`
// in an inline script so the right kind and theme apply on first paint.

import type { AgentMode } from "@codepilot/core";
import type { RpcTransport } from "@codepilot/protocol/rpc";
import type { TransportOpener } from "./client.js";

export type HostKind = "vscode" | "idea";

export type HostToUi =
  | { type: "rpc"; line: string }
  | { type: "host/init"; cwd: string; theme?: "light" | "dark"; locale?: string; surface?: HostKind }
  | { type: "host/engine"; state: "starting" | "ready" | "stopped"; error?: string }
  | { type: "host/theme"; theme: "light" | "dark" }
  | { type: "host/prompt"; text: string; send?: boolean }
  | { type: "host/command"; name: "new" | "cancel" }
  | { type: "host/command"; name: "mode"; mode: AgentMode };

export type UiToHost =
  | { type: "rpc"; line: string }
  | { type: "ready" }
  | { type: "restart" }
  | { type: "openFile"; path: string; line?: number };

declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage(msg: unknown): void };
    __codepilotHostPost?: (json: string) => void;
    __codepilotReceive?: (json: string) => void;
    __codepilotHost?: { kind?: HostKind; theme?: "light" | "dark" };
  }
}

type Listener = (msg: HostToUi) => void;

export class HostBridge {
  private readonly listeners = new Set<Listener>();
  private readonly outbox: UiToHost[] = [];
  private readonly vscode: { postMessage(msg: unknown): void } | null;

  constructor(readonly kind: HostKind) {
    this.vscode = kind === "vscode" && window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;
    if (kind === "vscode") {
      window.addEventListener("message", (ev: MessageEvent) => this.deliver(ev.data));
    } else {
      window.__codepilotReceive = (json: string) => {
        try {
          this.deliver(JSON.parse(json));
        } catch {
 /* malformed host message */
        }
      };
    }
  }

  post(msg: UiToHost): void {
    if (this.vscode) {
      this.vscode.postMessage(msg);
      return;
    }
    const send = window.__codepilotHostPost;
    if (!send) {
      this.outbox.push(msg);
      this.waitForIdeaChannel();
      return;
    }
    this.flush(send);
    send(JSON.stringify(msg));
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private deliver(data: unknown): void {
    if (!data || typeof data !== "object" || typeof (data as { type?: unknown }).type !== "string") return;
    for (const l of [...this.listeners]) l(data as HostToUi);
  }

  private polling = false;
  private waitForIdeaChannel(): void {
    if (this.polling) return;
    this.polling = true;
    const tick = (): void => {
      const send = window.__codepilotHostPost;
      if (send) {
        this.polling = false;
        this.flush(send);
        return;
      }
      setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  }

  private flush(send: (json: string) => void): void {
    while (this.outbox.length > 0) send(JSON.stringify(this.outbox.shift()));
  }
}

/** Which IDE (if any) is hosting this page. */
export function detectHostKind(): HostKind | null {
  if (typeof window === "undefined") return null;
  if (typeof window.acquireVsCodeApi === "function") return "vscode";
  const preset = window.__codepilotHost?.kind;
  if (preset === "idea" || preset === "vscode") return preset;
  try {
    const host = new URLSearchParams(window.location.search).get("host");
    if (host === "idea" || host === "vscode") return host;
  } catch {
 /* no location */
  }
  if (typeof window.__codepilotHostPost === "function") return "idea";
  return null;
}

/**
 * `RpcTransport` over the host bridge. One instance per engine lifetime: it
 * ends when the host reports the engine stopped, which the client treats like
 * a dropped socket (and reconnects through a fresh transport).
 */
export class BridgeTransport implements RpcTransport {
  private readonly queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private ended = false;
  private readonly off: () => void;
  private readonly closeListeners = new Set<() => void>();

  constructor(private readonly bridge: HostBridge) {
    this.off = bridge.on((msg) => {
      if (msg.type === "rpc") this.push(msg.line);
      else if (msg.type === "host/engine" && msg.state === "stopped") this.end();
    });
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  write(line: string): void {
    if (this.ended) throw new Error("engine stopped");
    this.bridge.post({ type: "rpc", line: line.endsWith("\n") ? line.slice(0, -1) : line });
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
    this.end();
  }

  private push(text: string): void {
    for (const line of text.split("\n")) {
      if (line.trim() !== "") this.queue.push(line);
    }
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
    this.off();
    if (this.waiter && this.queue.length === 0) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
    for (const l of this.closeListeners) l();
  }
}

/** Transport opener for `CodepilotClient.connectTransport`. */
export function bridgeOpener(bridge: HostBridge): TransportOpener {
  return async () => {
    const ready = waitForEngine(bridge);
    bridge.post({ type: "ready" });
    await ready;
    const transport = new BridgeTransport(bridge);
    return { transport, close: () => transport.close(), onClose: (l) => transport.onClose(l) };
  };
}

/**
 * Resolve once the host reports a running engine. If it is already up the
 * host answers `ready` to the UI's `ready` message.
 */
export function waitForEngine(bridge: HostBridge, timeoutMs = 30_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("the CodePilot engine did not start — check the CodePilot output log"));
    }, timeoutMs);
    const off = bridge.on((msg) => {
      if (msg.type !== "host/engine") return;
      if (msg.state === "ready") {
        clearTimeout(timer);
        off();
        resolve();
      } else if (msg.state === "stopped") {
        clearTimeout(timer);
        off();
        reject(new Error(msg.error ?? "the CodePilot engine stopped"));
      }
    });
  });
}
