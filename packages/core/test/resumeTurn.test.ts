// Resume-from-breakpoint: after a turn ends in a recoverable error, a user
// "retry" must re-enter the agent on the EXISTING transcript — not send a new
// user message. These tests pin that contract at the Session boundary.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";
import type { Event } from "../src/types.js";

function userTexts(events: Event[]): string[] {
  return events
    .filter((e): e is Extract<Event, { type: "message" }> => e.type === "message" && e.role === "user")
    .map((e) => e.content.find((b) => b.type === "text" && "text" in b)?.text ?? "");
}

describe("Session.resumeLastTurn", () => {
  let dir: string;
  let session: Session;

  afterEach(async () => {
    await session?.dispose().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeSession(provider: ChatProvider, id: string): Session {
    return new Session(id, {
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
      provider,
      pluginRuntimes: false,
    });
  }

  it("re-enters the agent WITHOUT a new user message after an error", async () => {
    dir = mkdtempSync(join(tmpdir(), "resume-"));
    let streamCalls = 0;
    const provider: ChatProvider = {
      name: "mock",
      defaultModel: "mock",
      smallModel: "mock",
      async *stream(): AsyncIterable<StreamEvent> {
        streamCalls += 1;
        if (streamCalls === 1) {
          // First turn fails mid-stream (recoverable).
          yield { kind: "error", message: "boom (first attempt)" };
          return;
        }
        // Resumed turn succeeds.
        yield { kind: "text_delta", messageId: "m2", text: "recovered" };
        yield { kind: "done", finishReason: "stop" };
      },
    };

    session = makeSession(provider, `resume_${Date.now()}`);
    await session.init();
    await session.setTitle("resume-test"); // skip small-model title fetch

    const events: Event[] = [];
    session.subscribe((e) => events.push(e));

    await session.prompt("do the thing");
    expect(streamCalls).toBe(1);
    // The last turn ended in an error → resumable.
    expect(session.canResumeLastTurn()).toBe(true);
    expect(userTexts(events)).toEqual(["do the thing"]);

    const result = await session.resumeLastTurn();
    expect(result).toBe("started");
    // The provider was called a SECOND time — the turn actually resumed.
    expect(streamCalls).toBe(2);
    // Crucially, NO second user bubble was emitted. The one and only user
    // message is still the original prompt.
    expect(userTexts(events)).toEqual(["do the thing"]);
    // The resumed turn's text made it into the transcript.
    expect(
      events.some(
        (e) =>
          e.type === "message" &&
          e.role === "assistant" &&
          e.content.some((b) => b.type === "text" && b.text.includes("recovered")),
      ),
    ).toBe(true);
  });

  it("is a no-op when the last turn did not end in an error", async () => {
    dir = mkdtempSync(join(tmpdir(), "resume-ok-"));
    let streamCalls = 0;
    const provider: ChatProvider = {
      name: "mock",
      defaultModel: "mock",
      smallModel: "mock",
      async *stream(): AsyncIterable<StreamEvent> {
        streamCalls += 1;
        yield { kind: "text_delta", messageId: `m${streamCalls}`, text: "ok" };
        yield { kind: "done", finishReason: "stop" };
      },
    };
    session = makeSession(provider, `resume_ok_${Date.now()}`);
    await session.init();
    await session.setTitle("resume-ok");
    await session.prompt("finish cleanly");
    expect(streamCalls).toBe(1);
    expect(session.canResumeLastTurn()).toBe(false);
    expect(await session.resumeLastTurn()).toBe("noop");
    // No extra provider call for a no-op resume.
    expect(streamCalls).toBe(1);
  });

  it("is a no-op with no prior user prompt", async () => {
    dir = mkdtempSync(join(tmpdir(), "resume-empty-"));
    const provider: ChatProvider = {
      name: "mock",
      defaultModel: "mock",
      smallModel: "mock",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { kind: "done", finishReason: "stop" };
      },
    };
    session = makeSession(provider, `resume_empty_${Date.now()}`);
    await session.init();
    expect(session.canResumeLastTurn()).toBe(false);
    expect(await session.resumeLastTurn()).toBe("noop");
  });
});
