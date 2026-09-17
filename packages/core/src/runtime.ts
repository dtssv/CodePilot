// Agent runtime abstraction (ROADMAP-NEXT §4.1).
//
// "Everything is a Plugin" starts here: the agent loop is no longer a
// hardcoded function call — it is one implementation of the `AgentRuntime`
// interface, resolved through a registry. Phase 1 shipped the interface, the
// registry, and `DefaultRuntime` (a thin wrapper around `runAgent()`), with
// NO change to any public API: sessions that never touch the registry behave
// exactly as before.
//
// Phase 2: plugin manifests may declare a `runtime` module whose factory is
// registered here (see `loadPluginRuntimes` in plugins.ts); `Session` then
// resolves the runtime by name.
//
// Phase 4: every factory receives a {@link RuntimeToolkit} so a custom
// runtime can delegate to the built-in loop and — crucially — execute tools
// through the same pipeline the default loop uses (permissions, PreToolUse /
// PostToolUse hooks, doom-loop detection, Zod validation, telemetry). A
// runtime that calls `tool.execute()` directly would silently bypass all of
// that, so the toolkit is the supported way to run tools.

import { runAgent } from "./agent.js";
import type { AgentDeps, AgentRunInput, AgentRunResult } from "./agent.js";
import { runOneTool, type ToolExecResult } from "./agent-tools.js";
import { filterToolNames } from "./tools/modes.js";
import { redactSecrets } from "./redact.js";
import type { AgentMode, Event, ToolUseBlock } from "./types.js";

/** Lifecycle state of a runtime instance. */
export type AgentRuntimeState = "idle" | "running" | "waiting_permission";

/**
 * A pluggable agent runtime. Implementations drive one prompt to completion
 * (model streaming + tool execution), emitting session events through
 * `deps.onEvent` exactly like the default loop does, so persistence,
 * subscribers, and the protocol layer keep working unchanged.
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
 * Host-provided primitives handed to every runtime factory.
 *
 * A plugin runtime lives in its own module and must not import
 * `@codepilot/core` (it would resolve to a different copy, or not resolve at
 * all from `~/.codepilot/plugins/`). The toolkit closes that gap: everything
 * a runtime needs from the core is reachable through this object.
 */
export interface RuntimeToolkit {
  /** ABI version, bumped when a member changes shape. */
  readonly version: 1;
  /** Run the built-in agent loop — the behaviour of `DefaultRuntime`. */
  runDefault(input: AgentRunInput, deps: AgentDeps): Promise<AgentRunResult>;
  /**
   * Execute one tool call through the built-in pipeline: mode gating,
   * doom-loop detection, permission check, PreToolUse/PostToolUse hooks,
   * Zod validation of the input, and telemetry spans.
   *
   * `emit` receives the status/permission events the pipeline produces and
   * should forward them to `deps.onEvent` (or a runtime-local collector).
   * Note that the returned content is NOT secret-redacted; the default loop
   * redacts it before it reaches the transcript, so a runtime that persists
   * tool output itself should call {@link redactToolOutput}.
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

/** Build a {@link RuntimeToolkit} bound to the core implementation. */
export function createRuntimeToolkit(): RuntimeToolkit {
  return {
    version: 1,
    runDefault: (input, deps) => runAgent(input, deps),
    runTool: (call, deps, emit, mode = "agent") =>
      runOneTool(call, deps, emit, mode),
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
 * What a host passes to {@link RuntimeRegistry.resolve}. The toolkit is
 * optional here and defaulted by the registry, so hosts (and tests) can keep
 * calling `resolve(name, { cwd })`.
 */
export interface RuntimeResolveOptions {
  cwd: string;
  toolkit?: RuntimeToolkit;
}

/** A named constructor for runtimes. Registered in the RuntimeRegistry. */
export interface RuntimeFactory {
  readonly name: string;
  create(deps: RuntimeFactoryDeps): AgentRuntime;
}

/**
 * The built-in runtime: wraps `runAgent()` from agent.ts. Tracks state so
 * hosts can introspect; `cancel()` is a no-op because cancellation flows
 * through `deps.signal` (the session's AbortController), which the default
 * loop already honours.
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
   * Resolve a runtime by name, falling back to the default runtime when
   * `name` is undefined. Throws for an unknown explicit name — a plugin
   * declaring a runtime that failed to load must not silently degrade to
   * the default loop.
   */
  resolve(name: string | undefined, opts: RuntimeResolveOptions): AgentRuntime {
    const effective = name ?? DEFAULT_RUNTIME_NAME;
    const factory = this.factories.get(effective);
    if (!factory) {
      throw new Error(`Unknown agent runtime: "${effective}" (registered: ${this.list().join(", ")})`);
    }
    return factory.create({
      cwd: opts.cwd,
      toolkit: opts.toolkit ?? createRuntimeToolkit(),
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
