import { describe, expect, it } from "vitest";
import {
  CORE_VERSION,
  linkIdForEvent,
  stampEventMeta,
} from "../src/eventMeta.js";
import type { Event } from "../src/types.js";
import { compactTranscriptToProviderMessages } from "../src/agent-messages.js";
import { renderMarkdownTranscript } from "../src/session-utils.js";

describe("eventMeta", () => {
  it("stamps cwd / parent / version onto events", () => {
    const e: Event = {
      type: "message",
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    const stamped = stampEventMeta(e, {
      cwd: "/tmp/proj",
      gitBranch: "main",
      parentId: "prev",
      now: 1_700_000_000_000,
    });
    expect(stamped.cwd).toBe("/tmp/proj");
    expect(stamped.gitBranch).toBe("main");
    expect(stamped.parentId).toBe("prev");
    expect(stamped.ts).toBe(1_700_000_000_000);
    expect(stamped.version).toBe(CORE_VERSION);
    expect(linkIdForEvent(stamped)).toBe("m1");
  });

  it("does not re-send reasoning blocks to the provider", () => {
    const events: Event[] = [
      {
        type: "message",
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "why?" }],
      },
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "secret chain of thought" },
          { type: "text", text: "because" },
        ],
      },
    ];
    const msgs = compactTranscriptToProviderMessages(events, "");
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const texts = (assistant!.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text);
    expect(texts).toEqual(["because"]);
    expect(JSON.stringify(msgs)).not.toContain("secret chain of thought");
  });

  it("export markdown includes thinking and request timing", () => {
    const events: Event[] = [
      {
        type: "message",
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "go" }],
        cwd: "/repo",
        gitBranch: "feat",
        version: "9.9.9",
        ts: 1_700_000_000_000,
      },
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "plan first" },
          { type: "text", text: "done" },
        ],
        model: "test-model",
        ts: 1_700_000_000_100,
      },
      {
        type: "request",
        startedAt: 1_700_000_000_050,
        finishedAt: 1_700_000_000_200,
        durationMs: 150,
        ttftMs: 20,
        model: "test-model",
        inputTokens: 10,
        outputTokens: 5,
        ok: true,
        ts: 1_700_000_000_200,
      },
    ];
    const md = renderMarkdownTranscript(events, "sess-1");
    expect(md).toContain("cwd: `/repo`");
    expect(md).toContain("branch: `feat`");
    expect(md).toContain("<details><summary>Thinking</summary>");
    expect(md).toContain("plan first");
    expect(md).toContain("_request (test-model):");
    expect(md).toContain("ttft=20ms");
  });
});
