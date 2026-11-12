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

  it("emits the user bubble before preprocessing and the first assistant token", async () => {
    const s = await makeSession();
    const order: string[] = [];
    s.subscribe((e: Event) => {
      if (e.type === "message" && e.role === "user") order.push("user");
      // The `running` claim is appended only AFTER the per-turn preprocessing
      // (@mcp, image mentions, uploads, memory recall) completes, so seeing the
      // user bubble ahead of it proves the bubble is not blocked by that work.
      else if (e.type === "status" && e.status === "running") order.push("claim");
      else if (e.type === "message_delta") order.push("assistant_delta");
      else if (e.type === "message" && e.role === "assistant") order.push("assistant");
    });
    await s.prompt("do the thing");
    // The user bubble is the FIRST event — before the preprocessing claim and
    // any assistant output (it is surfaced the instant the prompt is accepted).
    expect(order[0]).toBe("user");
    const firstClaim = order.indexOf("claim");
    expect(firstClaim).toBeGreaterThan(0);
    const firstAssistant = order.findIndex((x) => x.startsWith("assistant"));
    expect(firstAssistant).toBeGreaterThan(firstClaim);
  });

  it("persists exactly one user message and upserts the bubble by id", async () => {
    const s = await makeSession();
    const userMsgs: Extract<Event, { type: "message" }>[] = [];
    s.subscribe((e: Event) => {
      if (e.type === "message" && e.role === "user") userMsgs.push(e);
    });
    await s.prompt("just once please");
    // The UI is notified twice for the SAME id — an instant placeholder, then
    // the authoritative event after preprocessing. Both carry the same message
    // id, so the live reducer upserts a single bubble in place (not a dup).
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(userMsgs.map((m) => m.id));
    expect(ids.size).toBe(1);
    const last = userMsgs[userMsgs.length - 1]!;
    expect(last.content).toEqual([{ type: "text", text: "just once please" }]);
    // Crucially, the transcript the agent sees + what gets persisted holds the
    // user message EXACTLY ONCE: the placeholder is notify-only (never pushed),
    // so the append-only JSONL stays single-line and replay yields no dup.
    const persisted = (s as unknown as { events: Event[] }).events.filter(
      (e) => e.type === "message" && e.role === "user",
    );
    expect(persisted).toHaveLength(1);
    expect((persisted[0] as Extract<Event, { type: "message" }>).id).toBe(last.id);
  });
});
