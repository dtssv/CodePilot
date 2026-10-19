import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import * as vscode from "vscode";

import { __setColorTheme } from "./__mocks__/vscode.js";
import { ChatViewProvider, injectCsp, themeOf } from "../src/sidebar.js";
import type { Engine } from "../src/engine.js";

/* ---------------- test doubles ---------------- */

class FakeWebview {
  options: unknown = null;
  html = "";
  cspSource = "vscode-webview://test";
  readonly posted: Array<Record<string, unknown>> = [];
  private handler: ((m: unknown) => void) | null = null;

  async postMessage(msg: unknown): Promise<boolean> {
    this.posted.push(msg as Record<string, unknown>);
    return true;
  }
  onDidReceiveMessage(handler: (m: unknown) => void): void {
    this.handler = handler;
  }
  receive(msg: unknown): void {
    this.handler?.(msg);
  }
}

class FakeEngine extends EventEmitter {
  running = false;
  starts = 0;
  stops = 0;
  failStart: string | null = null;
  readonly written: string[] = [];
  start(): void {
    if (this.failStart) throw new Error(this.failStart);
    this.running = true;
    this.starts++;
  }
  stop(): void {
    this.running = false;
    this.stops++;
  }
  write(line: string): void {
    if (!this.running) throw new Error("engine is not running");
    this.written.push(line);
  }
}

function extensionDir(html?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-vscode-"));
  if (html !== undefined) {
    mkdirSync(join(dir, "media", "webview"), { recursive: true });
    writeFileSync(join(dir, "media", "webview", "index.html"), html);
  }
  return dir;
}

function setup(html?: string) {
  const engine = new FakeEngine();
  const errors: string[] = [];
  const ctx = { extensionUri: vscode.Uri.file(extensionDir(html)) } as unknown as vscode.ExtensionContext;
  const provider = new ChatViewProvider(ctx, {
    engine: engine as unknown as Engine,
    cwd: () => "/work",
    onEngineError: (m) => errors.push(m),
  });
  const view = { webview: new FakeWebview() };
  provider.resolveWebviewView(view as never);
  const types = () => view.webview.posted.map((m) => m.type);
  return { engine, provider, webview: view.webview, errors, types };
}

const SHELL = `<!doctype html><html><head><title>x</title></head><body><div id="root"></div><script type="module">boot()</script></body></html>`;

/* ---------------- html ---------------- */

describe("webview html", () => {
  it("serves the shared UI with a CSP and a nonce on the module script", () => {
    const { webview } = setup(SHELL);
    expect((webview.options as { enableScripts: boolean }).enableScripts).toBe(true);
    const csp = /content="([^"]+)"/.exec(webview.html)?.[1] ?? "";
    expect(csp).toContain("default-src 'none'");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(webview.html).toContain(`<script type="module" nonce="${nonce}">boot()</script>`);
  });

  it("shows build instructions when the embed build is missing", () => {
    const { webview } = setup();
    expect(webview.html).toContain("not built");
  });

  it("injectCsp leaves `$` sequences in the page intact", () => {
    const out = injectCsp(`<head></head><script type="module">a.replace(/x/, "$&")</script>`, "src", "n");
    expect(out).toContain(`"$&"`);
  });
});

/* ---------------- relay ---------------- */

describe("relay", () => {
  it("starts the engine on ready and sends init + engine state", () => {
    const { engine, webview, types } = setup(SHELL);
    webview.receive({ type: "ready" });
    expect(engine.starts).toBe(1);
    expect(types()).toEqual(["host/init", "host/engine", "host/engine"]);
    expect(webview.posted[0]).toMatchObject({ cwd: "/work", theme: "dark", locale: "en", surface: "vscode" });
    expect(webview.posted[2]).toEqual({ type: "host/engine", state: "ready" });
  });

  it("does not respawn a running engine when the view reloads", () => {
    const { engine, webview } = setup(SHELL);
    webview.receive({ type: "ready" });
    webview.receive({ type: "ready" });
    expect(engine.starts).toBe(1);
  });

  it("moves rpc lines both ways", () => {
    const { engine, webview } = setup(SHELL);
    webview.receive({ type: "ready" });
    webview.receive({ type: "rpc", line: '{"id":1}' });
    expect(engine.written).toEqual(['{"id":1}']);
    engine.emit("line", '{"id":1,"result":{}}');
    expect(webview.posted.at(-1)).toEqual({ type: "rpc", line: '{"id":1,"result":{}}' });
  });

  it("reports engine exit and start failures", () => {
    const { engine, webview, errors } = setup(SHELL);
    engine.failStart = "spawn codepilot ENOENT";
    webview.receive({ type: "ready" });
    expect(errors).toEqual(["spawn codepilot ENOENT"]);
    expect(webview.posted.at(-1)).toEqual({ type: "host/engine", state: "stopped", error: "spawn codepilot ENOENT" });

    engine.failStart = null;
    webview.receive({ type: "restart" });
    expect(engine.running).toBe(true);
    engine.emit("exit", "engine exited (code=1)");
    expect(webview.posted.at(-1)).toEqual({ type: "host/engine", state: "stopped", error: "engine exited (code=1)" });
  });

  it("restart stops and respawns", () => {
    const { engine, webview } = setup(SHELL);
    webview.receive({ type: "ready" });
    webview.receive({ type: "restart" });
    expect(engine.stops).toBe(1);
    expect(engine.starts).toBe(2);
  });

  it("forwards theme changes, prompts and commands", () => {
    const { provider, webview } = setup(SHELL);
    __setColorTheme(vscode.ColorThemeKind.Light);
    provider.prompt("explain", true);
    provider.command({ name: "mode", mode: "plan" });
    expect(webview.posted).toEqual([
      { type: "host/theme", theme: "light" },
      { type: "host/prompt", text: "explain", send: true },
      { type: "host/command", name: "mode", mode: "plan" },
    ]);
  });
});

describe("themeOf", () => {
  it("maps light and high-contrast-light to light", () => {
    expect([1, 2, 3, 4, undefined].map(themeOf)).toEqual(["light", "dark", "dark", "light", "dark"]);
  });
});
