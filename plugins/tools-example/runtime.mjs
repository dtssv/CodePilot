// Reference implementation of a plugin that CONTRIBUTES A TOOL the model can
// call — the single most central extension mechanism of an agent harness.
//
// How it works (and the three rules a tool plugin must follow):
//
// 1. Export a RuntimeFactory. Default export (or a named `factory` /
//    `runtimeFactory` export) with `{ name, create(deps) }`. `deps.toolkit`
//    is the ABI boundary — the only sanctioned way to reach the core.
//
// 2. Register tools during `create`, before the first prompt. Call
//    `deps.toolkit.registerTool(def)` with an ABI-safe description:
//    `name`, `description`, `parameters` (a JSON Schema object — NOT Zod,
//    which this module cannot import from the core copy), an optional
//    `permission` tier, and an async `execute(input, { cwd, signal })`.
//    The core adapts it into a real registry entry, so the model sees the
//    tool and every call flows through the normal permission +
//    PreToolUse/PostToolUse pipeline like a built-in tool.
//
// 3. Never import @codepilot/core. This file is loaded from wherever the
//    plugin was installed, so the core is not resolvable here. Everything
//    you need arrives through `deps.toolkit`.
//
// This plugin registers one tool (`reverse_text`) and otherwise delegates the
// whole turn to the built-in loop, so it changes nothing else about the agent.

export default {
  name: "tools-example",
  create(deps) {
    // Register the tool once, up front. A throwing registration is swallowed
    // by the toolkit (fail-soft), so a bad tool never breaks the session.
    deps.toolkit.registerTool({
      name: "reverse_text",
      description:
        "Reverse the characters of the given text. A tiny, side-effect-free " +
        "example of a plugin-contributed tool.",
      permission: "read",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to reverse." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(input) {
        const text = typeof input?.text === "string" ? input.text : "";
        return { content: [...text].reverse().join("") };
      },
    });

    // Delegate everything else to the built-in loop unchanged.
    return {
      name: "tools-example",
      async prompt(input, runDeps) {
        return deps.toolkit.runDefault(input, runDeps);
      },
      cancel() {},
      state() {
        return "idle";
      },
    };
  },
};
