// Sub-agent runner: a thin wrapper around `runAgent` that runs with a fresh
// transcript, a restricted tool set, and returns only the final text.

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
      const smallProvider = buildProvider(opts.config, opts.config.smallModel ?? model);
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
      const sys = await buildSystemPrompt({
        cwd,
        memory,
        toolNames: restricted.names(),
        extra: undefined,
        model: model ?? opts.model,
        provider: opts.config.provider ?? "anthropic",
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
          { type: "text", text: `OBJECTIVE:\n${objective}\n\nReturn a concise conclusion when done.` },
        ],
      };
      // Prepend the initial event as history so runAgent doesn't double-emit it.
      await runAgent(
        { history: [initial], userText: objective },
        deps
      );
      void smallProvider;
      const finalText = extractFinalText(events);
      return { conclusion: finalText, steps: countSteps(events) };
    },
  };
}

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
