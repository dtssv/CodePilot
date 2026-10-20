import { describe, expect, it } from "vitest";

import { PrettyRenderer, prettyOutput } from "../src/cli-render.js";

function capture() {
  let out = "";
  const r = new PrettyRenderer({ write: (s: string) => (out += s) });
 // biome-ignore lint/suspicious/noControlCharactersInRegex: strip color codes
  return { r, text: () => out.replace(/\u001b\[[0-9;]*m/g, ""), raw: () => out };
}

describe("PrettyRenderer", () => {
  it("replaces the running placeholder with the finished step", () => {
    const { r, text, raw } = capture();
    r.render({ type: "tool_call", id: "t1", name: "read_file", input: { path: "README.md" } });
    r.render({ type: "tool_result", toolCallId: "t1", name: "read_file", content: "# hi" });
    expect(text()).toContain("● Reading README.md");
    expect(text()).toContain("\r\u001b[2K  ✓ Read README.md\n");
    expect(raw()).toContain("\u001b[38;2;63;185;127m✓");
  });

  it("does not overwrite unrelated output and shows errors", () => {
    const { r, text } = capture();
    r.render({ type: "tool_call", id: "a", name: "bash", input: { command: "npm test" } });
    r.render({ type: "tool_call", id: "b", name: "grep", input: { pattern: "x" } });
    r.render({ type: "tool_result", toolCallId: "a", name: "bash", content: "\nboom happened\n", isError: true });
    expect(text()).not.toContain("\r");
    expect(text()).toContain("  ✗ Ran npm test\n");
    expect(text()).toContain("│ boom happened");
  });

  it("prefixes streamed text once and skips the final duplicate", () => {
    const { r, text } = capture();
    r.render({ type: "message_delta", messageId: "m", delta: { type: "text", text: "Hel" } });
    r.render({ type: "message_delta", messageId: "m", delta: { type: "text", text: "lo" } });
    r.render({ type: "message", id: "m", role: "assistant", content: [{ type: "text", text: "Hello" }] });
    expect(text()).toBe("\n◆ Hello");
  });

  it("renders retries and hides plan_update", () => {
    const { r, text } = capture();
    r.render({ type: "tool_call", id: "p", name: "plan_update", input: {} });
    r.render({ type: "tool_result", toolCallId: "p", name: "plan_update", content: "ok" });
    r.render({ type: "retry", attempt: 1, maxAttempts: 3, delayMs: 1500, reason: "ECONNRESET" });
    expect(text()).toBe("↻ Retrying (1/3) in 1.5s · ECONNRESET\n");
  });

  it("streams reasoning under a one-time header, then the answer on its own line", () => {
    const { r, text } = capture();
    r.render({ type: "message_delta", messageId: "m", delta: { type: "reasoning", text: "Let me " } });
    r.render({ type: "message_delta", messageId: "m", delta: { type: "reasoning", text: "think." } });
    r.render({ type: "message_delta", messageId: "m", delta: { type: "text", text: "Answer" } });
    r.render({ type: "message", id: "m", role: "assistant", content: [{ type: "text", text: "Answer" }] });
    expect(text()).toBe("\n· thinking\nLet me think.\n\n◆ Answer");
  });
});

describe("prettyOutput", () => {
  it("is on for terminals and off for pipes or NO_COLOR", () => {
    expect(prettyOutput({ isTTY: true } as NodeJS.WriteStream, {})).toBe(true);
    expect(prettyOutput({ isTTY: false } as NodeJS.WriteStream, {})).toBe(false);
    expect(prettyOutput({ isTTY: true } as NodeJS.WriteStream, { NO_COLOR: "1" })).toBe(false);
    expect(prettyOutput({ isTTY: false } as NodeJS.WriteStream, { FORCE_COLOR: "1" })).toBe(true);
  });
});
