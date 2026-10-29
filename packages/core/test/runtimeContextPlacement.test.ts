import { describe, expect, it } from "vitest";
import { streamOnce } from "../src/agent-messages.js";
import { buildOpenAIMessages } from "../src/providers/openai.js";
import type { ChatProvider, ProviderMessage, StreamChatOptions } from "../src/providers/types.js";
import type { AgentDeps } from "../src/agent.js";

function captureProvider(): { provider: ChatProvider; sent: () => ProviderMessage[] } {
  let sent: ProviderMessage[] = [];
  const provider = {
    defaultModel: "m",
    smallModel: "m",
    // biome-ignore lint/correctness/useYield: mock provider only captures messages
    async *stream(opts: StreamChatOptions) {
      sent = opts.messages;
    },
  } as unknown as ChatProvider;
  return { provider, sent: () => sent };
}

const deps = {
  config: { model: "m" },
  systemPrompt: {
    staticPrefix: "static",
    dynamicSuffix: "<env>cwd</env>",
    stableContext: "<env>cwd</env>",
    volatileSuffix: "<runtime>now: t</runtime>",
    full: "",
  },
} as unknown as AgentDeps;

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) void _;
}

describe("runtime_context placement", () => {
  it("is emitted as its own system-role message placed BEFORE the user turn", async () => {
    const { provider, sent } = captureProvider();
    const messages: ProviderMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    await drain(streamOnce(provider, deps, messages, [], "x"));
    const out = sent();
    // Runtime context comes first, as its own system message.
    expect(out[0]!.role).toBe("system");
    expect(out[0]!.content[0]!.type === "text" ? out[0]!.content[0]!.text : "").toContain("<runtime_context>");
    expect(out[0]!.content[0]!.type === "text" ? out[0]!.content[0]!.text : "").toContain("now: t");
    // The user's actual request stays LAST (strongest-attention position) and untouched.
    const last = out[out.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toHaveLength(1);
    expect(last.content[0]!.type === "text" ? last.content[0]!.text : "").toBe("hi");
  });

  it("does not emit two consecutive system messages through the OpenAI adapter (sub-agent first turn)", async () => {
    // A sub-agent's first turn: history is just the user objective, so the
    // runtime_context system message lands at position 0 — then the OpenAI
    // adapter prepends the big systemPrompt as its own system message. Two
    // back-to-back `system` messages make GLM-5.2 return invalid_argument.
    const { provider, sent } = captureProvider();
    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "OBJECTIVE: review the repo" }] },
    ];
    await drain(streamOnce(provider, deps, messages, [], "x"));
    const oai = buildOpenAIMessages("BIG SYSTEM PROMPT", sent()) as Array<{
      role: string;
      content: unknown;
    }>;
    // No two adjacent system messages anywhere.
    for (let i = 1; i < oai.length; i++) {
      expect(oai[i]!.role === "system" && oai[i - 1]!.role === "system").toBe(false);
    }
    // The merged first system carries both the prompt and the runtime_context.
    expect(oai[0]!.role).toBe("system");
    expect(String(oai[0]!.content)).toContain("BIG SYSTEM PROMPT");
    expect(String(oai[0]!.content)).toContain("<runtime_context>");
    // The user objective is still present and last.
    expect(oai[oai.length - 1]!.role).toBe("user");
  });

  it("never splits an assistant tool_use from its tool_result (OpenAI/GLM invalid_argument guard)", async () => {
    const { provider, sent } = captureProvider();
    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "ask me a question" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ask_user_question", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "t1", content: "A: Li Si" }] },
    ];
    await drain(streamOnce(provider, deps, messages, [], "x"));
    const out = sent();
    // The runtime_context system message must land BEFORE the assistant
    // tool_use turn — never between assistant(tool_use) and its tool_result,
    // which OpenAI-compatible backends (e.g. GLM-5.2) reject as invalid_argument.
    const sysIdx = out.findIndex(
      (m) =>
        m.role === "system" &&
        m.content[0]?.type === "text" &&
        (m.content[0] as { text: string }).text.includes("<runtime_context>"),
    );
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    // Assert no system message sits immediately after an assistant tool_use and
    // immediately before its tool_result anywhere in the sequence.
    for (let i = 1; i < out.length - 1; i++) {
      const prev = out[i - 1]!;
      const cur = out[i]!;
      const next = out[i + 1]!;
      const prevHasToolUse =
        prev.role === "assistant" && prev.content.some((c) => c.type === "tool_use");
      const nextHasToolResult =
        next.role === "user" && next.content.some((c) => c.type === "tool_result");
      if (cur.role === "system" && prevHasToolUse && nextHasToolResult) {
        throw new Error(`runtime_context split a tool_use/tool_result pair at index ${i}`);
      }
    }
    // The tool_result turn is last and untouched.
    const last = out[out.length - 1]!;
    const block = last.content[0]!;
    expect(block.type).toBe("tool_result");
    expect(block.type === "tool_result" ? block.content : "").toBe("A: Li Si");
    // And the assistant tool_use turn immediately precedes its tool_result.
    expect(out[out.length - 2]!.role).toBe("assistant");
    expect(out[out.length - 2]!.content.some((c) => c.type === "tool_use")).toBe(true);
  });

  it("places runtime_context before a trailing assistant(tool_use)+tool_result pair, keeping the pair adjacent", async () => {
    const { provider, sent } = captureProvider();
    // Mirrors the failing GLM-5.2 turn: a continuation where the transcript
    // tail is assistant(tool_calls) → tool_result(s), with the user prompt
    // earlier. The system note must not break the pair.
    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "analyze the repo" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
          { type: "tool_use", id: "t2", name: "bash", input: { command: "git log" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "t1", content: "contents of a" },
          { type: "tool_result", toolCallId: "t2", content: "commit log" },
        ],
      },
    ];
    await drain(streamOnce(provider, deps, messages, [], "x"));
    const out = sent();
    // assistant(tool_use) is immediately followed by its tool_result turn.
    const aIdx = out.findIndex(
      (m) => m.role === "assistant" && m.content.some((c) => c.type === "tool_use"),
    );
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(out[aIdx + 1]!.role).toBe("user");
    expect(out[aIdx + 1]!.content.some((c) => c.type === "tool_result")).toBe(true);
    // The system note sits BEFORE the assistant turn.
    expect(out[aIdx - 1]!.role).toBe("system");
    expect(
      out[aIdx - 1]!.content[0]?.type === "text" &&
        (out[aIdx - 1]!.content[0] as { text: string }).text.includes("<runtime_context>"),
    ).toBe(true);
  });

  it("demotes a mid-conversation system (runtime_context) to user so GLM-5.2 accepts it", async () => {
    // The exact shape of real failing request id 7627: a continuation turn
    // where runtime_context lands between the opening user and the assistant
    // tool_calls turn. Pre-adapter that is `user, system, assistant, tool_res`;
    // the OpenAI adapter used to emit `system(prompt), user, system(runtime),
    // assistant, tool, tool`, and GLM-5.2 rejects the mid-conversation system
    // with invalid_argument. The adapter must demote that system to user and
    // merge it into the adjacent user message.
    const { provider, sent } = captureProvider();
    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "分析仓库" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: { command: "git log" } },
          { type: "tool_use", id: "t2", name: "ls", input: { path: "/x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "t1", content: "log" },
          { type: "tool_result", toolCallId: "t2", content: "ls" },
        ],
      },
    ];
    await drain(streamOnce(provider, deps, messages, [], "x"));
    // Pre-adapter, runtime_context is still a mid-conversation system message.
    expect(sent().some((m) => m.role === "system")).toBe(true);
    const oai = buildOpenAIMessages("BIG SYSTEM", sent()) as Array<{ role: string; content: unknown }>;
    // After the adapter: only the leading systemPrompt stays `system`; no system
    // message appears after the conversation has started.
    const firstNonSystem = oai.findIndex((m) => m.role !== "system");
    expect(firstNonSystem).toBeGreaterThanOrEqual(0);
    for (let i = firstNonSystem; i < oai.length; i++) {
      expect(oai[i]!.role).not.toBe("system");
    }
    // The runtime_context content survives, folded into the (merged) user turn.
    const userMsg = oai.find((m) => m.role === "user");
    expect(JSON.stringify(userMsg!.content)).toContain("<runtime_context>");
    // No two consecutive user messages either (the demoted system merged in).
    for (let i = 1; i < oai.length; i++) {
      expect(oai[i]!.role === "user" && oai[i - 1]!.role === "user").toBe(false);
    }
  });

  it("produces a valid OpenAI payload: every tool message immediately follows an assistant tool_calls turn", async () => {
    const { provider, sent } = captureProvider();
    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "analyze the repo" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
          { type: "tool_use", id: "t2", name: "bash", input: { command: "git log" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "t1", content: "contents of a" },
          { type: "tool_result", toolCallId: "t2", content: "commit log" },
        ],
      },
    ];
    await drain(streamOnce(provider, deps, messages, [], "x"));
    // Run the placed messages through the real OpenAI adapter.
    const oai = buildOpenAIMessages("SYS", sent()) as Array<{
      role: string;
      tool_calls?: unknown[];
    }>;
    // Every `tool` message must be immediately preceded by an assistant message
    // carrying tool_calls (OpenAI's hard rule; GLM-5.2 returns invalid_argument
    // otherwise). A `system` runtime_context between them is the bug we fixed.
    for (let i = 0; i < oai.length; i++) {
      if (oai[i]!.role !== "tool") continue;
      // Walk back over sibling tool messages to the assistant that issued them.
      let j = i - 1;
      while (j >= 0 && oai[j]!.role === "tool") j--;
      expect(j).toBeGreaterThanOrEqual(0);
      expect(oai[j]!.role).toBe("assistant");
      expect(Array.isArray(oai[j]!.tool_calls) && oai[j]!.tool_calls!.length > 0).toBe(true);
    }
  });
});
