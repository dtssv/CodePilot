import { describe, expect, it } from "vitest";
import { streamOnce } from "../src/agent-messages.js";
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
  systemPrompt: { staticPrefix: "static", dynamicSuffix: "<env>cwd</env>", full: "" },
} as unknown as AgentDeps;

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) void _;
}

describe("runtime_context placement", () => {
  it("rides inside the last tool_result instead of adding a user text block", async () => {
    const { provider, sent } = captureProvider();
    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "ask me a question" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ask_user_question", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "t1", content: "A: Li Si" }] },
    ];
    await drain(streamOnce(provider, deps, messages, [], "x"));
    const last = sent()[sent().length - 1]!;
    expect(last.content).toHaveLength(1);
    const block = last.content[0]!;
    expect(block.type).toBe("tool_result");
    expect(block.type === "tool_result" ? block.content : "").toMatch(/A: Li Si[\s\S]*<runtime_context>/);
    expect(block.type === "tool_result" ? block.content : "").toMatch(/not a new user message/);
  });

  it("still appends to a real user prompt", async () => {
    const { provider, sent } = captureProvider();
    const messages: ProviderMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    await drain(streamOnce(provider, deps, messages, [], "x"));
    const last = sent()[0]!;
    expect(last.content).toHaveLength(2);
    expect(last.content[1]!.type === "text" ? last.content[1]!.text : "").toContain("<runtime_context>");
  });
});
