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

function runtimeIdx(out: ProviderMessage[]): number {
  return out.findIndex(
    (m) =>
      m.role === "system" &&
      m.content[0]?.type === "text" &&
      (m.content[0] as { text: string }).text.includes("<runtime_context>"),
  );
}

describe("runtime_context placement", () => {
  it("is emitted as a trailing system-role message AFTER the user turn (cache-stable prefix)", async () => {
    const { provider, sent } = captureProvider();
    const messages: ProviderMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    await drain(streamOnce(provider, deps, messages, [], "x"));
    const out = sent();
    // History first, harness nudge last — only the tail changes between turns,
    // so implicit prefix caches keep hitting on prior messages.
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.content[0]!.type === "text" ? out[0]!.content[0]!.text : "").toBe("hi");
    const last = out[out.length - 1]!;
    expect(last.role).toBe("system");
    expect(last.content[0]!.type === "text" ? last.content[0]!.text : "").toContain("<runtime_context>");
    expect(last.content[0]!.type === "text" ? last.content[0]!.text : "").toContain("now: t");
  });

  it("does not emit two consecutive system messages through the OpenAI adapter (sub-agent first turn)", async () => {
    // First turn: [user, system(runtime)]. Adapter prepends systemPrompt, demotes
    // the trailing runtime system to user, then merges adjacent users.
    const { provider, sent } = captureProvider();
    const messages: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "OBJECTIVE: review the repo" }] },
    ];
    await drain(streamOnce(provider, deps, messages, [], "x"));
    const oai = buildOpenAIMessages("BIG SYSTEM PROMPT", sent()) as Array<{
      role: string;
      content: unknown;
    }>;
    for (let i = 1; i < oai.length; i++) {
      expect(oai[i]!.role === "system" && oai[i - 1]!.role === "system").toBe(false);
    }
    expect(oai[0]!.role).toBe("system");
    expect(String(oai[0]!.content)).toContain("BIG SYSTEM PROMPT");
    // Runtime lands in the (merged) trailing user message after demotion.
    expect(oai[oai.length - 1]!.role).toBe("user");
    expect(JSON.stringify(oai[oai.length - 1]!.content)).toContain("<runtime_context>");
    expect(JSON.stringify(oai[oai.length - 1]!.content)).toContain("OBJECTIVE: review the repo");
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
    // Pair stays adjacent; runtime_context is appended after it.
    expect(out[out.length - 2]!.role).toBe("user");
    expect(out[out.length - 2]!.content.some((c) => c.type === "tool_result")).toBe(true);
    expect(out[out.length - 3]!.role).toBe("assistant");
    expect(out[out.length - 3]!.content.some((c) => c.type === "tool_use")).toBe(true);
    expect(runtimeIdx(out)).toBe(out.length - 1);
  });

  it("places runtime_context AFTER a trailing assistant(tool_use)+tool_result pair", async () => {
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
    const out = sent();
    const aIdx = out.findIndex(
      (m) => m.role === "assistant" && m.content.some((c) => c.type === "tool_use"),
    );
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(out[aIdx + 1]!.role).toBe("user");
    expect(out[aIdx + 1]!.content.some((c) => c.type === "tool_result")).toBe(true);
    // Tail append: runtime sits after the intact pair.
    expect(out[aIdx + 2]!.role).toBe("system");
    expect(
      out[aIdx + 2]!.content[0]?.type === "text" &&
        (out[aIdx + 2]!.content[0] as { text: string }).text.includes("<runtime_context>"),
    ).toBe(true);
  });

  it("demotes a trailing system (runtime_context) to user so GLM-5.2 accepts it", async () => {
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
    expect(sent().some((m) => m.role === "system")).toBe(true);
    const oai = buildOpenAIMessages("BIG SYSTEM", sent()) as Array<{ role: string; content: unknown }>;
    const firstNonSystem = oai.findIndex((m) => m.role !== "system");
    expect(firstNonSystem).toBeGreaterThanOrEqual(0);
    for (let i = firstNonSystem; i < oai.length; i++) {
      expect(oai[i]!.role).not.toBe("system");
    }
    // After tool messages, demoted runtime is a trailing user note — history
    // before it (user + assistant + tools) stays a stable cacheable prefix.
    expect(oai[oai.length - 1]!.role).toBe("user");
    expect(JSON.stringify(oai[oai.length - 1]!.content)).toContain("<runtime_context>");
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
    const oai = buildOpenAIMessages("SYS", sent()) as Array<{
      role: string;
      tool_calls?: unknown[];
    }>;
    for (let i = 0; i < oai.length; i++) {
      if (oai[i]!.role !== "tool") continue;
      let j = i - 1;
      while (j >= 0 && oai[j]!.role === "tool") j--;
      expect(j).toBeGreaterThanOrEqual(0);
      expect(oai[j]!.role).toBe("assistant");
      expect(Array.isArray(oai[j]!.tool_calls) && oai[j]!.tool_calls!.length > 0).toBe(true);
    }
  });
});
