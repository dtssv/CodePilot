import { describe, expect, it } from "vitest";
import {
  TOOL_INPUT_SPILL_CHARS,
  measureToolInputChars,
  truncateToolCallInput,
  spillToolCallInputForContext,
} from "../src/compaction/compaction.js";
import { compactTranscriptToProviderMessages } from "../src/agent/agent-messages.js";
import type { Event } from "../src/types.js";

describe("truncateToolCallInput", () => {
  it("leaves small inputs unchanged", () => {
    const input = { path: "/tmp/a.ts", content: "hello" };
    expect(truncateToolCallInput(input)).toEqual(input);
  });

  it("clips oversized content fields and keeps path", () => {
    const content = "HEAD" + "x".repeat(TOOL_INPUT_SPILL_CHARS) + "TAIL";
    const input = { path: "/tmp/big.py", content };
    const out = truncateToolCallInput(input) as { path: string; content: string };
    expect(out.path).toBe("/tmp/big.py");
    expect(out.content.startsWith("HEAD")).toBe(true);
    expect(out.content.endsWith("TAIL")).toBe(true);
    expect(out.content).toContain("chars omitted from tool input");
    expect(measureToolInputChars(out)).toBeLessThan(measureToolInputChars(input));
    expect(measureToolInputChars(out)).toBeLessThanOrEqual(TOOL_INPUT_SPILL_CHARS + 500);
  });

  it("is stable when applied twice", () => {
    const content = "a".repeat(TOOL_INPUT_SPILL_CHARS + 2_000);
    const once = truncateToolCallInput({ path: "f", content });
    const twice = truncateToolCallInput(once);
    expect(twice).toEqual(once);
  });

  it("mentions artifact ref when provided", () => {
    const content = "b".repeat(TOOL_INPUT_SPILL_CHARS + 1_000);
    const out = truncateToolCallInput(
      { content },
      { artifactRef: "art_abc" },
    ) as { content: string };
    expect(out.content).toContain("artifact art_abc");
    expect(out.content).toContain("read_artifact");
  });
});

describe("spillToolCallInputForContext", () => {
  it("spills full JSON above the threshold", async () => {
    const content = "c".repeat(TOOL_INPUT_SPILL_CHARS + 500);
    const input = { path: "x.py", content };
    let written = "";
    const r = await spillToolCallInputForContext(input, "write_file", async (body, hint) => {
      written = body;
      expect(hint).toContain("write_file");
      return "art_test_ref";
    });
    expect(r.spilled).toBe(true);
    expect(r.artifactRef).toBe("art_test_ref");
    expect(r.originalChars).toBe(measureToolInputChars(input));
    expect(JSON.parse(written)).toEqual(input);
    const view = r.input as { path: string; content: string };
    expect(view.path).toBe("x.py");
    expect(view.content).toContain("art_test_ref");
    expect(measureToolInputChars(r.input)).toBeLessThan(r.originalChars);
  });

  it("does not spill small inputs", async () => {
    const input = { path: "x.py", content: "tiny" };
    const r = await spillToolCallInputForContext(input, "write_file", async () => {
      throw new Error("should not write");
    });
    expect(r.spilled).toBe(false);
    expect(r.input).toEqual(input);
  });
});

describe("compactTranscriptToProviderMessages tool input bound", () => {
  it("sends sealed tool_use input verbatim (no mid-history rewrite)", () => {
    const content = "body-" + "z".repeat(TOOL_INPUT_SPILL_CHARS + 1_000);
    const sealed = { path: "/tmp/big.py", content };
    const events: Event[] = [
      {
        type: "message",
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "write it" }],
      },
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tc1",
            name: "write_file",
            input: sealed,
          },
        ],
      },
      {
        type: "tool_result",
        toolCallId: "tc1",
        name: "write_file",
        content: "wrote",
      },
    ];
    const msgs = compactTranscriptToProviderMessages(events, "write it");
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const use = assistant!.content.find((b) => b.type === "tool_use");
    expect(use?.type).toBe("tool_use");
    if (use?.type !== "tool_use") throw new Error("expected tool_use");
    // Must not re-truncate here — that rewrites the cached prefix.
    expect(use.input).toEqual(sealed);
  });

  it("keeps already-stubbed sealed inputs unchanged", () => {
    const stubbed = truncateToolCallInput({
      path: "/tmp/big.py",
      content: "z".repeat(TOOL_INPUT_SPILL_CHARS + 1_000),
    });
    const events: Event[] = [
      {
        type: "message",
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "write it" }],
      },
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc1", name: "write_file", input: stubbed },
        ],
      },
      {
        type: "tool_result",
        toolCallId: "tc1",
        name: "write_file",
        content: "wrote",
      },
    ];
    const msgs = compactTranscriptToProviderMessages(events, "write it");
    const use = msgs
      .find((m) => m.role === "assistant")!
      .content.find((b) => b.type === "tool_use");
    expect(use?.type).toBe("tool_use");
    if (use?.type !== "tool_use") throw new Error("expected tool_use");
    expect(use.input).toEqual(stubbed);
  });
});
