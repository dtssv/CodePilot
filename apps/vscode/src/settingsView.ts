// Wide Settings surface: editor WebviewPanel hosting the same embed UI with
// view=settings. Sidebar APIs cannot set an exact width, so Settings opens
// here (full editor width) while chat stays in the activity-bar webview.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import * as vscode from "vscode";

import type { Engine } from "./engine.js";
import { injectCsp, themeOf } from "./sidebar.js";
import { nls } from "./nls.js";

export interface SettingsViewOptions {
  engine: Engine;
  cwd(): string;
  folders(): string[];
  log?(line: string): void;
}

export class SettingsView {
  private panel: vscode.WebviewPanel | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private engineLine: ((line: string) => void) | null = null;
  private engineExit: ((detail: string) => void) | null = null;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly opts: SettingsViewOptions,
  ) {}

  /** Reveal (or create) the wide Settings editor panel. */
  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      this.post({ type: "host/openSettings" });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "codepilot.settings",
      nls("CodePilot Settings"),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
      },
    );
    this.panel = panel;
    panel.webview.html = this.renderHtml(panel.webview.cspSource);

    this.engineLine = (line) => this.post({ type: "rpc", line });
    this.engineExit = (detail) => this.post({ type: "host/engine", state: "stopped", error: detail });
    this.opts.engine.on("line", this.engineLine);
    this.opts.engine.on("exit", this.engineExit);

    panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m as FromWebview), undefined, this.disposables);
    panel.onDidDispose(() => this.onPanelDisposed(), undefined, this.disposables);

    const themeEvent = vscode.window.onDidChangeActiveColorTheme?.((t) =>
      this.post({ type: "host/theme", theme: themeOf(t.kind) }),
    );
    if (themeEvent) this.disposables.push(themeEvent);
  }

  dispose(): void {
    this.panel?.dispose();
    this.cleanupEngineHooks();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private onPanelDisposed(): void {
    this.panel = null;
    this.cleanupEngineHooks();
  }

  private cleanupEngineHooks(): void {
    if (this.engineLine) {
      this.opts.engine.off?.("line", this.engineLine);
      this.engineLine = null;
    }
    if (this.engineExit) {
      this.opts.engine.off?.("exit", this.engineExit);
      this.engineExit = null;
    }
  }

  private onMessage(msg: FromWebview): void {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "rpc":
        try {
          this.opts.engine.write(msg.line);
        } catch (err) {
          this.post({
            type: "host/engine",
            state: "stopped",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      case "ready":
        this.post({
          type: "host/init",
          cwd: this.opts.cwd(),
          folders: this.opts.folders(),
          theme: themeOf(vscode.window.activeColorTheme?.kind),
          locale: vscode.env?.language,
          surface: "vscode",
        });
        this.ensureEngine();
        // Open the Settings sheet once the page is connected.
        this.post({ type: "host/openSettings" });
        return;
      case "restart":
        this.opts.engine.stop();
        this.ensureEngine();
        return;
      case "closeSettings":
        this.panel?.dispose();
        return;
      case "openSettings":
        this.post({ type: "host/openSettings" });
        return;
      default:
        return;
    }
  }

  private ensureEngine(): void {
    if (this.opts.engine.running) {
      this.post({ type: "host/engine", state: "ready" });
      return;
    }
    this.post({ type: "host/engine", state: "starting" });
    try {
      this.opts.engine.start();
      this.post({ type: "host/engine", state: "ready" });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`settings engine: ${text}`);
      this.post({ type: "host/engine", state: "stopped", error: text });
    }
  }

  private post(msg: unknown): void {
    if (!this.panel) return;
    try {
      void this.panel.webview.postMessage(msg);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (/disposed/i.test(text)) this.panel = null;
      else this.opts.log?.(`settings post: ${text}`);
    }
  }

  private renderHtml(cspSource: string): string {
    const file = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "webview", "index.html").fsPath;
    if (!existsSync(file)) {
      return `<!doctype html><html><body style="padding:16px;font-family:var(--vscode-font-family);color:var(--vscode-foreground)">
        <h3>${nls("CodePilot Settings")}</h3>
        <p>UI not built — run web + vscode build.</p>
      </body></html>`;
    }
    const boot = `<script>window.__codepilotHost=${JSON.stringify({
      kind: "vscode",
      locale: vscode.env.language || "en",
      theme: themeOf(vscode.window.activeColorTheme?.kind),
      view: "settings",
    })};</script>`;
    let html = readFileSync(file, "utf8");
    html = html.replace("<head>", `<head>\n${boot}`);
    return injectCsp(html, cspSource, randomBytes(16).toString("base64"));
  }
}

type FromWebview =
  | { type: "rpc"; line: string }
  | { type: "ready" }
  | { type: "restart" }
  | { type: "openSettings" }
  | { type: "closeSettings" };
