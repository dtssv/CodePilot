// Sub-agent runner: a thin wrapper around `runAgent` that runs with a fresh
// transcript, a restricted tool set, and returns only the final text.
//
// The sub-agent gets its own system prompt built on top of the shared
// `buildSystemPrompt` static prefix, with an additional block that bounds
// its scope: it is a focused worker, it does not own the user's task, and
// it returns a structured conclusion.

import { randomUUID } from "node:crypto";
import { runAgent, type AgentDeps } from "./agent.js";
import type { CodepilotConfig, Event } from "./types.js";
import { ToolRegistry } from "./tools/types.js";
import { ArtifactStore } from "./tools/artifacts.js";
import { PermissionEngine } from "./permissions.js";
import { AnthropicProvider, OpenAIProvider, CopilotProvider } from "./providers/index.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { readMemory, summariseMemory } from "./memory.js";
import type { SubagentRunner } from "./tools/task.js";
import type { ChatProvider } from "./providers/types.js";

/**
 * The block appended to a sub-agent's static prefix. It makes the role
 * boundary crisp so the sub-agent does not drift into doing the parent's
 * job, and it tells the sub-agent the exact shape of the conclusion it
 * must return.
 */
export const SUBAGENT_ROLE_BLOCK = `## Sub-Agent Role

You are a sub-agent invoked by a parent CodePilot agent via the \`task\` tool. You are NOT the user's assistant; the parent is. You are a focused, throwaway worker.

- **Scope.** The parent has delegated one bounded objective to you (in the user message of this turn). Do exactly that objective, no more, no less.
- **Do not address the user.** The user cannot see you. Never greet them, never ask them questions, never narrate progress. If essential information is missing, investigate with the tools available; if still blocked, return a blocker in your conclusion.
- **No nested sub-agents.** Do not call the \`task\` tool. You are already a sub-agent.
- **Default tool surface is read-only.** You have \`read_file\`, \`grep\`, \`glob\`, \`ls\`, \`read_artifact\` (and any others the parent explicitly listed). \`bash\`, \`write_file\`, \`edit_file\`, \`plan_update\`, and \`memory_write\` are NOT available unless the parent passed \`tools=[...]\` to widen the set. If the parent asks you to "fix" or "implement" something but did not give you the write tools, say so in your conclusion and stop.
- **Conclusion format.** End your work with a final assistant message that contains a structured conclusion. Use this exact format:

  ### Findings
  - <bullet 1 — what you discovered, with file:line references>
  - <bullet 2 — ...>

  ### Key references
  - \`path/to/file.ts:42\` — one-line purpose
  - \`path/to/other.ts:118-140\` — another purpose

  ### Recommendations
  - <concrete next step for the parent to take, or "none">

  If you could not complete the work, replace the sections above with:
  ### Blocker
  <one-sentence reason the work could not be completed>

- **Be terse.** The parent is paying for your tokens too. No preamble, no apology, no recap of the question. The structured conclusion is the entire output.`;

export interface SubagentFactoryOptions {
  cwd: string;
  config: CodepilotConfig;
  model: string;
  buildToolRegistry: () => ToolRegistry;
}

export function createSubagentRunner(
  opts: SubagentFactoryOptions
): SubagentRunner {
  return {
    async run({ objective, cwd, tools, model, maxSteps, onEvent }) {
      const provider = buildProvider(opts.config, model ?? opts.config.smallModel);
      const toolRegistry = opts.buildToolRegistry();
      // Optional restriction by tool name.
      let restricted = toolRegistry;
      if (tools && tools.length > 0) {
        restricted = new ToolRegistry();
        for (const n of tools) {
          const t = toolRegistry.get(n);
          if (t) restricted.register(t);
        }
      }
      const artifacts = new ArtifactStore(joinCodepilot(cwd, "artifacts"));
      await artifacts.init();
      const permissions = new PermissionEngine({
        permissionMode: "auto-edit", // sub-agents get a sensible default
        autoApprove: opts.config.autoApprove,
      });
      const memory = summariseMemory(await readMemory(cwd));
      // Sub-agents always run in "agent" mode (the chat/plan restrictions
      // would be over-restrictive for a delegated worker, and the tool
      // surface itself is already mode-filtered upstream by `task` callers).
      // We still pass the parent's `extra` so project notes propagate.
      const sys = await buildSystemPrompt({
        cwd,
        memory,
        toolNames: restricted.names(),
        extra: SUBAGENT_ROLE_BLOCK,
        model: model ?? opts.model,
        provider: opts.config.provider ?? "anthropic",
        mode: "agent",
      });

      const events: Event[] = [];
      const deps: AgentDeps = {
        provider,
        tools: restricted,
        artifacts,
        permissions,
        config: { ...opts.config, model: model ?? opts.config.smallModel },
        cwd,
        systemPrompt: sys,
        maxTurns: maxSteps ?? 15,
        onEvent: async (e) => {
          events.push(e);
          if (onEvent) onEvent(e);
        },
        onPermissionRequest: undefined, // auto-edit mode handles most things
      };

      const userMessageId = `msg_${randomUUID()}`;
      const initial: Event = {
        type: "message",
        id: userMessageId,
        role: "user",
        content: [
          { type: "text", text: `OBJECTIVE:\n${objective}\n\n${SUBAGENT_OBJECTIVE_FOOTER}` },
        ],
      };
      // Prepend the initial event as history so runAgent doesn't double-emit it.
      await runAgent(
        { history: [initial], userText: objective },
        deps
      );
      const finalText = extractFinalText(events);
      return { conclusion: finalText, steps: countSteps(events) };
    },
  };
}

/**
 * The footer injected into the sub-agent's user message. Reinforces the
 * role boundary right before the model starts reasoning.
 */
const SUBAGENT_OBJECTIVE_FOOTER = `This is your only task. When you are done, your final assistant message must follow the structured conclusion format described in your system prompt (### Findings / ### Key references / ### Recommendations, or ### Blocker if blocked). Do not produce any other output.`;

function extractFinalText(events: Event[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "assistant") {
      const text = e.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "(sub-agent produced no final text)";
}

function countSteps(events: Event[]): number {
  let n = 0;
  for (const e of events) if (e.type === "tool_call") n++;
  return n;
}

function joinCodepilot(cwd: string, sub: string): string {
  // Tiny helper; kept local to avoid a path import.
  return `${cwd}/.codepilot/${sub}`;
}

function buildProvider(config: CodepilotConfig, model: string | undefined): ChatProvider {
  const provider = config.provider ?? "anthropic";
  switch (provider) {
    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: model,
        smallModel: model,
      });
    case "copilot":
      return new CopilotProvider({});
    case "anthropic":
    default:
      return new AnthropicProvider({
        apiKey: config.apiKey,
        defaultModel: model,
        smallModel: model,
      });
  }
}
