// Extension entry point.
//
// Wires together:
//   - the stdio JSON-RPC client (apps/vscode/src/client.ts)
//   - the sidebar chat webview (apps/vscode/src/sidebar.ts)
//   - the status bar (apps/vscode/src/config.ts)
//   - VSCode commands (open sidebar, ask selection, explain/fix file, cancel, etc.)
//
// Activation event: `onStartupFinished` — we connect lazily on first interaction
// so opening VSCode with the extension installed doesn't slow startup.

import * as vscode from "vscode";
import { CodePilotClient } from "./client.js";
import { SettingsStore, StatusBar, modeLabel } from "./config.js";
import { SidebarProvider, type ChatMessage } from "./sidebar.js";
import { AGENT_MODES, type AgentMode, type Event, type PermissionRequestParams, type QuestionAnswers, type QuestionRequestParams, type QuestionSpec } from "./types.js";

const OUTPUT = vscode.window.createOutputChannel("CodePilot");

let client: CodePilotClient | null = null;
let settings: SettingsStore | null = null;
let statusBar: StatusBar | null = null;
let sidebar: SidebarProvider | null = null;
let activeSessionId: string | null = null;
/** The mode the next/active session should be in. Mirrors what the user picked
  * in the webview or via the Switch Mode command, and is what we'll pass to
  * the next `session/new` call. */
let currentMode: AgentMode | null = null;
/** Cached "before" value for rollback if `session/setMode` errors. */
let pendingModeRollback: AgentMode | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  settings = new SettingsStore();
  statusBar = new StatusBar("codepilot.openSidebar");

  // Register the sidebar provider first so the user sees it immediately.
  sidebar = new SidebarProvider(context, {
    onSend: (text) => sendPrompt(text),
    onCancel: () => cancelActivePrompt(),
    onNewSession: () => startNewSession(),
    onPickContext: (a) => handleContextAction(a),
    onSetMode: (mode) => void applyModeChange(mode),
  });
  // Reflect initial mode (from settings) immediately in the sidebar / status bar
  // so the segmented control is non-empty before the first session starts.
  const initialMode = (settings.snapshot().agentMode ?? "agent") as AgentMode;
  currentMode = initialMode;
  sidebar.setMode(initialMode);
  statusBar.setMode(initialMode);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codepilot.chatView", sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Connect on first interaction (or on demand).
  const ensureClient = async (): Promise<CodePilotClient> => {
    if (!settings) throw new Error("settings not initialized");
    if (client) return client;
    statusBar?.setState("connecting");
    sidebar?.setConnection("connecting");
    sidebar?.appendSystem("Starting `codepilot serve`…");
    const next = new CodePilotClient(settings.snapshot());
    attachClientHandlers(next);
    try {
      await next.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sidebar?.appendSystem(`Failed to start core: ${msg}. Set \`codepilot.serverPath\` or \`codepilot.cliPath\`.`);
      throw err;
    }
    client = next;
    return client;
  };

  const connectCmd = vscode.commands.registerCommand("codepilot.connect", async () => {
    try {
      await ensureClient();
    } catch {
      // already logged
    }
  });

  const openSidebar = vscode.commands.registerCommand("codepilot.openSidebar", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.codepilot");
    await vscode.commands.executeCommand("codepilot.chatView.focus");
    sidebar?.reveal();
  });

  const newSession = vscode.commands.registerCommand("codepilot.newSession", async () => {
    await startNewSession();
  });

  const cancel = vscode.commands.registerCommand("codepilot.cancel", async () => {
    await cancelActivePrompt();
  });

  const switchMode = vscode.commands.registerCommand("codepilot.switchMode", async () => {
    const labels: Record<AgentMode, string> = {
      chat: "Ask — read-only Q&A",
      plan: "Plan — read-only exploration + planning",
      agent: "Agent — full autonomous execution",
    };
    const items: vscode.QuickPickItem[] = AGENT_MODES.map((m) => ({
      label: modeLabel(m),
      description: labels[m],
      picked: currentMode === m,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      title: "CodePilot: Switch Mode",
      placeHolder: "Select collaboration mode",
    });
    if (!pick) return;
    const next = pick.label === "Ask" ? "chat" : pick.label === "Plan" ? "plan" : "agent";
    await applyModeChange(next);
  });

  const askSelection = vscode.commands.registerCommand("codepilot.askSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("CodePilot: select some code first.");
      return;
    }
    const sel = editor.selection;
    const selected = editor.document.getText(sel);
    if (!selected) {
      void vscode.window.showInformationMessage("CodePilot: selection is empty.");
      return;
    }
    const input = vscode.window.createInputBox();
    input.title = "Ask CodePilot about the selection";
    input.prompt = `Selection from ${vscode.workspace.asRelativePath(editor.document.uri)} (lines ${sel.start.line + 1}–${sel.end.line + 1})`;
    input.placeholder = "What do you want to know?";
    input.show();
    const text = await new Promise<string | undefined>((resolve) => {
      input.onDidAccept(() => resolve(input.value || undefined));
      input.onDidHide(() => resolve(undefined));
    });
    input.hide();
    if (text === undefined) return;
    const ctx: ChatMessage["context"] = [
      {
        kind: "selection",
        label: `${vscode.workspace.asRelativePath(editor.document.uri)} L${sel.start.line + 1}-${sel.end.line + 1}`,
        preview: selected,
      },
    ];
    await sendPrompt(text, ctx);
  });

  const explainFile = vscode.commands.registerCommand("codepilot.explainFile", async () => {
    await runOnActiveFile("Explain this file in a structured way (overview, key components, gotchas).");
  });

  const fixFile = vscode.commands.registerCommand("codepilot.fixFile", async () => {
    await runOnActiveFile(
      "Diagnose and fix any obvious bugs in this file. Use diagnostics if available; otherwise read through and propose concrete edits.",
    );
  });

  const showOutput = vscode.commands.registerCommand("codepilot.showOutput", () => {
    OUTPUT.show();
  });

  context.subscriptions.push(
    connectCmd,
    openSidebar,
    newSession,
    cancel,
    switchMode,
    askSelection,
    explainFile,
    fixFile,
    showOutput,
    settings,
    statusBar,
  );

  // Auto-start as soon as the workspace settles — best-effort only.
  void (async () => {
    try {
      await ensureClient();
    } catch (err) {
      // The sidebar surfaces this; nothing more to do here.
      void err;
    }
  })();
}

export function deactivate(): void {
  client?.dispose();
  client = null;
  settings?.dispose();
  settings = null;
  statusBar?.dispose();
  statusBar = null;
  sidebar = null;
}

/* ---------------- session orchestration ---------------- */

async function startNewSession(): Promise<void> {
  if (!sidebar) return;
  let c: CodePilotClient;
  try {
    c = await ensureClientForSend();
  } catch {
    return;
  }
  try {
    activeSessionId = await c.newSession({ agentMode: currentMode ?? undefined });
    sidebar.reset();
    sidebar.resetUsage();
    statusBar?.resetUsage();
    sidebar.setBusy(false);
    sidebar.setConnection("ready");
    if (currentMode) {
      sidebar.setMode(currentMode);
      statusBar?.setMode(currentMode);
    }
    sidebar.appendSystem(
      `New session started: ${activeSessionId.slice(0, 8)}${currentMode ? ` · ${modeLabel(currentMode)}` : ""}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sidebar.appendSystem(`Failed to create session: ${msg}`);
  }
}

async function sendPrompt(text: string, context?: ChatMessage["context"]): Promise<void> {
  if (!sidebar) return;
  let c: CodePilotClient;
  try {
    c = await ensureClientForSend();
  } catch {
    return;
  }
  if (!activeSessionId) {
    try {
      activeSessionId = await c.newSession({ agentMode: currentMode ?? undefined });
      sidebar.reset();
      sidebar.resetUsage();
      statusBar?.resetUsage();
      if (currentMode) {
        sidebar.setMode(currentMode);
        statusBar?.setMode(currentMode);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sidebar.appendSystem(`Failed to create session: ${msg}`);
      return;
    }
  }
  const userId = sidebar.appendUser(text, context);
  sidebar.setBusy(true);
  statusBar?.setState("busy");
  void userId;
  try {
    await c.sendPrompt({ sessionId: activeSessionId, text, images: extractImages() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sidebar.appendSystem(`Prompt failed: ${msg}`);
    sidebar.setBusy(false);
    statusBar?.setState("ready");
  }
}

async function cancelActivePrompt(): Promise<void> {
  if (!client || !activeSessionId) return;
  try {
    await client.cancelPrompt(activeSessionId);
    sidebar?.appendSystem("Cancel requested.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sidebar?.appendSystem(`Cancel failed: ${msg}`);
  }
}

/**
 * Apply a user-requested collaboration-mode change. If a session is open we
 * tell the server via `session/setMode`; the server then emits a `mode` event
 * that confirms the switch. If no session is open yet we just remember the
 * choice so the next `session/new` picks it up via `agentMode`.
 */
async function applyModeChange(mode: AgentMode): Promise<void> {
  if (currentMode === mode) return;
  const previous = currentMode;
  currentMode = mode;
  sidebar?.setMode(mode);
  statusBar?.setMode(mode);
  if (!client || !activeSessionId) {
    sidebar?.appendSystem(`Mode → ${modeLabel(mode)} (will apply to next session).`);
    return;
  }
  pendingModeRollback = previous;
  try {
    await client.setMode(activeSessionId, mode);
    // The server's `mode` event will update the UI authoritatively. If the
    // request errors, the event won't arrive and we revert below.
    sidebar?.appendSystem(`Mode → ${modeLabel(mode)}`);
    pendingModeRollback = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sidebar?.appendSystem(`Failed to switch mode: ${msg}`);
    const fallback = pendingModeRollback ?? previous ?? "agent";
    pendingModeRollback = null;
    currentMode = fallback;
    sidebar?.setMode(fallback);
    statusBar?.setMode(fallback);
  }
}

async function runOnActiveFile(task: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("CodePilot: open a file first.");
    return;
  }
  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
  const ctx: ChatMessage["context"] = [
    {
      kind: "file",
      label: vscode.workspace.asRelativePath(editor.document.uri),
      preview: editor.document.getText().slice(0, 8000),
    },
  ];
  if (diagnostics.length) {
    const summary = diagnostics
      .slice(0, 20)
      .map((d) => `[${d.severity === 0 ? "E" : d.severity === 1 ? "W" : "I"} L${d.range.start.line + 1}] ${d.message}`)
      .join("\n");
    ctx.push({ kind: "diagnostics", label: `${diagnostics.length} diagnostic(s)`, preview: summary });
  }
  await sendPrompt(task, ctx);
}

function handleContextAction(action: "open" | "explain" | "fix"): void {
  if (action === "explain") void vscode.commands.executeCommand("codepilot.explainFile");
  else if (action === "fix") void vscode.commands.executeCommand("codepilot.fixFile");
  else void vscode.commands.executeCommand("codepilot.openSidebar");
}

/* ---------------- client event handlers ---------------- */

function attachClientHandlers(c: CodePilotClient): void {
  c.on("log", (line) => OUTPUT.appendLine(`[${new Date().toISOString()}] ${line}`));

  c.on("state", (state, detail) => {
    sidebar?.setConnection(state, detail);
    if (state === "ready") statusBar?.setState("ready");
    else if (state === "connecting") statusBar?.setState("connecting");
    else if (state === "error") statusBar?.setState("error");
  });

  c.on("event", (sessionId, ev) => {
    if (activeSessionId && sessionId !== activeSessionId) return;
    activeSessionId = sessionId;
    onSessionEvent(ev);
  });

  c.on("usage", (n) => {
    statusBar?.addUsage(n.usage);
  });

  c.on("permissionRequest", (params) => {
    onPermissionRequest(c, params).catch((err) => {
      const m = err instanceof Error ? err.message : String(err);
      sidebar?.appendSystem(`Permission error: ${m}`);
    });
  });

  c.on("questionRequest", (params) => {
    onQuestionRequest(c, params).catch((err) => {
      const m = err instanceof Error ? err.message : String(err);
      sidebar?.appendSystem(`Question error: ${m}`);
    });
  });
}

function onSessionEvent(ev: Event): void {
  if (!sidebar) return;
  if (ev.type === "status") {
    if (ev.status === "running") {
      sidebar.setBusy(true);
      statusBar?.setState("busy");
    } else if (ev.status === "idle") {
      sidebar.setBusy(false);
      statusBar?.setState("ready");
    } else if (ev.status === "waiting_permission") {
      sidebar.setBusy(true);
      statusBar?.setState("busy");
    } else if (ev.status === "compacting") {
      sidebar.appendSystem("Compacting context…");
    }
    return;
  }
  if (ev.type === "mode") {
    // Authoritative confirmation from the server.
    currentMode = ev.mode;
    sidebar.setMode(ev.mode);
    statusBar?.setMode(ev.mode);
    return;
  }
  // For tool_call/edit events on supported tools, try to surface a diff.
  if (ev.type === "tool_call" && (ev.name === "edit_file" || ev.name === "write_file")) {
    void maybeShowDiffForEdit(ev.name, ev.input, ev.id);
  }
  sidebar.applyEvent(ev);
  // Also surface tool_result for write_file/edit_file via diff update if applicable.
  if (ev.type === "tool_result" && (ev.name === "edit_file" || ev.name === "write_file")) {
    void maybeShowDiffForResult(ev);
  }
}

function onPermissionRequest(c: CodePilotClient, params: PermissionRequestParams): Promise<void> {
  return new Promise((resolve) => {
    const toolSummary = summarizeTool(params.toolName, params.input);
    const message = `${params.reason}\n\nTool: ${params.toolName}\n${toolSummary}`;
    void vscode.window
      .showWarningMessage(message, { modal: false }, "Allow", "Always", "Deny")
      .then(async (choice) => {
        const decision = choice === "Allow" ? "allow" : choice === "Always" ? "always" : "deny";
        try {
          await c.respondPermission(params.requestId, decision);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          sidebar?.appendSystem(`Failed to send permission response: ${m}`);
        } finally {
          resolve();
        }
      });
  });
}

/**
 * Answer a structured `question/request` (ask_user_question / plan_done).
 *
 * Questions are asked sequentially via QuickPick (with options) or InputBox
 * (free text). Dismissing a prompt (Esc) yields an empty answer for that
 * question — fail-closed: plan_done reads a missing "Approve" answer as
 * "not approved". We always send `question/respond` so the server-side
 * promise resolves even if the user walks away.
 */
async function onQuestionRequest(c: CodePilotClient, params: QuestionRequestParams): Promise<void> {
  const answers: QuestionAnswers = {};
  // Surface the request in the chat so the user has context even if they
  // dismiss the native prompt.
  const first = params.questions[0];
  sidebar?.appendSystem(
    `❓ ${params.questions.length} question(s) from the agent${first ? `: ${first.question}` : ""}`,
  );
  try {
    for (const q of params.questions) {
      answers[q.id] = await askOneQuestion(q);
    }
  } finally {
    try {
      await c.respondQuestion(params.requestId, answers);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      sidebar?.appendSystem(`Failed to send question response: ${m}`);
    }
  }
}

/** Ask a single {@link QuestionSpec}; returns the label(s) or free text. */
async function askOneQuestion(q: QuestionSpec): Promise<string | string[]> {
  const title = q.header ? `CodePilot: ${q.header}` : "CodePilot";
  if (q.options && q.options.length > 0) {
    const items: vscode.QuickPickItem[] = q.options.map((o) => ({
      label: o.label,
      description: o.description,
    }));
    if (q.multiSelect) {
      const picks = await vscode.window.showQuickPick(items, {
        title,
        placeHolder: q.question,
        canPickMany: true,
      });
      // Esc (undefined) → empty selection; explicit OK with none → [].
      return picks ? picks.map((p) => p.label) : [];
    }
    const pick = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: q.question,
    });
    return pick ? pick.label : "";
  }
  // Free-text fallback when no options were provided.
  const text = await vscode.window.showInputBox({
    title,
    prompt: q.question,
  });
  return text ?? "";
}

function summarizeTool(toolName: string, input: unknown): string {  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (toolName === "bash" && typeof obj.command === "string") return `$ ${obj.command}`;
  if ((toolName === "read_file" || toolName === "write_file" || toolName === "edit_file") && typeof obj.path === "string") {
    return `path: ${obj.path}`;
  }
  try {
    return JSON.stringify(input).slice(0, 400);
  } catch {
    return "";
  }
}

/* ---------------- diff preview (best-effort) ---------------- */

interface EditSnapshot {
  path: string;
  before?: string;
  after?: string;
}

/**
 * Cache of file contents at the moment we observed an edit_file/write_file
 * tool_call. When the matching tool_result lands, we open a diff tab.
 */
const editSnapshots = new Map<string, EditSnapshot>();

async function maybeShowDiffForEdit(toolName: string, input: unknown, toolCallId: string): Promise<void> {
  if (!settings?.snapshot().showDiff) return;
  const obj = input as Record<string, unknown> | null;
  if (!obj || typeof obj.path !== "string") return;
  const path = obj.path;
  const uri = pathToUri(path);
  let before: string | undefined;
  try {
    before = await readFileIfExists(uri);
  } catch {
    before = undefined;
  }
  editSnapshots.set(toolCallId, { path, before });
  void toolName;
}

async function maybeShowDiffForResult(ev: Extract<Event, { type: "tool_result" }>): Promise<void> {
  if (!settings?.snapshot().showDiff) return;
  const snap = editSnapshots.get(ev.toolCallId);
  if (!snap) return;
  editSnapshots.delete(ev.toolCallId);
  // We only open a diff if we actually had a "before" snapshot — otherwise
  // (file was created from nothing) opening the result document is enough.
  if (snap.before === undefined) return;
  const uri = pathToUri(snap.path);
  try {
    const beforeDoc = await vscode.workspace.openTextDocument({
      content: snap.before,
      language: detectLanguage(snap.path),
    });
    const left = beforeDoc.uri;
    const right = uri;
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `CodePilot: ${vscode.workspace.asRelativePath(uri, /* keepSymlinks */ false)} (after)`,
      {
        preview: true,
      },
    );
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    sidebar?.appendSystem(`Diff preview failed: ${m}`);
  }
}

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    py: "python", rs: "rust", go: "go", java: "java", json: "json", md: "markdown",
    css: "css", html: "html", yml: "yaml", yaml: "yaml",
  };
  return map[ext] ?? "plaintext";
}

function pathToUri(p: string): vscode.Uri {
  if (p.startsWith("file://")) return vscode.Uri.parse(p);
  const abs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const resolved = abs && !p.startsWith("/") ? `${abs}/${p}` : p;
  return vscode.Uri.file(resolved);
}

async function readFileIfExists(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString("utf8");
  } catch {
    return undefined;
  }
}

/* ---------------- helpers ---------------- */

async function ensureClientForSend(): Promise<CodePilotClient> {
  if (client) return client;
  if (!settings) throw new Error("settings not initialized");
  statusBar?.setState("connecting");
  sidebar?.setConnection("connecting");
  const next = new CodePilotClient(settings.snapshot());
  attachClientHandlers(next);
  try {
    await next.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sidebar?.appendSystem(`Failed to start core: ${msg}`);
    statusBar?.setState("error");
    throw err;
  }
  client = next;
  return client;
}

function extractImages(): undefined {
  // The current VSCode UX does not yet provide an image picker. Hook here
  // when it does (e.g. paste screenshots / drag image files into the chat).
  return undefined;
}