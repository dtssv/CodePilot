// Sidebar webview — chat UI.
//
// The webview runs in an isolated context with no DOM access on our side.
// We inline the HTML/CSS/JS (so esbuild can produce a single dist/extension.js)
// and communicate with it via postMessage. The shape of those messages mirrors
// the protocol's Event stream plus a few webview-only commands.

import * as vscode from "vscode";
import { renderWebviewHtml } from "./webview-html.js";
import type { ContentBlock, Event, UsageInfo } from "./types.js";

export interface SidebarOptions {
  /** Called when the user submits a prompt. */
  onSend(text: string): Promise<void> | void;
  /** Called when the user clicks Cancel. */
  onCancel(): void;
  /** Called when the user wants to start a new session. */
  onNewSession(): void;
  /** Called when the user requests to explain/fix a file (from a context menu
   *  inside the webview). We send back the file URI to the extension host. */
  onPickContext(action: "open" | "explain" | "fix"): void;
}

/* ---------- public view model ---------- */

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  /** Plain or markdown text for user/assistant; ignored for tool. */
  text?: string;
  /** Tool call metadata (for `tool` role). */
  tool?: {
    id: string;
    name: string;
    input?: unknown;
    result?: string;
    isError?: boolean;
    collapsed: boolean;
  };
  /** Plan steps (for system role rendering of plan events). */
  plan?: { id: string; title: string; status: string }[];
  /** Attached context (selection, file path, diagnostics) sent alongside the message. */
  context?: Array<{ kind: "selection" | "file" | "diagnostics"; label: string; preview?: string }>;
}

export interface ViewState {
  busy: boolean;
  messages: ChatMessage[];
  usage: UsageInfo;
  connection: "disconnected" | "connecting" | "ready" | "error" | "idle";
  detail?: string;
}

/* ---------- webview provider ---------- */

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private state: ViewState = {
    busy: false,
    messages: [],
    usage: { input: 0, output: 0 },
    connection: "disconnected",
  };

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly opts: SidebarOptions,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
    };
    webviewView.webview.html = renderWebviewHtml(webviewView.webview.cspSource);
    webviewView.webview.onDidReceiveMessage((m) => this.onWebviewMessage(m));
    // Push initial state once view is alive.
    this.postState();
  }

  /** Replace the entire view state (called on session reset). */
  reset(): void {
    this.state = {
      busy: false,
      messages: [],
      usage: { input: 0, output: 0 },
      connection: this.state.connection,
      detail: this.state.detail,
    };
    this.postState();
  }

  setConnection(state: "disconnected" | "connecting" | "ready" | "error", detail?: string): void {
    this.state.connection = state;
    this.state.detail = detail;
    this.postState();
  }

  setBusy(busy: boolean): void {
    this.state.busy = busy;
    this.postState();
  }

  addUsage(u: UsageInfo): void {
    this.state.usage.input += u.input ?? 0;
    this.state.usage.output += u.output ?? 0;
    if (typeof u.costUSD === "number") {
      this.state.usage.costUSD = (this.state.usage.costUSD ?? 0) + u.costUSD;
    }
    this.postState();
  }

  resetUsage(): void {
    this.state.usage = { input: 0, output: 0 };
    this.postState();
  }

  appendSystem(text: string): void {
    this.state.messages.push({ id: rid(), role: "system", text });
    this.postState();
  }

  /** Append a user message with optional context. */
  appendUser(text: string, context?: ChatMessage["context"]): string {
    const id = rid();
    this.state.messages.push({ id, role: "user", text, context });
    this.postState();
    return id;
  }

  /** Apply a protocol event to the in-memory model. */
  applyEvent(ev: Event): void {
    switch (ev.type) {
      case "message": {
        const idx = findMessageIndex(this.state.messages, ev.id);
        if (idx === -1) {
          this.state.messages.push({
            id: ev.id,
            role: ev.role,
            text: textOf(ev.content),
          });
        } else {
          // Promote streamed partial into the final message (canonical).
          const existing = this.state.messages[idx];
          this.state.messages[idx] = {
            ...existing,
            role: ev.role,
            text: textOf(ev.content),
          };
        }
        break;
      }
      case "message_delta": {
        const idx = findMessageIndex(this.state.messages, ev.messageId);
        if (idx === -1) {
          // No anchor message yet — synthesize one for streaming.
          this.state.messages.push({
            id: ev.messageId,
            role: "assistant",
            text: ev.delta.type === "text" ? ev.delta.text : "",
          });
        } else {
          const msg = this.state.messages[idx];
          if (ev.delta.type === "text") {
            msg.text = (msg.text ?? "") + ev.delta.text;
          } else {
            // tool_input_json — append to a hidden debug stream we don't render
            // (the canonical tool_call event will replace it).
          }
        }
        break;
      }
      case "tool_call": {
        const idx = findToolIndex(this.state.messages, ev.id);
        if (idx === -1) {
          this.state.messages.push({
            id: rid(),
            role: "tool",
            tool: { id: ev.id, name: ev.name, input: ev.input, collapsed: true },
          });
        } else {
          const m = this.state.messages[idx];
          if (m.tool) {
            m.tool.name = ev.name;
            m.tool.input = ev.input;
          }
        }
        break;
      }
      case "tool_result": {
        const idx = findToolIndex(this.state.messages, ev.toolCallId);
        if (idx === -1) {
          this.state.messages.push({
            id: rid(),
            role: "tool",
            tool: {
              id: ev.toolCallId,
              name: ev.name,
              result: ev.content,
              isError: ev.isError,
              collapsed: false,
            },
          });
        } else {
          const m = this.state.messages[idx];
          if (m.tool) {
            m.tool.result = ev.content;
            m.tool.isError = ev.isError;
            m.tool.collapsed = false;
          }
        }
        break;
      }
      case "plan": {
        // Replace existing plan block or append one.
        const idx = this.state.messages.findIndex((m) => m.plan);
        const planMsg: ChatMessage = {
          id: rid(),
          role: "system",
          plan: ev.steps.map((s) => ({ id: s.id, title: s.title, status: s.status })),
        };
        if (idx === -1) this.state.messages.push(planMsg);
        else this.state.messages[idx] = planMsg;
        break;
      }
      case "usage": {
        this.addUsage(ev.usage);
        return; // addUsage calls postState
      }
      case "error": {
        this.state.messages.push({
          id: rid(),
          role: "system",
          text: `⚠️ ${ev.message}${ev.recoverable ? "" : " (unrecoverable)"}`,
        });
        break;
      }
      case "compaction": {
        this.state.messages.push({
          id: rid(),
          role: "system",
          text: `↪️ Context compacted: ${ev.summary}`,
        });
        break;
      }
      case "status": {
        // surfaced via setBusy; no UI change here
        return;
      }
    }
    this.postState();
  }

  /** Build a snapshot of the current state and push to the webview. */
  postState(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ type: "state", state: this.state });
  }

  reveal(): void {
    void vscode.commands.executeCommand("codepilot.chatView.focus");
  }

  private async onWebviewMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type: string; [k: string]: unknown };
    switch (m.type) {
      case "ready":
        this.postState();
        return;
      case "send":
        await this.opts.onSend(typeof m.text === "string" ? m.text : "");
        return;
      case "cancel":
        this.opts.onCancel();
        return;
      case "new":
        this.opts.onNewSession();
        return;
      case "pickContext":
        this.opts.onPickContext(m.action === "explain" || m.action === "fix" ? m.action : "open");
        return;
      case "toggleTool":
        // purely local — handled inside the webview already
        return;
      default:
        return;
    }
  }
}

/* ---------- helpers ---------- */

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function findMessageIndex(list: ChatMessage[], id: string): number {
  return list.findIndex((m) => m.id === id);
}

function findToolIndex(list: ChatMessage[], toolId: string): number {
  return list.findIndex((m) => m.tool && m.tool.id === toolId);
}

function textOf(blocks: ReadonlyArray<ContentBlock>): string {
  // ContentBlock[] — extract text in order. Tool blocks are rendered separately
  // via tool_call events, so we just ignore them here.
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
