/**
 * Shift+Tab collaboration-mode cycle.
 *
 * The TUI's Shift+Tab advances the collaboration mode through the same three
 * values the other clients expose as a mode switch (Agent / Plan / Ask). This
 * verifies the pure cycle helper covers every value and wraps around.
 */
import { describe, expect, it } from "vitest";
import type { AgentMode } from "@codepilot/core";
import { AGENT_MODE_CYCLE, nextAgentMode } from "../src/ui/state.js";

describe("nextAgentMode", () => {
  it("advances agent → plan → chat → agent", () => {
    expect(nextAgentMode("agent")).toBe("plan");
    expect(nextAgentMode("plan")).toBe("chat");
    expect(nextAgentMode("chat")).toBe("agent");
  });

  it("returns to the start after a full cycle", () => {
    let mode: AgentMode = "agent";
    for (let i = 0; i < AGENT_MODE_CYCLE.length; i++) mode = nextAgentMode(mode);
    expect(mode).toBe("agent");
  });

  it("covers every collaboration mode", () => {
    expect([...AGENT_MODE_CYCLE].sort()).toEqual(["agent", "chat", "plan"]);
  });
});
