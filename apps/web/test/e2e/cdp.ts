/**
 * Minimal Chrome DevTools Protocol driver for real-browser E2E tests.
 *
 * Why not Playwright: the repo avoids heavy test-only dependencies, and a
 * system Chrome (>= 120, --headless=new) plus the `ws` package already in the
 * workspace is enough to drive Page.navigate / Runtime.evaluate over CDP.
 *
 * Chrome binary can be overridden with CP_CHROME (for CI on Linux).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const protocolReal = realpathSync(join(import.meta.dirname, "../../node_modules/@codepilot/protocol"));
const WS = createRequire(join(protocolReal, "dist", "index.js"))("ws") as {
  new (url: string): CdpSocket;
};

const CHROME = process.env.CP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

interface CdpSocket {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", fn: (...args: never[]) => void): void;
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Uncaught page exceptions, collected for E2E failure triage. */
  readonly pageErrors: string[] = [];

  private constructor(private readonly socket: CdpSocket) {
    socket.on("message", (data: unknown) => {
      const msg = JSON.parse(String(data)) as {
        id?: number; result?: unknown; error?: { message: string };
        method?: string; params?: { exceptionDetails?: { exception?: { description?: string }; text?: string } };
      };
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        this.pageErrors.push(d?.exception?.description ?? d?.text ?? "unknown page exception");
        return;
      }
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  static async connect(wsUrl: string): Promise<CdpConnection> {
    const socket = new WS(wsUrl);
    const conn = new CdpConnection(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", () => reject(new Error(`CDP websocket failed: ${wsUrl}`)));
    });
    return conn;
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    try { this.socket.close(); } catch { /* gone */ }
  }
}

export interface ChromePage {
  /** Evaluate JS in the page; returns the JSON value, throws on page exceptions. */
  eval<T = unknown>(expression: string): Promise<T>;
  /** Poll an expression until it returns truthy. */
  waitFor(expression: string, timeoutMs?: number): Promise<void>;
  /** Screenshot as a PNG buffer (for failure triage). */
  screenshot(): Promise<Buffer>;
  /** Uncaught page exceptions observed since launch. */
  pageErrors(): string[];
  close(): Promise<void>;
}

async function httpJson(url: string, method = "GET"): Promise<unknown> {
  const res = await fetch(url, { method });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
  return res.json();
}

/** Launch headless Chrome and open a page at `url`. */
export async function launchChromePage(url: string): Promise<ChromePage> {
  const port = 9400 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "cp-chrome-e2e-"));
  const proc: ChildProcess = spawn(CHROME, [
    "--headless=new", "--no-sandbox", "--disable-crashpad", "--disable-gpu",
    "--no-first-run", "--disable-extensions", "--mute-audio", "--window-size=1400,900",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  ], { stdio: "ignore" });

  const cleanup = async (): Promise<void> => {
    proc.kill("SIGKILL");
    await new Promise(r => setTimeout(r, 300));
    rmSync(profile, { recursive: true, force: true });
  };

  // Wait for the CDP HTTP endpoint, then create the page target.
  const deadline = Date.now() + 10000;
  let target: { webSocketDebuggerUrl: string } | undefined;
  while (Date.now() < deadline && !target) {
    try {
      await httpJson(`http://127.0.0.1:${port}/json/version`);
      target = await httpJson(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, "PUT",
      ) as { webSocketDebuggerUrl: string };
    } catch { await new Promise(r => setTimeout(r, 150)); }
  }
  if (!target) {
    await cleanup();
    throw new Error("Chrome did not expose a CDP page target");
  }

  const conn = await CdpConnection.connect(target.webSocketDebuggerUrl);
  await conn.call("Page.enable");
  await conn.call("Runtime.enable");

  const evalJs = async <T>(expression: string): Promise<T> => {
    const result = await conn.call<{
      result?: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`page exception: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown"}`);
    }
    return result.result?.value as T;
  };

  return {
    eval: evalJs,
    async waitFor(expression: string, timeoutMs = 8000): Promise<void> {
      const until = Date.now() + timeoutMs;
      for (;;) {
        // `!!` coerces DOM nodes / numbers to boolean so returnByValue works.
        const value = await evalJs<boolean>(`!!(${expression})`).catch(() => false);
        if (value) return;
        if (Date.now() > until) throw new Error(`waitFor timed out: ${expression}`);
        await new Promise(r => setTimeout(r, 100));
      }
    },
    async screenshot(): Promise<Buffer> {
      const shot = await conn.call<{ data: string }>("Page.captureScreenshot", { format: "png" });
      return Buffer.from(shot.data, "base64");
    },
    pageErrors(): string[] {
      return conn.pageErrors;
    },
    async close(): Promise<void> {
      conn.close();
      await cleanup();
    },
  };
}
