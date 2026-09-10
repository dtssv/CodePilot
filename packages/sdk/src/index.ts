/**
 * @codepilot/sdk — embed CodePilot agents in scripts, CI pipelines, and
 * backend services.
 *
 * The SDK wraps `@codepilot/core`'s `Session` in a clean, promise-based API
 * suitable for programmatic use. It mirrors the claude-code SDK surface:
 *
 *   import { Agent } from "@codepilot/sdk";
 *
 *   const agent = await Agent.create({ cwd: "/my/project", model: "claude-sonnet-4-5" });
 *   const result = await agent.prompt("Fix the failing tests in src/");
 *   console.log(result.text);
 *   await agent.dispose();
 *
 * Or for one-shot use:
 *
 *   import { run } from "@codepilot/sdk";
 *   const { text } = await run({ cwd: ".", prompt: "lint and fix" });
 *
 * Streaming:
 *
 *   for await (const event of agent.stream("explain this codebase")) {
 *     if (event.type === "text") process.stdout.write(event.text);
 *   }
 *
 * @module @codepilot/sdk
 */
import {
  Session,
  loadConfig,
  type Event,
  type CodepilotConfig,
  type PermissionRequest,
  type PermissionDecision,
  type QuestionRequest,
  type QuestionAnswers,
  type AgentMode,
  type ImageAttachment,
  ReplayProvider,
} from "@codepilot/core";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating an Agent. */
export interface AgentCreateOptions {
  /** Working directory (default: process.cwd()). */
  cwd?: string;
  /** Model id (default: from config or "claude-sonnet-4-5"). */
  model?: string;
  /** Explicit config overrides (merged on top of loaded config). */
  config?: Partial<CodepilotConfig>;
  /** Resume an existing session by id. */
  sessionId?: string;
  /** Initial collaboration mode (default: "agent"). */
  agentMode?: AgentMode;
  /** Permission handler. When unset, all tool calls are auto-approved (yolo
   *  mode — suitable for CI). For interactive use, provide a handler that
   *  prompts the user. */
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
  /** Structured question handler (for ask_user_question / plan_done). */
  onAskUser?: (req: QuestionRequest) => Promise<QuestionAnswers>;
  /** Skip loading config files (use only `config` option). */
  noConfigFiles?: boolean;
  /** Replay mode: path to a transcript JSONL for keyless testing. */
  replay?: string;
}

/** Result of an agent prompt. */
export interface AgentResult {
  /** The final assistant text. */
  text: string;
  /** Whether the agent encountered any errors. */
  hadErrors: boolean;
  /** Number of tool calls made. */
  toolCallCount: number;
  /** Token usage for this prompt. */
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; costUSD?: number };
  /** The session id (for resuming later). */
  sessionId: string;
}

/** Streaming event from `agent.stream()`. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; content: string; isError: boolean }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "status"; status: string }
  | { type: "done" };

// ---------------------------------------------------------------------------
// Agent class
// ---------------------------------------------------------------------------

/**
 * A CodePilot agent instance. Create with `Agent.create()`, interact with
 * via `prompt()` or `stream()`, and clean up with `dispose()`.
 */
export class Agent {
  readonly session: Session;
  private disposed = false;

  private constructor(session: Session) {
    this.session = session;
  }

  /**
   * Create a new agent instance. Loads config, initializes the session,
   * and returns a ready-to-use Agent.
   */
  static async create(opts: AgentCreateOptions = {}): Promise<Agent> {
    const cwd = opts.cwd ?? process.cwd();

    // Load config (or use explicit only).
    let config: CodepilotConfig;
    if (opts.noConfigFiles) {
      config = opts.config ?? {};
    } else {
      config = await loadConfig(cwd);
      if (opts.config) {
        config = { ...config, ...opts.config };
      }
    }

    // Build the session.
    const sessionId = opts.sessionId ?? randomUUID();
    const model = opts.model ?? config.model ?? "claude-sonnet-4-5";

    // Provider: real or replay.
    const provider = opts.replay ? new ReplayProvider(opts.replay) : undefined;

    const session = new Session(sessionId, {
      cwd,
      config,
      model,
      agentMode: opts.agentMode,
      hostSurface: "cli",
      onPermissionRequest: opts.onPermissionRequest ?? defaultPermissionHandler,
      onAskUser: opts.onAskUser,
      provider: provider,
    });

    await session.init();
    return new Agent(session);
  }

  /**
   * Send a prompt and wait for the agent to finish. Returns the final
   * assistant text plus usage/tool-call stats.
   */
  async prompt(text: string, images?: ImageAttachment[]): Promise<AgentResult> {
    if (this.disposed) throw new Error("agent disposed");

    let finalText = "";
    let hadErrors = false;
    let toolCallCount = 0;
    const events: Event[] = [];

    const unsub = this.session.subscribe((e: Event) => {
      events.push(e);
      if (e.type === "message" && e.role === "assistant") {
        for (const b of e.content) {
          if (b.type === "text") finalText += b.text;
        }
      }
      if (e.type === "tool_call") toolCallCount++;
      if (e.type === "error") hadErrors = true;
    });

    try {
      await this.session.prompt(text, images);
    } finally {
      unsub();
    }

    const usage = this.session.getUsage();
    return {
      text: finalText,
      hadErrors,
      toolCallCount,
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        costUSD: usage.costUSD,
      },
      sessionId: this.session.id,
    };
  }

  /**
   * Stream events as they happen. Yields `StreamEvent`s until the agent
   * finishes, then yields `{ type: "done" }`.
   */
  async *stream(text: string, images?: ImageAttachment[]): AsyncGenerator<StreamEvent> {
    if (this.disposed) throw new Error("agent disposed");

    const queue: StreamEvent[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;

    const unsub = this.session.subscribe((e: Event) => {
      switch (e.type) {
        case "message":
          if (e.role === "assistant") {
            for (const b of e.content) {
              if (b.type === "text" && b.text) {
                queue.push({ type: "text", text: b.text });
              }
            }
          }
          break;
        case "tool_call":
          queue.push({ type: "tool_call", name: e.name, input: e.input });
          break;
        case "tool_result":
          queue.push({ type: "tool_result", name: e.name, content: e.content, isError: e.isError ?? false });
          break;
        case "error":
          queue.push({ type: "error", message: e.message, recoverable: e.recoverable ?? false });
          break;
        case "status":
          queue.push({ type: "status", status: e.status });
          break;
      }
      if (resolveWait) { resolveWait(); resolveWait = null; }
    });

    // Start the prompt in the background.
    const promptPromise = this.session.prompt(text, images);
    promptPromise.then(() => {
      done = true;
      if (resolveWait) { resolveWait(); resolveWait = null; }
    }).catch(() => {
      done = true;
      if (resolveWait) { resolveWait(); resolveWait = null; }
    });

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { resolveWait = resolve; });
        }
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      }
      yield { type: "done" };
    } finally {
      unsub();
    }
  }

  /** Get the session id (for resuming later). */
  get id(): string {
    return this.session.id;
  }

  /** Clean up the agent. Always call this when done. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.session.dispose();
  }
}

// ---------------------------------------------------------------------------
// One-shot run() function
// ---------------------------------------------------------------------------

/** Options for the one-shot `run()` function. */
export interface RunOptions extends AgentCreateOptions {
  /** The prompt to send. */
  prompt: string;
  /** Optional images to attach. */
  images?: ImageAttachment[];
}

/**
 * One-shot: create an agent, send a prompt, return the result, and dispose.
 * Convenient for scripts and CI pipelines.
 *
 *   import { run } from "@codepilot/sdk";
 *   const { text } = await run({ cwd: ".", prompt: "fix lint errors" });
 */
export async function run(opts: RunOptions): Promise<AgentResult> {
  const { prompt, images, ...createOpts } = opts;
  const agent = await Agent.create(createOpts);
  try {
    return await agent.prompt(prompt, images);
  } finally {
    await agent.dispose();
  }
}

// ---------------------------------------------------------------------------
// Default permission handler (yolo — auto-approve everything for CI)
// ---------------------------------------------------------------------------

function defaultPermissionHandler(_req: PermissionRequest): Promise<PermissionDecision> {
  // In SDK mode (no handler provided), auto-approve all tool calls.
  // This is the "yolo" default suitable for CI/automation. For interactive
  // use, callers should provide their own onPermissionRequest handler.
  return Promise.resolve("allow" as PermissionDecision);
}
