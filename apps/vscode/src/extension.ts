// Extension entry point.
//
// The chat view runs the shared CodePilot UI (the same React app as the web
// client and the desktop agent), so all clients look and behave the same.
// This host side only:
// - spawns `codepilot serve` and relays JSON-RPC lines to the webview,
// - turns editor commands (ask about selection, explain/fix file) into
// prompts for the view,
// - keeps the status bar and the `codepilot.busy` context key in sync,
// - opens native diff tabs for file edits (taps the relayed events).

import * as vscode from "vscode";

import { SettingsStore, StatusBar, modeLabel } from "./config.js";
import { Engine, tapServerLine } from "./engine.js";
import { ChatViewProvider } from "./sidebar.js";
import { AGENT_MODES, type AgentMode, type Event } from "./types.js";

const OUTPUT = vscode.window.createOutputChannel("CodePilot");

let engine: Engine | null = null;
let view: ChatViewProvider | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const settings = new SettingsStore();
  const statusBar = new StatusBar("codepilot.openSidebar");
  const cwd = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  engine = new Engine(() => settings.snapshot(), cwd);
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

  view = new ChatViewProvider(context, {
    engine,
    cwd,
    log: (line) => OUTPUT.appendLine(line),
    onEngineError: (message) => {
      OUTPUT.appendLine(`[engine] ${message}`);
      void vscode.window
        .showErrorMessage(
          `CodePilot could not start the engine: ${message}. Set \`codepilot.serverPath\` or \`codepilot.cliPath\`.`,
          "Open Settings",
        )
        .then((choice) => {
          if (choice) void vscode.commands.executeCommand("workbench.action.openSettings", "codepilot");
        });
    },
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codepilot.chatView", view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    settings,
    statusBar,
    { dispose: () => view?.dispose() },
    vscode.commands.registerCommand("codepilot.openSidebar", focusView),
    vscode.commands.registerCommand("codepilot.newSession", async () => {
      await focusView();
      view?.command({ name: "new" });
    }),
    vscode.commands.registerCommand("codepilot.cancel", () => view?.command({ name: "cancel" })),
    vscode.commands.registerCommand("codepilot.switchMode", async () => {
      const hints: Record<AgentMode, string> = {
        chat: "Ask — read-only Q&A",
        plan: "Plan — read-only exploration + planning",
        agent: "Agent — full autonomous execution",
      };
      const pick = await vscode.window.showQuickPick(
        AGENT_MODES.map((m) => ({ label: modeLabel(m), description: hints[m], picked: m === mode, mode: m })),
        { title: "CodePilot: Switch Mode", placeHolder: "Select collaboration mode" },
      );
      if (!pick) return;
      mode = pick.mode;
      statusBar.setMode(mode);
      view?.command({ name: "mode", mode });
    }),
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
  );
}

export function deactivate(): void {
  engine?.stop();
  engine = null;
  view = null;
}

async function focusView(): Promise<void> {
  await vscode.commands.executeCommand("workbench.view.extension.codepilot");
  await vscode.commands.executeCommand("codepilot.chatView.focus");
}

/* ---------------- editor → prompt ---------------- */

async function askSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selected = editor?.document.getText(editor.selection);
  if (!editor || !selected) {
    void vscode.window.showInformationMessage("CodePilot: select some code first.");
    return;
  }
  const sel = editor.selection;
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  const question = await vscode.window.showInputBox({
    title: "Ask CodePilot about the selection",
    prompt: `${rel} (lines ${sel.start.line + 1}–${sel.end.line + 1})`,
    placeHolder: "What do you want to know?",
  });
  if (question === undefined) return;
  const fence = "```";
  const text =
    `${question || "Explain this code."}\n\n` +
    `${fence}${editor.document.languageId}\n// @${rel} L${sel.start.line + 1}-${sel.end.line + 1}\n${selected}\n${fence}`;
  await focusView();
  view?.prompt(text, true);
}

async function promptOnActiveFile(task: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("CodePilot: open a file first.");
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
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return vscode.Uri.file(root && !p.startsWith("/") ? `${root}/${p}` : p);
}
