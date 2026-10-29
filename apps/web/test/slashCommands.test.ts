import { describe, it, expect, vi } from "vitest";
import { parseSlash, interpretSlash } from "../src/state/slashCommands.js";
import type { Codepilot } from "../src/state/useCodepilot.js";

function mockCp(over: Partial<Codepilot> = {}): Codepilot {
  return {
    state: { sessionId: "s1", agentMode: "agent", cwd: "/w" } as never,
    client: {
      sessionCompact: vi.fn(async () => ({ ok: true })),
      sessionClearContext: vi.fn(async () => ({ cleared: true })),
      undoSession: vi.fn(async () => ({ label: "x", restored: [], deleted: [] })),
      redoSession: vi.fn(async () => ({ label: "x", restored: [], deleted: [] })),
    } as never,
    setMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    ...over,
  } as never;
}

describe("parseSlash", () => {
  it("parses name + args", () => {
    expect(parseSlash("/plan add tests")).toEqual({ name: "plan", args: "add tests" });
    expect(parseSlash("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("/")).toBeNull();
  });
});

describe("interpretSlash — local-first semantics", () => {
  it("/plan with no args switches mode and does NOT forward to the model", async () => {
    const cp = mockCp();
    const out = await interpretSlash("/plan", cp);
    expect(out.handled).toBe(true);
    expect(out.forward).toBeUndefined();
    expect(cp.setMode).toHaveBeenCalledWith("plan");
  });

  it("/plan <text> switches mode AND forwards the text", async () => {
    const cp = mockCp();
    const out = await interpretSlash("/plan refactor the parser", cp);
    expect(out.handled).toBe(true);
    expect(out.forward).toBe("refactor the parser");
    expect(cp.setMode).toHaveBeenCalledWith("plan");
  });

  it("/compact runs a local compaction, no forward", async () => {
    const cp = mockCp();
    const out = await interpretSlash("/compact", cp);
    expect(out.handled).toBe(true);
    expect(out.forward).toBeUndefined();
    expect((cp.client as never as { sessionCompact: ReturnType<typeof vi.fn> }).sessionCompact).toHaveBeenCalledWith("s1");
  });

  it("/clear archives context locally, no forward", async () => {
    const cp = mockCp();
    const out = await interpretSlash("/clear", cp);
    expect(out.handled).toBe(true);
    expect((cp.client as never as { sessionClearContext: ReturnType<typeof vi.fn> }).sessionClearContext).toHaveBeenCalled();
  });

  it("an unknown command is NOT handled locally (flows to the model/server)", async () => {
    const cp = mockCp();
    const out = await interpretSlash("/my-custom-prompt do a thing", cp);
    expect(out.handled).toBe(false);
  });

  it("plain text is never treated as a command", async () => {
    const cp = mockCp();
    const out = await interpretSlash("just a normal message", cp);
    expect(out.handled).toBe(false);
  });
});
