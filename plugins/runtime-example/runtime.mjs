// Reference implementation of a plugin-provided agent runtime.
// See docs/RUNTIME.md and ROADMAP-NEXT §4.1.
//
// What it does: before the model's first turn, it lists the working directory
// through the `ls` tool and injects the result as context, then hands the
// prompt to the built-in loop. Small on purpose — the point is to show the
// three things every plugin runtime needs to get right.
//
//   1. Export a RuntimeFactory. Default export (or a named `factory` /
//      `runtimeFactory` export) with `{ name, create(deps) }`.
//   2. Never import @codepilot/core. This file is loaded from wherever the
//      plugin was installed, so core is not resolvable. Everything you need
//      arrives as `deps.toolkit`.
//   3. Run tools through `toolkit.runTool`, never `tool.execute` directly.
//      runTool is what applies permissions, PreToolUse/PostToolUse hooks,
//      doom-loop detection, and input validation. Bypassing it means a user
//      who blocked a tool with a hook would find it running anyway.

const PRIMER_TOOL = "ls";

class PrimerRuntime {
  name = "primer";
  #toolkit;
  #state = "idle";

  constructor(toolkit) {
    this.#toolkit = toolkit;
  }

  async prompt(input, deps) {
    this.#state = "running";
    try {
      const events = [];
      const emit = async (event) => {
        events.push(event);
        await deps.onEvent?.(event);
      };

      // Phase 1: prime. A failed listing is not fatal — the run just
      // proceeds without the extra context.
      let primer = "";
      const listing = await this.#toolkit.runTool(
        { id: `primer_${Date.now()}`, name: PRIMER_TOOL, input: { path: "." } },
        deps,
        emit,
        deps.agentMode ?? "agent",
      );
      if (!listing.isError) {
        primer = this.#toolkit.redactToolOutput(listing.content).slice(0, 4000);
      }

      // Phase 2: delegate. Appending to `dynamicSuffix` keeps the cached
      // static prefix intact, so prompt caching still works.
      const runDeps = primer
        ? {
            ...deps,
            systemPrompt: appendSuffix(
              deps.systemPrompt,
              `<workspace_listing>\n${primer}\n</workspace_listing>`,
            ),
          }
        : deps;
      const result = await this.#toolkit.runDefault(input, runDeps);
      return { ...result, events: [...events, ...result.events] };
    } finally {
      this.#state = "idle";
    }
  }

  cancel() {
    // Cancellation arrives through deps.signal, which the built-in loop honours.
  }

  state() {
    return this.#state;
  }
}

function appendSuffix(prompt, extra) {
  if (!prompt) return { staticPrefix: "", dynamicSuffix: extra, full: extra };
  return {
    staticPrefix: prompt.staticPrefix,
    dynamicSuffix: [prompt.dynamicSuffix, extra].filter(Boolean).join("\n\n"),
    full: [prompt.full, extra].filter(Boolean).join("\n\n"),
  };
}

export default {
  name: "primer",
  create: (deps) => new PrimerRuntime(deps.toolkit),
};
