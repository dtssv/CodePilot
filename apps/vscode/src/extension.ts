// Extension entry point. The chat view runs the shared CodePilot UI (same React
// app as the web/desktop clients). This host side spawns `codepilot serve` and
// relays JSON-RPC to the webview, turns editor commands into prompts, keeps the
// status bar and `codepilot.busy` context key in sync, and opens native diff
// tabs for file edits.

import * as vscode from "vscode";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { SettingsStore, StatusBar, modeLabel } from "./config.js";
import {
  configureApiKeyWithIdeUi,
  openIdeSettings,
  openUserConfigFile,
  registerConfigSync,
} from "./configSync.js";
import { CompletionProvider } from "./completion.js";
import { Engine, tapServerLine } from "./engine.js";
import { nls } from "./nls.js";
import {
  applyPanelPositionContext,
  CHAT_VIEW,
  DOCK_VIEW,
  isPanelPosition,
  readPanelPosition,
  setPanelPosition,
  focusChatView,
} from "./panelPosition.js";
import { ChatViewProvider } from "./sidebar.js";
import { SettingsView } from "./settingsView.js";
import { AGENT_MODES, type AgentMode, type Event } from "./types.js";
import { loadUiPrefs, type UiPrefs } from "./uiPrefs.js";
import { notifyExtensionUpdateIfAvailable, runCheckUpdatesCommand } from "./updates.js";

const OUTPUT = vscode.window.createOutputChannel("CodePilot");

let engine: Engine | null = null;
let view: ChatViewProvider | null = null;
let settingsView: SettingsView | null = null;

const ACTIVE_CWD_KEY = "codepilot.activeCwd";

function listWorkspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

function defaultFallbackCwd(): string {
  const fallback = join(homedir(), "CodePilot");
  try {
    mkdirSync(fallback, { recursive: true });
  } catch {
    /* best-effort; engine may still start with the path */
  }
  return fallback;
}

/**
 * Active IDE folder: remembered pick if still in the multi-root set, else the
 * first folder, else `~/CodePilot` when the window has no folder open.
 */
function resolveWorkspaceCwd(context: vscode.ExtensionContext): string {
  const folders = listWorkspaceFolders();
  if (folders.length === 0) return defaultFallbackCwd();
  const remembered = context.workspaceState.get<string>(ACTIVE_CWD_KEY);
  if (remembered && folders.some((f) => f === remembered)) return remembered;
  return folders[0]!;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Must precede view registration so `when` clauses see left/right/top/bottom.
  await applyPanelPositionContext(readPanelPosition());

  const settings = new SettingsStore();
  const statusBar = new StatusBar("codepilot.openSidebar");
  const cwd = (): string => resolveWorkspaceCwd(context);
  const folders = (): string[] => {
    const list = listWorkspaceFolders();
    return list.length > 0 ? list : [cwd()];
  };
  process.env.CODEPILOT_CLIENT_VERSION = String(context.extension.packageJSON.version ?? "");

  const bundledCli = vscode.Uri.joinPath(context.extensionUri, "resources", "codepilot-cli.cjs").fsPath;
  engine = new Engine(() => settings.snapshot(), cwd, bundledCli);
  engine.on("stderr", (text) => OUTPUT.append(text));
  engine.on("exit", (detail) => {
    OUTPUT.appendLine(`[engine] ${detail}`);
    statusBar.setState("error");
    void vscode.commands.executeCommand("setContext", "codepilot.busy", false);
  });

  let mode = (settings.snapshot().agentMode ?? "agent") as AgentMode;
  statusBar.setMode(mode);

  engine.on("line", (line) =>
    tapServerLine(line, {
      onEvent: (_sessionId, ev) => {
        onEngineEvent(ev, statusBar);
        if (ev.type === "mode") mode = ev.mode;
      },
      onUsage: (usage) => statusBar.addUsage(usage),
    }),
  );

  // The `diagnostics` tool asks the host for language-server diagnostics. Only
  // the extension host can read `vscode.languages` (the webview is sandboxed),
  // so the host answers this reverse request directly and it is never relayed to
  // the webview.
  engine.onReverseRequest("diagnostics/request", async (params) =>
    collectDiagnostics(params as { path?: string }, cwd()),
  );

  const broadcastUiPrefs = (prefs: UiPrefs): void => {
    view?.applyUiPrefs(prefs);
    settingsView?.applyUiPrefs(prefs);
  };

  const handleUiPrefs = (prefs: UiPrefs): void => {
    if (isPanelPosition(prefs.panelPosition)) {
      void setPanelPosition(prefs.panelPosition, { focus: true }).then((pos) => {
        // Remounted chat webviews must receive the full SoT (locale/theme), not
        // only the dock field — otherwise language falls back to IDE chrome.
        broadcastUiPrefs({ ...loadUiPrefs(context), ...prefs, panelPosition: pos });
      });
      return;
    }
    broadcastUiPrefs(prefs);
  };

  view = new ChatViewProvider(context, {
    engine,
    cwd,
    folders,
    onSetCwd: (next) => {
      const allowed = folders();
      if (!allowed.some((f) => f === next)) return;
      void context.workspaceState.update(ACTIVE_CWD_KEY, next);
    },
    onOpenWideSettings: () => settingsView?.show(),
    onUiPrefs: handleUiPrefs,
    log: (line) => OUTPUT.appendLine(line),
    onEngineError: (message) => {
      OUTPUT.appendLine(`[engine] ${message}`);
      void vscode.window
        .showErrorMessage(
          nls(
            "CodePilot could not start the engine: {0}. Install/rebuild the extension (bundled engine) or set `codepilot.cliPath` / `codepilot.serverPath`.",
            message,
          ),
          nls("Open Settings"),
        )
        .then((choice) => {
          if (choice) settingsView?.show();
        });
    },
  });

  settingsView = new SettingsView(context, {
    engine,
    cwd,
    folders,
    onUiPrefs: handleUiPrefs,
    log: (line) => OUTPUT.appendLine(line),
  });

  registerConfigSync(context);

  const webviewOpts = { webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW.left, view, webviewOpts),
    vscode.window.registerWebviewViewProvider(CHAT_VIEW.right, view, webviewOpts),
    vscode.window.registerWebviewViewProvider(CHAT_VIEW.panel, view, webviewOpts),
    // Empty anchor view: keeps the primary container non-empty (VS Code hides a
    // container with no visible view) and renders its `viewsWelcome` links.
    vscode.window.registerTreeDataProvider(DOCK_VIEW, {
      getChildren: () => [],
      getTreeItem: () => {
        throw new Error("codepilot.dock has no items");
      },
    }),
    settings,
    statusBar,
    { dispose: () => view?.dispose() },
    { dispose: () => settingsView?.dispose() },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const active = cwd();
      // Drop a remembered pick that left the multi-root set.
      const remembered = context.workspaceState.get<string>(ACTIVE_CWD_KEY);
      if (remembered && remembered !== active) {
        void context.workspaceState.update(ACTIVE_CWD_KEY, active);
      }
      view?.notifyWorkspace(active, folders());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("codepilot.panelPosition")) return;
      const pos = readPanelPosition();
      void applyPanelPositionContext(pos).then(() => {
        broadcastUiPrefs({ ...loadUiPrefs(context), panelPosition: pos });
        void focusChatView(pos);
      });
    }),
    vscode.commands.registerCommand("codepilot.openSidebar", focusView),
    vscode.commands.registerCommand("codepilot.dockHere", () => void setPanelPosition("left")),
    // Wide editor Settings panel (sidebar cannot set an exact width).
    vscode.commands.registerCommand("codepilot.openSettings", () => settingsView?.show()),
    // Optional: VS Code extension-host prefs (cli path, …); synced scalars → ~/.codepilot.
    vscode.commands.registerCommand("codepilot.openIdeSettings", () => void openIdeSettings()),
    vscode.commands.registerCommand("codepilot.setApiKey", () => void configureApiKeyWithIdeUi()),
    vscode.commands.registerCommand("codepilot.editUserConfig", () => void openUserConfigFile()),
    vscode.commands.registerCommand("codepilot.switchWorkspace", async () => {
      const list = folders();
      if (list.length <= 1) {
        void vscode.window.showInformationMessage(
          list[0]
            ? nls("CodePilot workspace: {0}", list[0])
            : nls("CodePilot: open a folder in the window, or it will use ~/CodePilot."),
        );
        return;
      }
      const active = cwd();
      const pick = await vscode.window.showQuickPick(
        list.map((f) => ({
          label: f.split(/[/\\]/).filter(Boolean).pop() || f,
          description: f,
          picked: f === active,
          cwd: f,
        })),
        {
          title: nls("CodePilot: Switch Workspace Folder"),
          placeHolder: nls("Select the active folder"),
        },
      );
      if (!pick) return;
      void context.workspaceState.update(ACTIVE_CWD_KEY, pick.cwd);
      view?.notifyWorkspace(pick.cwd, list);
    }),
    vscode.commands.registerCommand("codepilot.newSession", async () => {
      await focusView();
      view?.command({ name: "new" });
    }),
    vscode.commands.registerCommand("codepilot.cancel", () => view?.command({ name: "cancel" })),
    vscode.commands.registerCommand("codepilot.switchMode", async () => {
      const hints: Record<AgentMode, string> = {
        chat: nls("Ask — read-only Q&A"),
        plan: nls("Plan — read-only exploration + planning"),
        agent: nls("Agent — full autonomous execution"),
      };
      const pick = await vscode.window.showQuickPick(
        AGENT_MODES.map((m) => ({ label: modeLabel(m), description: hints[m], picked: m === mode, mode: m })),
        {
          title: nls("CodePilot: Switch Mode"),
          placeHolder: nls("Select collaboration mode"),
        },
      );
      if (!pick) return;
      mode = pick.mode;
      statusBar.setMode(mode);
      view?.command({ name: "mode", mode });
    }),
    vscode.commands.registerCommand("codepilot.addToChat", (uri?: vscode.Uri) =>
      addToChat(uri, false),
    ),
    vscode.commands.registerCommand("codepilot.addToNewChat", (uri?: vscode.Uri) =>
      addToChat(uri, true),
    ),
    vscode.commands.registerCommand("codepilot.askSelection", askSelection),
    vscode.commands.registerCommand("codepilot.explainFile", () =>
      promptOnActiveFile("Explain this file in a structured way (overview, key components, gotchas)."),
    ),
    vscode.commands.registerCommand("codepilot.fixFile", () =>
      promptOnActiveFile(
        "Diagnose and fix any obvious bugs in this file. Use the diagnostics below if any; otherwise read it through and make concrete edits.",
      ),
    ),
    vscode.commands.registerCommand("codepilot.showOutput", () => OUTPUT.show()),
    vscode.commands.registerCommand("codepilot.checkUpdates", () => runCheckUpdatesCommand(context)),
  );

  // Inline (Tab) completion — off unless `codepilot.completion.enabled`. The
  // provider itself re-reads the setting on every request, so toggling takes
  // effect without a reload; registering it unconditionally is cheap.
  const completion = new CompletionProvider(
    engine,
    () => settings.snapshot(),
    cwd,
    (message) => void vscode.window.showInformationMessage(message),
  );
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, completion),
    { dispose: () => completion.dispose() },
  );

  // Plugin channel only — engine updates live in Settings → Updates / `codepilot update`.
  void notifyExtensionUpdateIfAvailable(context);
}

export function deactivate(): void {
  settingsView?.dispose();
  settingsView = null;
  engine?.stop();
  engine = null;
  view = null;
}

async function focusView(): Promise<void> {
  await focusChatView(readPanelPosition());
}

/* ---------------- editor → prompt ---------------- */

/** Add to (or start) chat. Keeps `@path:Lstart-end` when the uri is the active
 * editor with a selection; otherwise references the selection or whole file. */
async function addToChat(uri: vscode.Uri | undefined, newChat: boolean): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selectionRef = selectionRefFor(editor, uri);
  if (selectionRef) {
    await focusView();
    if (newChat) view?.command({ name: "new" });
    view?.prompt("", false, [selectionRef]);
    return;
  }
  if (uri instanceof vscode.Uri) {
    await addResourceUri(uri, newChat);
    return;
  }
  if (editor?.document.uri) {
    await addResourceUri(editor.document.uri, newChat);
    return;
  }
  void vscode.window.showInformationMessage(nls("CodePilot: pick a file or select some code first."));
}

/** When the active editor has a selection (optionally matching `uri`), return a ranged chip. */
function selectionRefFor(
  editor: vscode.TextEditor | undefined,
  uri?: vscode.Uri,
): { path: string; startLine: number; endLine: number } | undefined {
  if (!editor || editor.selection.isEmpty) return undefined;
  if (uri instanceof vscode.Uri && editor.document.uri.toString() !== uri.toString()) {
    return undefined;
  }
  const sel = editor.selection;
  return {
    path: vscode.workspace.asRelativePath(editor.document.uri),
    startLine: sel.start.line + 1,
    endLine: sel.end.line + 1,
  };
}

/** Explorer / editor tab: add the file path as a chip reference. */
async function addResourceUri(uri: vscode.Uri, newChat: boolean): Promise<void> {
  if (uri.scheme !== "file") {
    void vscode.window.showInformationMessage(nls("CodePilot: pick a file first."));
    return;
  }
  const rel = vscode.workspace.asRelativePath(uri);
  await focusView();
  if (newChat) view?.command({ name: "new" });
  view?.prompt("", false, [{ path: rel }]);
}

async function askSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage(nls("CodePilot: select some code first."));
    return;
  }
  const sel = editor.selection;
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  const question = await vscode.window.showInputBox({
    title: nls("Ask CodePilot about the selection"),
    prompt: `${rel} (lines ${sel.start.line + 1}–${sel.end.line + 1})`,
    placeHolder: nls("What do you want to know?"),
  });
  if (question === undefined) return;
  await focusView();
  view?.prompt(question || nls("Explain this code."), true, [
    { path: rel, startLine: sel.start.line + 1, endLine: sel.end.line + 1 },
  ]);
}

async function promptOnActiveFile(task: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage(nls("CodePilot: open a file first."));
    return;
  }
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri).slice(0, 20);
  const diag = diagnostics.length
    ? `\n\nDiagnostics:\n${diagnostics
        .map((d) => `- [${d.severity === 0 ? "error" : d.severity === 1 ? "warning" : "info"} L${d.range.start.line + 1}] ${d.message}`)
        .join("\n")}`
    : "";
  await focusView();
  view?.prompt(`${task}\n\nFile: @${rel}${diag}`, true);
}

/* ---------------- diagnostics (reverse request) ---------------- */

/** Wire diagnostic shape (mirrors @codepilot/core's Diagnostic). */
interface WireDiagnostic {
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  code?: string | number;
}

/** Map a VS Code diagnostic severity (0=Error … 3=Hint) to the wire enum. */
function severityName(s: vscode.DiagnosticSeverity): WireDiagnostic["severity"] {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "hint";
  }
}

function toWireDiagnostic(d: vscode.Diagnostic): WireDiagnostic {
  const code =
    typeof d.code === "object" && d.code !== null
      ? (d.code.value as string | number)
      : (d.code as string | number | undefined);
  return {
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    endLine: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    severity: severityName(d.severity),
    message: d.message,
    ...(d.source ? { source: d.source } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

/** Answer a `diagnostics/request` from `vscode.languages`. A `path` (relative to
 * the workspace or absolute) returns that file's diagnostics; otherwise every
 * file with diagnostics in the workspace. */
function collectDiagnostics(
  params: { path?: string },
  cwd: string,
): { diagnostics?: WireDiagnostic[]; files?: { path: string; diagnostics: WireDiagnostic[] }[] } {
  if (params.path) {
    const uri = isAbsolute(params.path)
      ? vscode.Uri.file(params.path)
      : vscode.Uri.file(join(cwd, params.path));
    return { diagnostics: vscode.languages.getDiagnostics(uri).map(toWireDiagnostic) };
  }
  const files: { path: string; diagnostics: WireDiagnostic[] }[] = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (diags.length === 0) continue;
    files.push({
      path: vscode.workspace.asRelativePath(uri),
      diagnostics: diags.map(toWireDiagnostic),
    });
  }
  return { files };
}

/* ---------------- engine events (tapped) ---------------- */

function onEngineEvent(ev: Event, statusBar: StatusBar): void {
  if (ev.type === "status") {
    const busy = ev.status !== "idle";
    statusBar.setState(busy ? "busy" : "ready");
    void vscode.commands.executeCommand("setContext", "codepilot.busy", busy);
  } else if (ev.type === "mode") {
    statusBar.setMode(ev.mode);
  } else if (ev.type === "tool_call" && (ev.name === "edit_file" || ev.name === "write_file")) {
    void snapshotBeforeEdit(ev.input, ev.id);
  } else if (ev.type === "tool_result" && (ev.name === "edit_file" || ev.name === "write_file")) {
    if (!ev.isError) void showDiffForResult(ev.toolCallId);
    else editSnapshots.delete(ev.toolCallId);
  }
}

/* ---------------- diff preview (best-effort) ---------------- */

/** File content at the moment an edit_file/write_file call was seen. */
const editSnapshots = new Map<string, { path: string; before: string }>();

function showDiffEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>("codepilot.showDiff", true);
}

async function snapshotBeforeEdit(input: unknown, toolCallId: string): Promise<void> {
  if (!showDiffEnabled()) return;
  const path = (input as { path?: unknown } | null)?.path;
  if (typeof path !== "string") return;
  try {
    const data = await vscode.workspace.fs.readFile(pathToUri(path));
    editSnapshots.set(toolCallId, { path, before: Buffer.from(data).toString("utf8") });
  } catch {
 // New file: opening it after the write is enough, no diff needed.
  }
}

async function showDiffForResult(toolCallId: string): Promise<void> {
  const snap = editSnapshots.get(toolCallId);
  if (!snap) return;
  editSnapshots.delete(toolCallId);
  const uri = pathToUri(snap.path);
  try {
    const before = await vscode.workspace.openTextDocument({ content: snap.before, language: detectLanguage(snap.path) });
    await vscode.commands.executeCommand(
      "vscode.diff",
      before.uri,
      uri,
      `CodePilot: ${vscode.workspace.asRelativePath(uri, false)} (before ↔ after)`,
      { preview: true, preserveFocus: true },
    );
  } catch (err) {
    OUTPUT.appendLine(`diff preview failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", json: "json", md: "markdown",
    css: "css", html: "html", yml: "yaml", yaml: "yaml",
  };
  return map[ext] ?? "plaintext";
}

function pathToUri(p: string): vscode.Uri {
  if (p.startsWith("file://")) return vscode.Uri.parse(p);
  const root = listWorkspaceFolders()[0] ?? defaultFallbackCwd();
  return vscode.Uri.file(isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : join(root, p));
}
