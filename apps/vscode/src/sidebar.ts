// Chat webview: hosts the shared CodePilot UI (apps/web embed build) and
// relays its JSON-RPC to the engine. Message contract (see
// apps/web/src/protocol/bridge.ts):
// webview → host rpc {line} · ready · restart · openFile {path, line?} · insertText {text}
// host → webview rpc {line} · host/init · host/engine · host/theme
// host/prompt {text, send?} · host/command {name, mode?}

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import * as vscode from "vscode";

import type { Engine } from "./engine.js";
import { nls } from "./nls.js";
import type { AgentMode } from "./types.js";
import { readPanelPosition } from "./panelPosition.js";
import { loadUiPrefs, mergeUiPrefs, type UiPrefs } from "./uiPrefs.js";

export type HostCommand = { name: "new" } | { name: "cancel" } | { name: "mode"; mode: AgentMode };

export interface ChatViewOptions {
  engine: Engine;
 /** Active workspace root shown in the UI (the engine runs there). */
  cwd(): string;
 /** All IDE folders for multi-root workspaces (includes the active cwd). */
  folders(): string[];
 /** Persist the user's active-folder pick (multi-root). */
  onSetCwd?(cwd: string): void;
 /** Open Settings in a wide editor WebviewPanel (sidebar cannot set exact width). */
  onOpenWideSettings?(): void | Promise<void>;
 /** Broadcast UI prefs to every CodePilot webview (chat + Settings). */
  onUiPrefs?(prefs: UiPrefs): void;
 /** Called after the engine (re)started on the webview's request. */
  onEngineError?(message: string): void;
  log?(line: string): void;
}

type FromWebview =
  | { type: "rpc"; line: string }
  | { type: "ready" }
  | { type: "restart" }
  | { type: "openFile"; path: string; line?: number }
  | { type: "insertText"; text: string }
  | { type: "setCwd"; cwd: string }
  | { type: "openSettings" }
  | { type: "closeSettings" }
  | { type: "prefs/set"; prefs: UiPrefs };

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

 /** Put text / structured refs into the composer, or send right away. */
  prompt(
    text: string,
    send: boolean,
    refs?: Array<{ path: string; startLine?: number; endLine?: number }>,
  ): void {
    this.post({ type: "host/prompt", text, send, ...(refs?.length ? { refs } : {}) });
  }

  command(cmd: HostCommand): void {
    this.post({ type: "host/command", ...cmd });
  }

  /** Open Settings in the wide editor panel (same Desktop Settings UI). */
  showSettings(): void {
    void this.opts.onOpenWideSettings?.();
  }

  /** Push the current workspace root(s) to the UI (folder open/close/switch). */
  notifyWorkspace(cwd: string, folderList?: string[]): void {
    const folders = folderList ?? this.opts.folders();
    const prefs: UiPrefs = { ...loadUiPrefs(this.ctx), panelPosition: readPanelPosition() };
    this.post({
      type: "host/init",
      cwd,
      folders,
      // Always the IDE chrome theme — UI preference (incl. system) lives in prefs.
      theme: themeOf(vscode.window.activeColorTheme?.kind),
      locale: prefs.locale ?? vscode.env?.language,
      surface: "vscode",
      prefs,
    });
  }

  /** Apply prefs from the extension host / sibling Settings webview. */
  applyUiPrefs(prefs: UiPrefs): void {
    this.post({ type: "host/prefs", prefs });
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
        this.notifyWorkspace(this.opts.cwd());
        this.ensureEngine();
        return;
      case "restart":
        this.opts.engine.stop();
        this.ensureEngine();
        return;
      case "openFile":
        void this.openFile(msg.path, msg.line);
        return;
      case "insertText":
        void this.insertText(msg.text);
        return;
      case "setCwd":
        if (typeof msg.cwd === "string" && msg.cwd.trim()) {
          this.opts.onSetCwd?.(msg.cwd.trim());
        }
        return;
      case "openSettings":
        void this.opts.onOpenWideSettings?.();
        return;
      case "closeSettings":
        return;
      case "prefs/set":
        if (msg.prefs && typeof msg.prefs === "object") {
          const merged = mergeUiPrefs(this.ctx, msg.prefs);
          this.opts.onUiPrefs?.(merged);
        }
        return;
    }
  }

  /** Insert code at the active editor's cursor (replacing any selection). Never
   * writes disk — the user keeps and saves the edit themselves. */
  private async insertText(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage(
        nls("CodePilot: open a file and place the cursor where the code should go."),
      );
      return;
    }
    try {
      await editor.edit((b) => {
        for (const sel of editor.selections) b.replace(sel, text);
      });
    } catch (err) {
      this.opts.log?.(`insertText: ${errorText(err)}`);
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

  private async openFile(rawPath: string, line?: number): Promise<void> {
    const root = this.opts.cwd();
    // Strip trailing `:line[:col]` so we never open a non-existent `foo.ts:79`.
    // Keep in sync with `@codepilot/protocol/paths` parseReference.
    const anchor = /:(\d{1,9})(?::(\d{1,9}))?$/.exec(rawPath.trim());
    let path = rawPath.trim();
    if (anchor) {
      const head = path.slice(0, anchor.index);
      const pathLike = /[\\/]|\.[a-z0-9]{1,16}$/i.test(head);
      if (pathLike && head.length > 0) {
        path = head;
        if (line === undefined) {
          const n = Number(anchor[1]);
          if (Number.isFinite(n) && n > 0) line = n;
        }
      }
    }
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
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift();
        if (next !== undefined) void this.view.webview.postMessage(next);
      }
      void this.view.webview.postMessage(msg);
    } catch (err) {
      // WebviewView can dispose while the engine is still emitting lines.
      const text = err instanceof Error ? err.message : String(err);
      if (/disposed/i.test(text)) {
        this.view = null;
        return;
      }
      this.opts.log?.(`webview post: ${text}`);
    }
  }

  private renderHtml(cspSource: string): string {
    const file = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "webview", "index.html").fsPath;
    if (!existsSync(file)) return missingBuildHtml(cspSource);
    const nonce = randomBytes(16).toString("base64");
    const locale = vscode.env.language || "en";
    const theme = themeOf(vscode.window.activeColorTheme?.kind);
    // Boot must be minted with the nonce already — a global `<script` rewrite
    // would also mutate string literals inside the inlined embed bundle.
    const boot = hostBootScript(nonce, {
      kind: "vscode",
      locale,
      theme,
      view: "chat",
    });
    let html = readFileSync(file, "utf8");
    html = html.replace("<head>", `<head>\n${boot}`);
    return injectCsp(html, cspSource, nonce);
  }
}

/** Host boot tag (`window.__codepilotHost`) with CSP nonce already applied. */
export function hostBootScript(
  nonce: string,
  host: { kind: string; locale?: string; theme?: string; view?: string },
): string {
  return `<script nonce="${nonce}">window.__codepilotHost=${JSON.stringify(host)};</script>`;
}

/** Add the webview CSP and a nonce to the module entry. Never rewrite every
 * `<script` — the inlined embed JS can contain that substring and crashes.
 * Inline styles stay allowed for the bundled stylesheet. */
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
