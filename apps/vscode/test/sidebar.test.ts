import { describe, expect, it, vi } from "vitest";
import { SidebarProvider, type ChatMessage, type SidebarOptions, type ViewState } from "../src/sidebar.js";
import type { Event } from "../src/types.js";
import * as vscode from "vscode";

/* ---------------- test doubles ---------------- */

class FakeWebview {
  options: unknown = null;
  html = "";
  cspSource = "vscode-webview://test";
  readonly posted: unknown[] = [];
  private messageHandler: ((m: unknown) => void) | null = null;

  async postMessage(msg: unknown): Promise<boolean> {
    this.posted.push(msg);
    return true;
  }

  onDidReceiveMessage(handler: (m: unknown) => void): void {
    this.messageHandler = handler;
  }

  /** Simulate a message sent from the webview JS. */
  receive(msg: unknown): void {
    this.messageHandler?.(msg);
  }
}

class FakeWebviewView {
  readonly webview = new FakeWebview();
}

function makeCtx() {
  return { extensionUri: vscode.Uri.file("/ext") } as unknown as vscode.ExtensionContext;
}

function makeOpts(overrides: Partial<SidebarOptions> = {}): SidebarOptions & {
  sent: string[];
  cancels: number;
  news: number;
  picks: string[];
  modes: string[];
} {
  const rec = { sent: [] as string[], cancels: 0, news: 0, picks: [] as string[], modes: [] as string[] };
  return Object.assign(rec, {
    onSend: (t: string) => void rec.sent.push(t),
    onCancel: () => rec.cancels++,
    onNewSession: () => rec.news++,
    onPickContext: (a: string) => rec.picks.push(a),
    onSetMode: (m: string) => rec.modes.push(m),
    ...overrides,
  } as never);
}

/** Create a provider with a resolved (fake) webview and return helpers to
 *  inspect the state messages posted to it. */
function makeProvider(opts: SidebarOptions = makeOpts()) {
  const provider = new SidebarProvider(makeCtx(), opts);
  const view = new FakeWebviewView();
  provider.resolveWebviewView(view as never);
  const states = (): ViewState[] =>
    view.webview.posted
      .filter((m): m is { type: "state"; state: ViewState } => (m as { type: string }).type === "state")
      .map((m) => m.state);
  const last = (): ViewState => states()[states().length - 1];
  return { provider, view, states, last };
}

/* ---------------- resolveWebviewView ---------------- */

describe("resolveWebviewView", () => {
  it("enables scripts, sets HTML, and posts the initial state", () => {
    const { view, last } = makeProvider();
    expect((view.webview.options as { enableScripts: boolean }).enableScripts).toBe(true);
    expect(view.webview.html).toContain("<!DOCTYPE html>");
    expect(last()).toEqual({
      busy: false,
      messages: [],
      usage: { input: 0, output: 0 },
      connection: "disconnected",
      detail: undefined,
      mode: null,
    });
  });
});

/* ---------------- state management ---------------- */

describe("state management", () => {
  it("setConnection updates connection state and detail", () => {
    const { provider, last } = makeProvider();
    provider.setConnection("connecting");
    provider.setConnection("error", "spawn failed");
    expect(last().connection).toBe("error");
    expect(last().detail).toBe("spawn failed");
  });

  it("setBusy flips the busy flag", () => {
    const { provider, last } = makeProvider();
    provider.setBusy(true);
    expect(last().busy).toBe(true);
    provider.setBusy(false);
    expect(last().busy).toBe(false);
  });

  it("setMode/currentMode round-trips the displayed mode", () => {
    const { provider, last } = makeProvider();
    expect(provider.currentMode()).toBeNull();
    provider.setMode("plan");
    expect(provider.currentMode()).toBe("plan");
    expect(last().mode).toBe("plan");
    provider.setMode(null);
    expect(provider.currentMode()).toBeNull();
  });

  it("addUsage accumulates input/output/cost; resetUsage clears it", () => {
    const { provider, last } = makeProvider();
    provider.addUsage({ input: 10, output: 5, costUSD: 0.01 });
    provider.addUsage({ input: 3, output: 2, costUSD: 0.02 });
    expect(last().usage).toEqual({ input: 13, output: 7, costUSD: 0.03 });

    provider.resetUsage();
    expect(last().usage).toEqual({ input: 0, output: 0 });
  });

  it("reset() clears messages/usage/mode but keeps connection state", () => {
    const { provider, last } = makeProvider();
    provider.setConnection("ready");
    provider.appendUser("hello");
    provider.addUsage({ input: 100, output: 50 });
    provider.setMode("agent");

    provider.reset();
    const s = last();
    expect(s.messages).toEqual([]);
    expect(s.usage).toEqual({ input: 0, output: 0 });
    expect(s.mode).toBeNull();
    expect(s.connection).toBe("ready");
  });

  it("appendUser and appendSystem push messages with generated ids", () => {
    const { provider, last } = makeProvider();
    const id = provider.appendUser("hi there", [{ kind: "selection", label: "sel" }]);
    provider.appendSystem("note");
    const msgs = last().messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ id, role: "user", text: "hi there" });
    expect(msgs[0].context).toEqual([{ kind: "selection", label: "sel" }]);
    expect(msgs[1]).toMatchObject({ role: "system", text: "note" });
  });

  it("postState is a no-op before the view resolves", () => {
    const provider = new SidebarProvider(makeCtx(), makeOpts());
    // Should not throw without a resolved webview.
    provider.setBusy(true);
    provider.appendSystem("x");
  });

  it("reveal() focuses the chat view", () => {
    const { provider } = makeProvider();
    provider.reveal();
    const cmds = (vscode as unknown as { __executedCommands: Array<{ command: string }> })
      .__executedCommands;
    expect(cmds).toEqual([{ command: "codepilot.chatView.focus", args: [] }]);
  });
});

/* ---------------- applyEvent ---------------- */

function msg(id: string, role: "user" | "assistant", text: string): Event {
  return { type: "message", id, role, content: [{ type: "text", text }] };
}

describe("applyEvent", () => {
  it("message: appends new messages and replaces existing ones by id", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent(msg("m1", "assistant", "partial"));
    provider.applyEvent(msg("m1", "assistant", "final answer"));
    provider.applyEvent(msg("m2", "user", "question"));

    const msgs = last().messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ id: "m1", role: "assistant", text: "final answer" });
    expect(msgs[1]).toMatchObject({ id: "m2", role: "user", text: "question" });
  });

  it("message: ignores non-text content blocks", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent({
      type: "message",
      id: "m1",
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "read_file", input: {} },
        { type: "text", text: "done" },
      ],
    });
    expect(last().messages[0].text).toBe("done");
  });

  it("message_delta: synthesizes an anchor message, then appends text", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent({ type: "message_delta", messageId: "m9", delta: { type: "text", text: "Hel" } });
    provider.applyEvent({ type: "message_delta", messageId: "m9", delta: { type: "text", text: "lo" } });

    const msgs = last().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ id: "m9", role: "assistant", text: "Hello" });
  });

  it("message_delta: a final message event promotes the streamed partial", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent({ type: "message_delta", messageId: "m9", delta: { type: "text", text: "partial" } });
    provider.applyEvent(msg("m9", "assistant", "canonical"));

    const msgs = last().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("canonical");
  });

  it("tool_call: creates a collapsed tool message and updates it by tool id", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent({ type: "tool_call", id: "t1", name: "read_file", input: { path: "a" } });
    provider.applyEvent({ type: "tool_call", id: "t1", name: "read_file", input: { path: "b" } });

    const msgs = last().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("tool");
    expect(msgs[0].tool).toMatchObject({ id: "t1", name: "read_file", input: { path: "b" }, collapsed: true });
  });

  it("tool_result: fills in the matching tool call and expands it", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent({ type: "tool_call", id: "t1", name: "read_file", input: {} });
    provider.applyEvent({ type: "tool_result", toolCallId: "t1", name: "read_file", content: "file body" });

    const tool = last().messages[0].tool!;
    expect(tool.result).toBe("file body");
    expect(tool.collapsed).toBe(false);
    expect(tool.isError).toBeUndefined();
  });

  it("tool_result: creates a standalone tool message when the call is unknown", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent({
      type: "tool_result",
      toolCallId: "tX",
      name: "bash",
      content: "boom",
      isError: true,
    });
    const msgs = last().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].tool).toMatchObject({ id: "tX", name: "bash", result: "boom", isError: true, collapsed: false });
  });

  it("plan: appends a plan block, then replaces it on the next plan event", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent({
      type: "plan",
      steps: [{ id: "1", title: "step one", status: "pending" }],
    });
    provider.applyEvent({
      type: "plan",
      steps: [
        { id: "1", title: "step one", status: "completed" },
        { id: "2", title: "step two", status: "in_progress" },
      ],
    });

    const plans = last().messages.filter((m: ChatMessage) => m.plan);
    expect(plans).toHaveLength(1);
    expect(plans[0].plan).toEqual([
      { id: "1", title: "step one", status: "completed" },
      { id: "2", title: "step two", status: "in_progress" },
    ]);
  });

  it("usage: accumulates into the view state usage", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent({ type: "usage", usage: { input: 5, output: 2, costUSD: 0.001 } });
    provider.applyEvent({ type: "usage", usage: { input: 1, output: 1 } });
    expect(last().usage).toEqual({ input: 6, output: 3, costUSD: 0.001 });
  });

  it("error: appends a system message, marking unrecoverable errors", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent({ type: "error", message: "oops", recoverable: true });
    provider.applyEvent({ type: "error", message: "dead", recoverable: false });

    const msgs = last().messages;
    expect(msgs[0].text).toBe("⚠️ oops");
    expect(msgs[1].text).toBe("⚠️ dead (unrecoverable)");
  });

  it("compaction: appends a system note with the summary", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent({ type: "compaction", summary: "dropped old turns" });
    expect(last().messages[0].text).toBe("↪️ Context compacted: dropped old turns");
  });

  it("status: does not add messages or post state", () => {
    const { provider, view, last } = makeProvider();
    const before = view.webview.posted.length;
    provider.applyEvent({ type: "status", status: "running" });
    expect(last().messages).toEqual([]);
    expect(view.webview.posted.length).toBe(before);
  });

  it("mode: updates the displayed mode without adding a message", () => {
    const { provider, last } = makeProvider();
    provider.applyEvent({ type: "mode", mode: "chat" });
    expect(last().mode).toBe("chat");
    expect(last().messages).toEqual([]);
    expect(provider.currentMode()).toBe("chat");
  });
});

/* ---------------- webview message handling ---------------- */

describe("onWebviewMessage", () => {
  it("'send' forwards the text to onSend", async () => {
    const opts = makeOpts();
    const { view } = makeProvider(opts);
    view.webview.receive({ type: "send", text: "fix the bug" });
    await vi.waitFor(() => expect(opts.sent).toEqual(["fix the bug"]));
  });

  it("'send' coerces non-string text to an empty string", async () => {
    const opts = makeOpts();
    const { view } = makeProvider(opts);
    view.webview.receive({ type: "send", text: 42 });
    await vi.waitFor(() => expect(opts.sent).toEqual([""]));
  });

  it("'cancel' and 'new' invoke the corresponding callbacks", async () => {
    const opts = makeOpts();
    const { view } = makeProvider(opts);
    view.webview.receive({ type: "cancel" });
    view.webview.receive({ type: "new" });
    await vi.waitFor(() => {
      expect(opts.cancels).toBe(1);
      expect(opts.news).toBe(1);
    });
  });

  it("'pickContext' validates the action, defaulting to open", async () => {
    const opts = makeOpts();
    const { view } = makeProvider(opts);
    view.webview.receive({ type: "pickContext", action: "explain" });
    view.webview.receive({ type: "pickContext", action: "fix" });
    view.webview.receive({ type: "pickContext", action: "bogus" });
    await vi.waitFor(() => expect(opts.picks).toEqual(["explain", "fix", "open"]));
  });

  it("'setMode' forwards only valid modes", async () => {
    const opts = makeOpts();
    const { view } = makeProvider(opts);
    view.webview.receive({ type: "setMode", mode: "chat" });
    view.webview.receive({ type: "setMode", mode: "yolo" });
    view.webview.receive({ type: "setMode", mode: "agent" });
    await vi.waitFor(() => expect(opts.modes).toEqual(["chat", "agent"]));
  });

  it("'ready' re-posts the current state", async () => {
    const { provider, view, states } = makeProvider();
    provider.setBusy(true);
    const before = states().length;
    view.webview.receive({ type: "ready" });
    await vi.waitFor(() => expect(states().length).toBe(before + 1));
    expect(states()[states().length - 1].busy).toBe(true);
  });

  it("ignores unknown and malformed messages", async () => {
    const opts = makeOpts();
    const { view } = makeProvider(opts);
    view.webview.receive(null);
    view.webview.receive("nope");
    view.webview.receive({ type: "toggleTool", id: "t1" });
    view.webview.receive({ type: "somethingElse" });
    await new Promise((r) => setImmediate(r));
    expect(opts.sent).toEqual([]);
    expect(opts.cancels).toBe(0);
  });
});
