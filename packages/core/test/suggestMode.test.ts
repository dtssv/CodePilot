// suggest_mode: model-proposed mode switch with user confirmation + auto-accept.

import { describe, it, expect, vi } from "vitest";
import { suggestModeTool } from "../src/tools/suggest_mode.js";
import type { ToolContext } from "../src/tools/types.js";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: "/w",
    artifact: async () => "a",
    readArtifact: async () => "",
    ...over,
  } as ToolContext;
}

/** Parse the mode_request block the agent loop consumes. */
function modeRequest(blocks: Array<{ type: string; text: string }> | undefined) {
  const b = blocks?.find((x) => x.type === "text");
  return b ? (JSON.parse(b.text) as { type: string; mode?: string; rememberAuto?: boolean }) : null;
}

describe("suggest_mode", () => {
  it("no-ops when already in the target mode", async () => {
    const tool = { ...suggestModeTool, currentMode: () => "plan" as const };
    const r = await tool.execute({ mode: "plan", reason: "x" }, ctx());
    expect(r.content).toMatch(/Already in plan/);
    expect(r.blocks).toBeUndefined();
  });

  it("headless (no ask channel) auto-accepts and emits a mode_request", async () => {
    const tool = { ...suggestModeTool, currentMode: () => "agent" as const };
    const r = await tool.execute({ mode: "plan", reason: "big task" }, ctx());
    const mr = modeRequest(r.blocks);
    expect(mr?.type).toBe("mode_request");
    expect(mr?.mode).toBe("plan");
  });

  it("auto-accept preference switches without asking", async () => {
    const ask = vi.fn();
    const tool = {
      ...suggestModeTool,
      currentMode: () => "agent" as const,
      autoAccept: () => true,
    };
    const r = await tool.execute({ mode: "plan", reason: "r" }, ctx({ askUser: ask }));
    expect(ask).not.toHaveBeenCalled();
    expect(modeRequest(r.blocks)?.mode).toBe("plan");
  });

  it("user 'Switch' → mode_request; 'Stay' → no switch", async () => {
    const base = { ...suggestModeTool, currentMode: () => "agent" as const };
    const switched = await base.execute(
      { mode: "plan", reason: "r" },
      ctx({ askUser: async () => ({ switch: "Switch" }) }),
    );
    expect(modeRequest(switched.blocks)?.mode).toBe("plan");

    const stayed = await base.execute(
      { mode: "plan", reason: "r" },
      ctx({ askUser: async () => ({ switch: "Stay" }) }),
    );
    expect(stayed.blocks).toBeUndefined();
    expect(stayed.content).toMatch(/declined|staying/i);
  });

  it("'Always switch' carries rememberAuto", async () => {
    const tool = { ...suggestModeTool, currentMode: () => "agent" as const };
    const r = await tool.execute(
      { mode: "plan", reason: "r" },
      ctx({ askUser: async () => ({ switch: "Always switch" }) }),
    );
    const mr = modeRequest(r.blocks);
    expect(mr?.mode).toBe("plan");
    expect(mr?.rememberAuto).toBe(true);
  });
});
