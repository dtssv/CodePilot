import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";
import type { Event } from "../src/types.js";

// A provider whose first token is deferred past a microtask, so the user
// message (surfaced by the session BEFORE runtime.prompt and its first model
// round-trip) is observably ordered ahead of any assistant output.
const deferredProvider: ChatProvider = {
  name: "mock",
  defaultModel: "mock",
  smallModel: "mock",
  async *stream(): AsyncIterable<StreamEvent> {
    await Promise.resolve();
    await Promise.resolve();
    yield { kind: "text_delta", messageId: "m", text: "hello" };
    yield { kind: "done", finishReason: "stop" };
  },
};

describe("user message is surfaced before the model responds", () => {
  let dir: string;
  let session: Session;

  afterEach(async () => {
    await session?.dispose().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function makeSession() {
    dir = mkdtempSync(join(tmpdir(), "echo-"));
    session = new Session(`test_echo_${Date.now()}`, {
      cwd: dir,
      config: {
        provider: "openai",
        model: "mock-model",
        apiKey: "x",
        permissionMode: "yolo",
        sandbox: { mode: "off" },
        autoCompact: false,
        maxRetries: 0,
        retryAbortOnDelayMs: 1,
        stopVerify: "off",
      },
      model: "mock-model",
      provider: deferredProvider,
      pluginRuntimes: false,
    });
    await session.init();
    // Skip the small-model title fetch, which would otherwise re-invoke the
    // provider and keep the turn pending under the test's deferred stream.
    await session.setTitle("echo-test");
    return session;
  }

  it("emits the user bubble before the first assistant token", async () => {
    const s = await makeSession();
    const order: string[] = [];
    s.subscribe((e: Event) => {
      if (e.type === "message" && e.role === "user") order.push("user");
      else if (e.type === "message_delta") order.push("assistant_delta");
      else if (e.type === "message" && e.role === "assistant") order.push("assistant");
    });
    await s.prompt("do the thing");
    // The user message must be the FIRST content event, ahead of any assistant
    // delta / message — it is surfaced before the model round-trip, not with it.
    expect(order[0]).toBe("user");
    const firstAssistant = order.findIndex((x) => x.startsWith("assistant"));
    expect(firstAssistant).toBeGreaterThan(0);
  });

  it("emits exactly one user message for a fresh prompt (no duplicate)", async () => {
    const s = await makeSession();
    const userMsgs: Event[] = [];
    s.subscribe((e: Event) => {
      if (e.type === "message" && e.role === "user") userMsgs.push(e);
    });
    await s.prompt("just once please");
    expect(userMsgs).toHaveLength(1);
    const content = userMsgs[0] as Extract<Event, { type: "message" }>;
    expect(content.content).toEqual([{ type: "text", text: "just once please" }]);
    // And it is persisted exactly once in the transcript the agent sees.
    const persisted = (s as unknown as { events: Event[] }).events.filter(
      (e) => e.type === "message" && e.role === "user",
    );
    expect(persisted).toHaveLength(1);
  });
});
