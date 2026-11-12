// Agent runtime abstraction. The agent loop is one `AgentRuntime` implementation
// resolved through a registry. `DefaultRuntime` wraps `runAgent`; plugins may
// register custom runtimes. Factories get a {@link RuntimeToolkit} so custom
// runtimes run tools through the same pipeline (permissions, hooks, validation).

import { runAgent } from "./agent.js";
import type { AgentDeps, AgentRunInput, AgentRunResult } from "./agent.js";
import { runOneTool, type ToolExecResult } from "./agent-tools.js";
import { DoomLoopDetector } from "./doomLoop.js";
import { filterToolNames } from "./tools/modes.js";
import { redactSecrets } from "./redact.js";
import type { AgentMode, DoomLoopConfig, Event, ToolUseBlock } from "./types.js";

/** Lifecycle state of a runtime instance. */
export type AgentRuntimeState = "idle" | "running" | "waiting_permission";

/**
 * A tool a plugin runtime can contribute, described in ABI-safe terms
 * (no `@codepilot/core` types). `parameters` is a JSON Schema object, NOT
 * Zod — the plugin module can't import Zod from the core copy.
 */
export interface PluginToolDef {
  /** Unique, namespaced tool name (e.g. "myplugin_fetch"). */
  name: string;
  description: string;
  /** JSON Schema for the tool input (object schema recommended). */
  parameters: Record<string, unknown>;
  /**
   * Permission tier, gating the call like a built-in tool. Defaults to
   * "execute" when omitted (the safe, prompt-by-default tier).
   */
  permission?: "read" | "write" | "execute" | "network";
  /** Run the tool. Returns plain text content (+ optional error flag). */
  execute(
    input: unknown,
    ctx: { cwd: string; signal?: AbortSignal },
  ): Promise<{ content: string; isError?: boolean }>;
}

/**
 * A provider message as seen by a plugin context transform — the plain data
 * shape of the model's view (role + content blocks). ABI-safe; mirrors the
 * core `ProviderMessage` so the two stay assignable.
 */
export interface PluginContextMessage {
  role: "user" | "assistant" | "system";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
    | { type: "image"; mediaType: string; base64: string }
  >;
}

/**
 * A plugin context transform: given a COPY of the model's message view, return
 * the view to send. Runs after fold/compaction. Fail-soft on any problem.
 */
export type PluginContextTransform = (
  view: PluginContextMessage[],
) => PluginContextMessage[];

/**
 * Additive sink mirroring the session JSONL event log to an external source.
 * JSONL stays the source of truth; the host bounds `write` so a slow/throwing
 * sink can never block the canonical write.
 */
export interface PluginEventSink {
  /** Mirror one already-persisted JSONL line (no trailing newline). */
  write(sessionId: string, line: string): Promise<void> | void;
  /** Optional: flush any buffered writes (best-effort). */
  flush?(sessionId: string): Promise<void> | void;
  /** Optional: release resources when the session disposes. */
  close?(): Promise<void> | void;
}

/**
 * A pluggable agent runtime. Drives one prompt to completion, emitting
 * session events via `deps.onEvent` so persistence/subscribers/protocol
 * keep working unchanged.
 */
export interface AgentRuntime {
 /** Unique runtime name (e.g. "default"). */
  readonly name: string;
 /** Run a single prompt to completion. */
  prompt(input: AgentRunInput, deps: AgentDeps): Promise<AgentRunResult>;
 /**
 * Optional streaming variant. When present, hosts may consume events
 * incrementally; the default implementation yields from `deps.onEvent`.
 */
  stream?(input: AgentRunInput, deps: AgentDeps): AsyncIterable<Event>;
 /** Cancel the current run (best-effort; no-op when idle). */
  cancel(): void;
 /** Current runtime state. */
  state(): AgentRuntimeState;
}

/**
 * Host-provided primitives handed to every runtime factory. A plugin runtime
 * can't import `@codepilot/core`; this toolkit exposes everything a runtime
 * needs from the core.
 */
export interface RuntimeToolkit {
 /** ABI version, bumped when a member changes shape. */
  readonly version: 4;
 /**
  * Register a tool the model can call. Executed through the same pipeline
  * as built-in tools (permission check, hooks, Zod validation, telemetry).
  * No-op on a bare toolkit; throwing registrations are swallowed (fail-soft).
  */
  registerTool(def: PluginToolDef): void;
 /**
  * Install a context transform applied to a COPY of the model's message view
  * before each provider request (after fold/compaction). Fail-soft; replaces
  * any previous transform. No-op on a bare toolkit.
  */
  setContextTransform(transform: PluginContextTransform): void;
 /**
  * Register an additive event sink mirroring the session JSONL log to an
  * external source. Replaces the previous sink. No-op on a bare toolkit.
  */
  registerEventSink(sink: PluginEventSink): void;
 /** Run the built-in agent loop — the behaviour of `DefaultRuntime`. */
  runDefault(input: AgentRunInput, deps: AgentDeps): Promise<AgentRunResult>;
 /**
  * Execute one tool call through the built-in pipeline (mode gating,
  * doom-loop, permission, hooks, validation, telemetry). Returned content is
  * NOT redacted; call {@link redactToolOutput} if persisting output yourself.
  */
  runTool(
    call: ToolUseBlock,
    deps: AgentDeps,
    emit: (e: Event) => Promise<void>,
    mode?: AgentMode,
  ): Promise<ToolExecResult>;
 /** Names of the tools the model would see in the given mode. */
  visibleTools(deps: AgentDeps, mode: AgentMode): string[];
 /** Strip credentials from text before it reaches the transcript. */
  redactToolOutput(text: string): string;
}

/**
 * Options for {@link createRuntimeToolkit}. The host (a `Session`) passes a
 * `registerTool` registrar bound to its own tool registry; when absent,
 * `toolkit.registerTool` is a safe no-op.
 */
export interface RuntimeToolkitOptions {
  /** Adapt + add a plugin tool to the session's registry. Fail-soft. */
  registerTool?: (def: PluginToolDef) => void;
  /** Install the session's context transform. Fail-soft. */
  setContextTransform?: (transform: PluginContextTransform) => void;
  /** Register the session's additive event sink. Fail-soft. */
  registerEventSink?: (sink: PluginEventSink) => void;
  /** Loop-detection thresholds + exclusions for the toolkit's shared detector.
   * Unset = built-in constants. */
  doomLoop?: DoomLoopConfig;
}

/** Build a {@link RuntimeToolkit} bound to the core implementation. */
export function createRuntimeToolkit(opts: RuntimeToolkitOptions = {}): RuntimeToolkit {
  // Toolkit is long-lived (one per runtime), so it owns a single
  // DoomLoopDetector persisting across `runTool` calls. A per-call detector
  // never trips; sharing one gives toolkit callers the doom-loop refusal /
  // idempotent-dedup the default loop (agent.ts) provides.
  const doomLoop = new DoomLoopDetector(undefined, opts.doomLoop);
  return {
    version: 4,
    registerTool: (def) => {
      if (!opts.registerTool) return; // bare toolkit (e.g. test) → no-op
      try {
        opts.registerTool(def);
      } catch (err) {
        // Fail-soft: a bad registration must never break the session.
        process.stderr.write(
          `[runtime] plugin tool "${def?.name ?? "?"}" registration failed: ${
            (err as Error).message
          }\n`,
        );
      }
    },
    setContextTransform: (transform) => {
      if (!opts.setContextTransform) return; // bare toolkit → no-op
      try {
        opts.setContextTransform(transform);
      } catch (err) {
        // Fail-soft: a bad install must never break the session.
        process.stderr.write(
          `[runtime] context transform install failed: ${(err as Error).message}\n`,
        );
      }
    },
    registerEventSink: (sink) => {
      if (!opts.registerEventSink) return; // bare toolkit → no-op
      try {
        opts.registerEventSink(sink);
      } catch (err) {
        // Fail-soft: a bad registration must never break the session.
        process.stderr.write(
          `[runtime] event sink registration failed: ${(err as Error).message}\n`,
        );
      }
    },
    runDefault: (input, deps) => runAgent(input, deps),
    runTool: (call, deps, emit, mode = "agent") =>
      runOneTool(call, deps, emit, mode, doomLoop),
    visibleTools: (deps, mode) => filterToolNames(deps.tools.all(), mode),
    redactToolOutput: (text) => redactSecrets(text),
  };
}

/** Dependencies a factory may use when constructing a runtime instance. */
export interface RuntimeFactoryDeps {
  cwd: string;
 /** Core primitives (default loop + hook-aware tool execution). */
  toolkit: RuntimeToolkit;
}

/**
 * Options for {@link RuntimeRegistry.resolve}. The toolkit is optional and
 * defaulted by the registry.
 */
export interface RuntimeResolveOptions {
  cwd: string;
  toolkit?: RuntimeToolkit;
  /**
   * Registrar for plugin-contributed tools, bound to the caller's tool
   * registry. Used to build the default toolkit when `toolkit` is omitted.
   */
  registerTool?: (def: PluginToolDef) => void;
  /** Installer for the session's context transform. Used to build the
   * default toolkit when `toolkit` is omitted. */
  setContextTransform?: (transform: PluginContextTransform) => void;
  /** Registrar for the session's additive event sink. Used to build the
   * default toolkit when `toolkit` is omitted. */
  registerEventSink?: (sink: PluginEventSink) => void;
}

/** A named constructor for runtimes. Registered in the RuntimeRegistry. */
export interface RuntimeFactory {
  readonly name: string;
  create(deps: RuntimeFactoryDeps): AgentRuntime;
}

/**
 * The built-in runtime: wraps `runAgent` from agent.ts. `cancel` is a no-op —
 * cancellation flows through `deps.signal`, which the default loop honours.
 */
export class DefaultRuntime implements AgentRuntime {
  readonly name = "default";
  private currentState: AgentRuntimeState = "idle";

  async prompt(input: AgentRunInput, deps: AgentDeps): Promise<AgentRunResult> {
    if (this.currentState === "running") {
      throw new Error("DefaultRuntime: prompt() called while a run is active");
    }
    this.currentState = "running";
    try {
      return await runAgent(input, deps);
    } finally {
      this.currentState = "idle";
    }
  }

  async *stream(input: AgentRunInput, deps: AgentDeps): AsyncIterable<Event> {
    const queue: Event[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let failure: unknown = null;
    const wrappedDeps: AgentDeps = {
      ...deps,
      onEvent: async (e) => {
        queue.push(e);
        wake?.();
        await deps.onEvent?.(e);
      },
    };
    const run = this.prompt(input, wrappedDeps).then(
      () => { done = true; wake?.(); },
      (err) => { failure = err; done = true; wake?.(); },
    );
    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (done) break;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = null;
      }
      if (failure) throw failure;
    } finally {
      await run.catch(() => undefined);
    }
  }

  cancel(): void {
 // Cancellation is driven by deps.signal; nothing to do here.
  }

  state(): AgentRuntimeState {
    return this.currentState;
  }
}

/** Registry of named runtime factories. */
export class RuntimeRegistry {
  private factories = new Map<string, RuntimeFactory>();

  register(factory: RuntimeFactory): void {
    this.factories.set(factory.name, factory);
  }

  unregister(name: string): boolean {
    if (name === DEFAULT_RUNTIME_NAME) return false; // default is irremovable
    return this.factories.delete(name);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  get(name: string): RuntimeFactory | undefined {
    return this.factories.get(name);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }

 /**
 * Resolve a runtime by name, falling back to default when `name` is
 * undefined. Throws for an unknown explicit name (no silent degrade to
 * the default loop).
 */
  resolve(name: string | undefined, opts: RuntimeResolveOptions): AgentRuntime {
    const effective = name ?? DEFAULT_RUNTIME_NAME;
    const factory = this.factories.get(effective);
    if (!factory) {
      throw new Error(`Unknown agent runtime: "${effective}" (registered: ${this.list().join(", ")})`);
    }
    return factory.create({
      cwd: opts.cwd,
      toolkit:
        opts.toolkit ??
        createRuntimeToolkit({
          registerTool: opts.registerTool,
          setContextTransform: opts.setContextTransform,
          registerEventSink: opts.registerEventSink,
        }),
    });
  }
}

export const DEFAULT_RUNTIME_NAME = "default";

/** Process-wide registry. The default factory is pre-registered. */
export const runtimeRegistry = new RuntimeRegistry();

runtimeRegistry.register({
  name: DEFAULT_RUNTIME_NAME,
  create: () => new DefaultRuntime(),
});
