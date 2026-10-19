// Chat webview: hosts the shared CodePilot UI (apps/web, embed build) and
// relays its JSON-RPC traffic to the engine process.
//
// Message contract (see apps/web/src/protocol/bridge.ts):
// webview → host rpc {line} · ready · restart · openFile {path, line?}
// host → webview rpc {line} · host/init · host/engine · host/theme
// host/prompt {text, send?} · host/command {name, mode?}

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import * as vscode from "vscode";

import type { Engine } from "./engine.js";
import type { AgentMode } from "./types.js";

export type HostCommand = { name: "new" } | { name: "cancel" } | { name: "mode"; mode: AgentMode };

export interface ChatViewOptions {
  engine: Engine;
 /** Workspace root shown in the UI (the engine runs there). */
  cwd(): string;
 /** Called after the engine (re)started on the webview's request. */
  onEngineError?(message: string): void;
  log?(line: string): void;
}

type FromWebview =
  | { type: "rpc"; line: string }
  | { type: "ready" }
  | { type: "restart" }
  | { type: "openFile"; path: string; line?: number };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
 /** Host messages sent before the webview exists; flushed on resolve. */
  private readonly pending: unknown[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly opts: ChatViewOptions,
  ) {
    opts.engine.on("line", (line) => this.post({ type: "rpc", line }));
    opts.engine.on("exit", (detail) => this.post({ type: "host/engine", state: "stopped", error: detail }));
    const themeEvent = vscode.window.onDidChangeActiveColorTheme?.((t) =>
      this.post({ type: "host/theme", theme: themeOf(t.kind) }),
    );
    if (themeEvent) this.disposables.push(themeEvent);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview.cspSource);
    webviewView.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m as FromWebview));
    webviewView.onDidDispose?.(() => {
      if (this.view === webviewView) this.view = null;
    });
  }

 /** Put text into the composer, or send it right away. */
  prompt(text: string, send: boolean): void {
    this.post({ type: "host/prompt", text, send });
  }

  command(cmd: HostCommand): void {
    this.post({ type: "host/command", ...cmd });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private onMessage(msg: FromWebview): void {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "rpc":
        try {
          this.opts.engine.write(msg.line);
        } catch (err) {
          this.post({ type: "host/engine", state: "stopped", error: errorText(err) });
        }
        return;
      case "ready":
        this.post({
          type: "host/init",
          cwd: this.opts.cwd(),
          theme: themeOf(vscode.window.activeColorTheme?.kind),
          locale: vscode.env?.language,
          surface: "vscode",
        });
        this.ensureEngine();
        return;
      case "restart":
        this.opts.engine.stop();
        this.ensureEngine();
        return;
      case "openFile":
        void this.openFile(msg.path, msg.line);
        return;
    }
  }

  private ensureEngine(): void {
    if (!this.opts.engine.running) {
      this.post({ type: "host/engine", state: "starting" });
      try {
        this.opts.engine.start();
      } catch (err) {
        const message = errorText(err);
        this.opts.onEngineError?.(message);
        this.post({ type: "host/engine", state: "stopped", error: message });
        return;
      }
    }
    this.post({ type: "host/engine", state: "ready" });
  }

  private async openFile(path: string, line?: number): Promise<void> {
    const root = this.opts.cwd();
    const uri = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
      ? vscode.Uri.file(path)
      : vscode.Uri.joinPath(vscode.Uri.file(root), path);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
      }
    } catch (err) {
      this.opts.log?.(`openFile ${path}: ${errorText(err)}`);
    }
  }

  private post(msg: unknown): void {
    if (!this.view) {
 // Engine output before the view exists has no reader; only keep the
 // host-level messages that set the view up.
      const type = (msg as { type?: string }).type;
      if (type === "host/prompt" || type === "host/command") this.pending.push(msg);
      return;
    }
    while (this.pending.length > 0) void this.view.webview.postMessage(this.pending.shift());
    void this.view.webview.postMessage(msg);
  }

  private renderHtml(cspSource: string): string {
    const file = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "webview", "index.html").fsPath;
    if (!existsSync(file)) return missingBuildHtml(cspSource);
    return injectCsp(readFileSync(file, "utf8"), cspSource, randomBytes(16).toString("base64"));
  }
}

/**
 * Add the webview CSP and a nonce on the inlined module script. Inline
 * styles are needed for the bundled stylesheet and React style attributes.
 */
export function injectCsp(html: string, cspSource: string, nonce: string): string {
  const csp =
    `default-src 'none'; img-src ${cspSource} data: https:; font-src ${cspSource}; ` +
    `style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return html
    .replace("<head>", () => `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`)
    .replace(/<script type="module">/g, () => `<script type="module" nonce="${nonce}">`);
}

function missingBuildHtml(cspSource: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';"></head>
<body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px">
<h3>CodePilot UI is not built</h3>
<p>Run <code>pnpm --filter @codepilot/web build</code> and then <code>pnpm --filter codepilot-vscode build</code>.</p>
</body></html>`;
}

export function themeOf(kind: number | undefined): "light" | "dark" {
 // ColorThemeKind: 1 Light, 2 Dark, 3 HighContrast, 4 HighContrastLight.
  return kind === 1 || kind === 4 ? "light" : "dark";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
