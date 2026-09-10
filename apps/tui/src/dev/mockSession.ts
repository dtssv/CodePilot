/**
 * Mock Session for UI development.
 *
 * Implements the *public* subset of the @codepilot/core Session contract that
 * the TUI depends on, *without* requiring the core package to be installed or
 * built. We deliberately do NOT declare `: Session` here — the real Session
 * class has many private members which we don't want to mirror. Instead the
 * cli.tsx casts this to `Session` at the seam.
 *
 * Behaviors:
 *  - subscribe()/getEvents() — replays a fixed startup event sequence, then
 *    accepts events appended via the internal emitter.
 *  - prompt(text) — emits a "thinking" status, simulates streaming a canned
 *    assistant reply, then emits a final message + tool_call + tool_result
 *    cycle so the UI exercises its main render paths.
 *  - cancel() — aborts the current simulated prompt.
 *  - fork(), dispose() — stubbed.
 *  - onPermissionRequest — routed through the bridge so the UI's prompt path
 *    is exercised.
 */
import { randomUUID } from "node:crypto";

import type {
  AgentMode,
  Event,
  PermissionDecision,
  Session,
  SessionSummary,
} from "@codepilot/core";
import type { PermissionBridge, QuestionBridge } from "../ui/controller.js";

export interface MockSessionOptions {
  cwd: string;
  yolo: boolean;
  bridge: PermissionBridge;
  /** Optional question bridge; enables the "ask" demo path. */
  questionBridge?: QuestionBridge;
  /** Optional initial Cursor-style collaboration mode (default "agent"). */
  initialAgentMode?: AgentMode;
}

export interface MockSessionHandle {
  session: Session;
  defaultModel: string;
  permissionDecision: (reqId: string) => Promise<PermissionDecision>;
}

/**
 * Structural view of the Session contract — just the public surface the TUI
 * needs. Mirrors the docs/API.md Session declaration.
 */
interface SessionShape {
  readonly id: string;
  readonly cwd: string;
  prompt(text: string, images?: { mediaType: string; base64: string }[]): Promise<void>;
  cancel(): void;
  subscribe(listener: (e: Event) => void): () => void;
  getEvents(): Event[];
  setAgentMode(mode: AgentMode): Promise<void>;
  getAgentMode(): AgentMode;
  fork(atEventIndex?: number): Promise<SessionShape>;
  dispose(): Promise<void>;
}

class MockSessionImpl implements SessionShape {
  readonly id: string = randomUUID();
  readonly cwd: string;
  private listeners = new Set<(e: Event) => void>();
  private events: Event[] = [];
  private cancelled = false;
  private busy = false;
  private mode: AgentMode;

  constructor(cwd: string, private readonly yolo: boolean, private readonly bridge: PermissionBridge, initialAgentMode: AgentMode = "agent", private readonly questionBridge?: QuestionBridge) {
    this.cwd = cwd;
    this.mode = initialAgentMode;
    // Seed with an initial status:idle so the UI knows we're alive.
    this.emit({ type: "status", status: "idle" });
  }

  /** Append an event to the log and fan out to subscribers. */
  private emit(ev: Event): void {
    this.events.push(ev);
    for (const l of this.listeners) l(ev);
  }

  subscribe(listener: (e: Event) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getEvents(): Event[] {
    return this.events.slice();
  }

  async prompt(text: string, _images?: { mediaType: string; base64: string }[]): Promise<void> {
    if (this.busy) {
      throw new Error("mock session: another prompt is already in flight");
    }
    this.busy = true;
    this.cancelled = false;
    const userId = randomUUID();
    const assistantId = randomUUID();
    const toolCallId = randomUUID();

    // 1. Echo user message.
    this.emit({ type: "message", id: userId, role: "user", content: [{ type: "text", text }] });
    this.emit({ type: "status", status: "running" });

    // 2. Simulate streaming text deltas.
    const reply = this.cannedReply(text);
    let acc = "";
    for (const piece of reply) {
      if (this.cancelled) break;
      await sleep(20);
      acc += piece;
      this.emit({
        type: "message_delta",
        messageId: assistantId,
        delta: { type: "text", text: piece },
      });
    }

    // 3. Emit the final assistant message.
    if (!this.cancelled) {
      this.emit({
        type: "message",
        id: assistantId,
        role: "assistant",
        model: "mock-model",
        content: [{ type: "text", text: acc }],
      });
    }

    // 4. Optionally demonstrate a permission-gated tool call (skip in yolo).
    if (!this.cancelled && text.toLowerCase().includes("run")) {
      const req = {
        requestId: randomUUID(),
        toolName: "bash",
        input: { command: "ls -la" },
        reason: "Execute shell command",
      };
      this.emit({ type: "tool_call", id: toolCallId, name: "bash", input: req.input });
      this.emit({ type: "status", status: "waiting_permission" });
      const decision: PermissionDecision = this.yolo
        ? "allow"
        : await this.bridge.waitDecision(req);
      this.emit({ type: "status", status: "running" });
      if (decision === "deny") {
        this.emit({
          type: "tool_result",
          toolCallId,
          name: "bash",
          content: "denied by user",
          isError: true,
        });
      } else {
        // Pretend the tool ran successfully.
        await sleep(50);
        this.emit({
          type: "tool_result",
          toolCallId,
          name: "bash",
          content: "(mock) command output — 42 lines",
        });
      }
    }

    // 4b. Optionally demonstrate a structured question round-trip when the
    // prompt mentions "ask" and a question bridge is available.
    if (!this.cancelled && this.questionBridge !== undefined && text.toLowerCase().includes("ask")) {
      const answers = await this.questionBridge.waitAnswers({
        requestId: randomUUID(),
        questions: [
          {
            id: "confirm",
            header: "Confirm",
            question: "Proceed with the mocked plan?",
            options: [
              { label: "Yes (Recommended)", description: "Continue the demo." },
              { label: "No", description: "Stop here." },
            ],
          },
          {
            id: "note",
            header: "Note",
            question: "Anything else to add? (free text)",
          },
        ],
      });
      this.emit({
        type: "message",
        id: randomUUID(),
        role: "assistant",
        model: "mock-model",
        content: [
          {
            type: "text",
            text: `(mock) answers: ${JSON.stringify(answers)}`,
          },
        ],
      });
    }

    // 5. Usage event.
    this.emit({
      type: "usage",
      usage: { input: text.length, output: acc.length, costUSD: 0.0001 },
    });

    // 6. Settle.
    this.emit({ type: "status", status: "idle" });
    this.busy = false;
  }

  cancel(): void {
    this.cancelled = true;
    if (this.busy) {
      this.emit({
        type: "error",
        message: "cancelled",
        recoverable: true,
      });
    }
  }

  async fork(_atEventIndex?: number): Promise<SessionShape> {
    return new MockSessionImpl(this.cwd, this.yolo, this.bridge, this.mode, this.questionBridge) as SessionShape;
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
  }

  async setAgentMode(mode: AgentMode): Promise<void> {
    if (this.mode === mode) return;
    this.mode = mode;
    // Mirror the real Session behaviour: persist + emit a `mode` event so the
    // UI's reducer keeps state in sync with the canonical source of truth.
    const ev: Event = { type: "mode", mode };
    this.events.push(ev);
    for (const l of this.listeners) l(ev);
  }

  getAgentMode(): AgentMode {
    return this.mode;
  }

  private cannedReply(prompt: string): string[] {
    const base =
      `Hi! I'm the **mock** CodePilot session — the real core isn't wired in yet.\n\n` +
      `You said: \`${prompt.replace(/`/g, "\\`").slice(0, 200)}\`\n\n` +
      `Try things like /help, /model, /mode yolo, /plan, or type "run ls" to see the permission prompt.`;
    // Split into small chunks for streaming feel.
    return base.match(/.{1,12}/gs) ?? [base];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function createMockSession(opts: MockSessionOptions): MockSessionHandle {
  // The mock conforms structurally to SessionShape; cast at the boundary so
  // the TUI can pass it as a Session to the rest of the UI.
  const mock = new MockSessionImpl(opts.cwd, opts.yolo, opts.bridge, opts.initialAgentMode, opts.questionBridge);
  return {
    session: mock as unknown as Session,
    defaultModel: "mock-model",
    permissionDecision: (reqId) =>
      opts.bridge.waitDecision({
        requestId: reqId,
        toolName: "(unknown)",
        input: undefined,
        reason: "(mock)",
      }),
  };
}

// Re-export SessionSummary type for convenience.
export type { SessionSummary };